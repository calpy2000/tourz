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

  // Crop a fixed 340x280 box (2x-scaled for sharpness) around the landmark pin — the same native
  // aspect ratio client/src/index.css's .map-panel-demo-crop-top/-bottom20 rules and the
  // MapToCardVisual arrow-overlay SVG are hardcoded against, not the full (much taller) map
  // viewport. .map-panel-demo-crop-top only shows this image's top 120/280 (43%) slice, so the
  // pin needs to land well up in the frame (image-local y ~85), not vertically centered — all
  // zooming above pivoted around (cx, cy), which is where the map keeps the landmark pin, so the
  // crop box's vertical offset is expressed relative to that.
  const cropOriginX = cx - 170;
  const cropOriginY = cy - 85;

  // Real POI geography differs per tour, so a fixed arrow-start coordinate that looks right for
  // one tour (see MapToCardVisual in InstructionsPage.jsx) points at empty map for another. Find
  // the landmark pin and its nearest POI marker here, in this tour's actual DOM, and record both
  // centers in crop-local coordinates so the page can draw arrows that always land on a real
  // marker regardless of tour.
  const markersRes = await cmd('Runtime.evaluate', {
    expression: `JSON.stringify((() => {
      const toCenter = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      const landmarkEl = document.querySelector('.map-pin-landmark');
      if (!landmarkEl) return null;
      const landmark = toCenter(landmarkEl);
      const pois = Array.from(document.querySelectorAll('.map-pin-site')).map(toCenter);
      if (pois.length === 0) return { landmark, poi: null };
      const poi = pois.reduce((nearest, p) => {
        const d = (p.x - landmark.x) ** 2 + (p.y - landmark.y) ** 2;
        const dn = (nearest.x - landmark.x) ** 2 + (nearest.y - landmark.y) ** 2;
        return d < dn ? p : nearest;
      });
      return { landmark, poi };
    })())`,
  });
  const markers = JSON.parse(markersRes.result.result.value);

  const shot = await cmd('Page.captureScreenshot', {
    format: 'png',
    clip: { x: cropOriginX, y: cropOriginY, width: 340, height: 280, scale: 2 },
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `map-view-${tourCode}.png`);
  fs.writeFileSync(outPath, Buffer.from(shot.result.data, 'base64'));
  console.log(`Wrote ${outPath}`);

  if (markers) {
    const toLocal = (p) => ({ x: Math.round(p.x - cropOriginX), y: Math.round(p.y - cropOriginY) });
    const meta = {
      landmark: toLocal(markers.landmark),
      poi: markers.poi ? toLocal(markers.poi) : null,
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
