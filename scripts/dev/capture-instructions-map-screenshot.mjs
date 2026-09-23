// Captures the Map view screenshot(s) used by the instructions page (client/src/pages/
// InstructionsPage.jsx, MapPanelDemo/MapToCardVisual), one per tour, into
// client/src/assets/instructions/map-view-<tourCode>.png.
//
// These are static images, not a live-rendered map — so anything that changes what the map
// actually looks like (marker color/shape, label styling, the zoom thresholds in MapView.jsx)
// makes the existing screenshots stale. Re-run this script after any such change, and after
// adding a new tour.
//
// Requires: local Postgres running with the tourz DB seeded, and both dev servers running
// (server on :3001, client on :5183 — override via SERVER_URL/CLIENT_URL env vars if different).
//
// Usage:
//   node scripts/dev/capture-instructions-map-screenshot.mjs                 (all tours)
//   node scripts/dev/capture-instructions-map-screenshot.mjs edinburgh       (one tour)
//   node scripts/dev/capture-instructions-map-screenshot.mjs edinburgh port-louis
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { Client } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'client', 'src', 'assets', 'instructions');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5183';
const CDP_PORT = 9357;
const CDP_USER_DATA_DIR = path.join(REPO_ROOT, '.tmp-capture-chrome-profile');

function send(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }));
}

