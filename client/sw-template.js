/* TOURZ service worker — built into dist/sw.js by the tourz-service-worker plugin in
   vite.config.js, which fills in __BUILD_ID__ and __SHELL_FILES__ (every file of this build).
   Added 2026-10-18 so the app opens and plays with no signal (see client/src/offline/).

   - The app itself (HTML/JS/CSS/fonts/icons) is saved at install and served from the phone.
     Page loads try the network first for up to 3s (so a new deploy shows up straight away with
     signal), then fall back to the saved copy.
   - Tour photos and narration (/content-photos/, /content-audio/, on the API server's origin) and
     the OSM map's files (/map/ on this origin: the tour's .pmtiles, fonts, icons) are served from
     the 'tourz-content-v1' cache that offline/contentCache.js fills in the background.
     Narration needs HTTP Range support (audio elements ask for byte ranges), done here by slicing
     the saved file.
   - API calls are never touched — the app handles offline itself (offline/gameStore.js).
   - Anything else (Google Maps etc.) goes straight to the network as normal. */

const BUILD_ID = '__BUILD_ID__'
const SHELL_CACHE = `tourz-shell-${BUILD_ID}`
const CONTENT_CACHE = 'tourz-content-v1'
const SHELL_FILES = __SHELL_FILES__
const NAVIGATION_TIMEOUT_MS = 3000

// The type each saved file must come back as. During a Cloudflare rollout an edge can briefly
// answer a brand-new /assets/ file with the HTML page (its single-page-app fallback) — seen live on
// the 2026-10-18 V1.21 push. Saving that as the app's script would break the app on this phone until
// the next version, so any mismatch fails the whole install; the browser simply tries again later.
function expectedType(file) {
  if (file.endsWith('.js')) return 'javascript'
  if (file.endsWith('.css')) return 'css'
  if (file === '/' || file.endsWith('.html')) return 'html'
  return null
}

async function saveShell() {
  const cache = await caches.open(SHELL_CACHE)
  await Promise.all(SHELL_FILES.map(async (file) => {
    const res = await fetch(file, { cache: 'no-cache' })
    const type = res.headers.get('content-type') || ''
    const want = expectedType(file)
    if (!res.ok || (want && !type.includes(want)) || (!want && type.includes('text/html'))) {
      throw new Error(`${file}: ${res.status} ${type}`)
    }
    await cache.put(file, res)
  }))
}

self.addEventListener('install', (event) => {
  event.waitUntil(saveShell().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tourz-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

async function navigationResponse(request) {
  try {
    const res = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS)
    if (res.ok) return res
    throw new Error(`status ${res.status}`)
  } catch {
    const cache = await caches.open(SHELL_CACHE)
    return (await cache.match('/', { ignoreVary: true })) || Response.error()
  }
}

// ignoreVary: servers can answer with "Vary: Origin", and module scripts are requested with an
// Origin header while cache.addAll's install requests weren't — without it the saved copy never
// matches and the app opens blank with no signal (caught by the 2026-10-18 end-to-end test).
async function shellResponse(request) {
  const cache = await caches.open(SHELL_CACHE)
  const saved = await cache.match(request, { ignoreSearch: true, ignoreVary: true })
  return saved || fetch(request)
}

// A 206 slice of a saved file, for <audio>'s "Range: bytes=start-end" requests.
async function rangeResponse(saved, rangeHeader) {
  const blob = await saved.blob()
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
  const size = blob.size
  let start = match && match[1] ? Number(match[1]) : 0
  let end = match && match[2] ? Number(match[2]) : size - 1
  if (match && !match[1] && match[2]) { start = Math.max(0, size - Number(match[2])); end = size - 1 }
  if (start >= size || end < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  end = Math.min(end, size - 1)
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': saved.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  })
}

async function contentResponse(request) {
  const cache = await caches.open(CONTENT_CACHE)
  const saved = await cache.match(request.url, { ignoreVary: true })
  if (saved) {
    const range = request.headers.get('range')
    return range ? rangeResponse(saved, range) : saved
  }
  // Not saved yet (the background download hasn't reached it) — from the network as normal.
  return fetch(request)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.pathname.startsWith('/api/')) return
  if (/\/content-(photos|audio)\//.test(url.pathname) || (url.origin === self.location.origin && url.pathname.startsWith('/map/'))) {
    event.respondWith(contentResponse(request))
    return
  }
  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request))
    return
  }
  if (url.origin === self.location.origin) {
    event.respondWith(shellResponse(request))
  }
})