async function captureOneTour(tourCode) {
  console.log(`\n=== ${tourCode} ===`);
  execFileSync('node', [path.join(__dirname, 'set-local-tour.js'), tourCode], { stdio: 'inherit' });

  const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  let nextId = 1;
  const pending = new Map();
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  function cmd(method, params = {}) {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send(ws, id, method, params);
    });
  }

  await cmd('Page.enable');
  await cmd('Runtime.enable');

  const loginRes = await (await fetch(`${SERVER_URL}/api/dev/login`, { method: 'POST' })).json();

  await cmd('Page.navigate', { url: CLIENT_URL });
  await new Promise((r) => setTimeout(r, 1200));
  await cmd('Runtime.evaluate', {
    expression: `localStorage.setItem('tourz.session', ${JSON.stringify(JSON.stringify(loginRes))})`,
  });
  await cmd('Page.navigate', { url: `${CLIENT_URL}/home` });
  await new Promise((r) => setTimeout(r, 1500));
  await cmd('Runtime.evaluate', {
    expression: `document.querySelector('[data-coach-id="home-map-view-btn"]').click()`,
  });
  await new Promise((r) => setTimeout(r, 2000));

  // Land on icons-without-labels: ICON_ZOOM_THRESHOLD <= zoom < LABEL_ZOOM_THRESHOLD (see
  // client/src/components/MapView.jsx). The map's starting zoom isn't stable across runs (it
  // depends on team/session state), so rather than a fixed number of wheel notches, first zoom
  // out to a known dots-only baseline, then zoom in one notch at a time until markers switch to
  // icons and stop the moment labels appear.
  const rectRes = await cmd('Runtime.evaluate', {
    expression: `JSON.stringify(document.querySelector('.map-container').getBoundingClientRect())`,
  });
  const rect = JSON.parse(rectRes.result.result.value);
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  async function counts() {
    const res = await cmd('Runtime.evaluate', {
      expression: `JSON.stringify({
        dotCount: document.querySelectorAll('.map-dot-site').length,
        pinCount: document.querySelectorAll('.map-pin-site').length,
        labelCount: document.querySelectorAll('.map-pin-label').length,
      })`,
    });
    return JSON.parse(res.result.result.value);
  }
  async function wheel(deltaY) {
    await cmd('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY });
    await new Promise((r) => setTimeout(r, 500));
  }

  for (let i = 0; i < 8; i++) await wheel(150); // zoom out to a guaranteed dots-only baseline
  await new Promise((r) => setTimeout(r, 800));

  let domCheck = await counts();
  for (let i = 0; i < 12 && !(domCheck.pinCount > 0 && domCheck.labelCount === 0); i++) {
    await wheel(-150); // zoom in one step
    domCheck = await counts();
  }
  console.log(`DOM check for ${tourCode}:`, domCheck);
  await new Promise((r) => setTimeout(r, 1500)); // let map tiles finish rendering

  // Real POI geography differs per tour, so a fixed arrow-start coordinate that looks right for
  // one tour (see MapToCardVisual in InstructionsPage.jsx) points at empty map for another. Find
  // the landmark pin and every POI marker here, in this tour's actual DOM screen coordinates —
  // the crop origin (below) is then chosen per tour so a real, visually distinct POI marker ends
  // up inside the visible frame whenever the surrounding geography allows it, rather than always
  // centering on the landmark and hoping one happens to fall inside a fixed window.
  const rawRes = await cmd('Runtime.evaluate', {
    expression: `JSON.stringify((() => {
      const toCenter = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      const landmarkEl = document.querySelector('.map-pin-landmark');
      if (!landmarkEl) return null;
      const landmark = toCenter(landmarkEl);
      // A POI marker can sit close enough to the landmark's real-world coordinates that its 26px
      // circle renders hidden behind the landmark's 40px one — visually indistinguishable, so an
      // arrow "pointing" at it there would look identical to the landmark arrow. Landmark radius
      // (20) + POI radius (13) + a few px margin excludes those, keeping only markers a viewer
      // could actually see as separate from the landmark.
      const MIN_VISUAL_SEPARATION = 40;
      const pois = Array.from(document.querySelectorAll('.map-pin-site'))
        .map(toCenter)
        .filter((p) => Math.hypot(p.x - landmark.x, p.y - landmark.y) > MIN_VISUAL_SEPARATION);
      return { landmark, pois };
    })())`,
  });
  const raw = JSON.parse(rawRes.result.result.value);

  // Crop a fixed 340x280 box (2x-scaled for sharpness) — the same native aspect ratio
  // client/src/index.css's .map-panel-demo-crop-top/-bottom20 rules and the MapToCardVisual
  // arrow-overlay SVG are hardcoded against, not the full (much taller) map viewport.
  // .map-panel-demo-crop-top only shows this image's top 120/280 (43%) slice, so both the
  // landmark and any POI the arrow overlay should point at need to land inside that band (with
  // margin for each marker's own radius, so neither renders clipped at the edge) — preferring the
  // landmark stay well up in the frame (~y 85) when nothing else constrains it.
  const CROP_W = 340, CROP_H = 280, TOP_SLICE_H = 120;
  const LANDMARK_MARGIN = 25; // landmark pin radius (20) + buffer
  const POI_MARGIN = 15; // POI marker radius (13) + buffer
  function boundsFor(point, margin, lo, hi) {
    return [point - (hi - margin), point - (lo + margin)]; // valid crop-origin range for this axis
  }
  function intersect([aLo, aHi], [bLo, bHi]) {
    const lo = Math.max(aLo, bLo), hi = Math.min(aHi, bHi);
    return lo <= hi ? [lo, hi] : null;
  }
  function clampToRange(preferred, [lo, hi]) {
    return Math.min(Math.max(preferred, lo), hi);
  }

  let cropOriginX = cx - 170;
  let cropOriginY = cy - 85;
  let chosenPoi = null;

  if (raw) {
    const landmarkXRange = boundsFor(raw.landmark.x, LANDMARK_MARGIN, 0, CROP_W);
    const landmarkYRange = boundsFor(raw.landmark.y, LANDMARK_MARGIN, 0, TOP_SLICE_H);
    const sorted = raw.pois
      .map((p) => ({ p, distSq: (p.x - raw.landmark.x) ** 2 + (p.y - raw.landmark.y) ** 2 }))
      .sort((a, b) => a.distSq - b.distSq)
      .map(({ p }) => p);

    for (const poi of sorted) {
      const xRange = intersect(landmarkXRange, boundsFor(poi.x, POI_MARGIN, 0, CROP_W));
      const yRange = intersect(landmarkYRange, boundsFor(poi.y, POI_MARGIN, 0, TOP_SLICE_H));
      if (!xRange || !yRange) continue; // no crop origin fits both markers in view for this candidate
      cropOriginX = clampToRange(raw.landmark.x - 170, xRange);
      cropOriginY = clampToRange(raw.landmark.y - 85, yRange);
      chosenPoi = poi;
      break; // nearest candidate that fits wins
    }
  }

  const shot = await cmd('Page.captureScreenshot', {
    format: 'png',
    clip: { x: cropOriginX, y: cropOriginY, width: CROP_W, height: CROP_H, scale: 2 },
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `map-view-${tourCode}.png`);
  fs.writeFileSync(outPath, Buffer.from(shot.result.data, 'base64'));
  console.log(`Wrote ${outPath}`);

  if (raw) {
    const toLocal = (p) => ({ x: Math.round(p.x - cropOriginX), y: Math.round(p.y - cropOriginY) });
    const meta = {
      landmark: toLocal(raw.landmark),
      poi: chosenPoi ? toLocal(chosenPoi) : null,
    };
    const metaPath = path.join(OUT_DIR, `map-view-${tourCode}.json`);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(`Wrote ${metaPath}:`, meta);
  } else {
    console.warn(`No landmark pin found for ${tourCode} — arrow overlay will fall back to defaults.`);
  }

  ws.close();
}

async function main() {
  const requested = process.argv.slice(2);

  let tourCodes = requested;
  if (tourCodes.length === 0) {
    const client = new Client({ host: 'localhost', port: 5432, user: 'postgres', database: 'tourz' });
    await client.connect();
    const { rows } = await client.query('SELECT tour_code FROM tours ORDER BY tour_code');
    await client.end();
    tourCodes = rows.map((r) => r.tour_code);
  }
  if (tourCodes.length === 0) {
    console.error('No tours found.');
    process.exit(1);
  }

  const chromeExecutables = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  const chromePath = chromeExecutables.find((p) => fs.existsSync(p));
  if (!chromePath) {
    console.error('Could not find chrome.exe in the usual install locations.');
    process.exit(1);
  }

  try {
    fs.rmSync(CDP_USER_DATA_DIR, { recursive: true, force: true });
  } catch {
    // Leftover from a prior run whose own cleanup didn't finish in time — fine to reuse/overwrite.
  }
  const { spawn } = await import('child_process');
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CDP_USER_DATA_DIR}`,
    '--window-size=430,932',
  ], { stdio: 'ignore', detached: true });

  try {
    // Wait for CDP to come up.
    for (let i = 0; i < 30; i++) {
      try {
        await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    for (const tourCode of tourCodes) {
      await captureOneTour(tourCode);
    }
  } finally {
    process.kill(chrome.pid);
    // Chrome can take a moment to release its profile-dir lock after the kill signal, so retry
    // the cleanup briefly rather than failing the whole run over a leftover temp directory.
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(CDP_USER_DATA_DIR, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
