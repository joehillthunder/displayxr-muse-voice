// Muse Voice 3D: the display page.
//
// Takes commands from the bridge (Muse, the mock CLI, an ESP32 dial) or from the keyboard, and
// turns each into one @displayxr/inline3d call. On the DisplayXR Browser with a 3D display the
// content is woven to glasses-free 3D; everywhere else addModel/addSplat render the same asset
// flat, so this page needs no 2D branch of its own.
//
// The stage follows docs/woven-canvas-rules.md in the SDK repo:
//   - one inline-3D session for the document (rule 1);
//   - never add*() twice on one canvas: a model<->splat change mounts a FRESH canvas, and
//     splat->splat goes through handle.setSource() on the canvas it has (rule 2);
//   - a fresh canvas gets its final box and will-change before registration, two frames before
//     add*() (rule 4), and stays under an opaque cover until handle.firstWoven (rule 5), hard cut;
//   - the old canvas is removed before the new one exists, never cross-faded (rule 6).

import { createInline3D, inline3dDisplayModesSupported } from '@displayxr/inline3d';
import { PROTOCOL_VERSION, validateCommand } from './protocol.js';

const DEPTH_RANGE_M = 0.08; // set_depth ±1 maps to ±8 cm of depthOffset
const DEFAULT_INVITE_BASE = 'https://joehillthunder.github.io/displayxr-muse-voice/';
const TILE_OPTS = { idleSpin: 10, feather: 24, renderScale: 0.6 };

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const cover = $('cover');
const splash = $('splash');
const callEl = $('call');
const badge = $('badge');
const logEl = $('log');

const params = new URLSearchParams(location.search);
const hash = new URLSearchParams(location.hash.slice(1));

// ── UI helpers ────────────────────────────────────────────────────────────────────────────

function setBadge(kind, text) {
  badge.className = `badge ${kind}`;
  $('badgeText').textContent = text;
}

function log(text, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  logEl.prepend(line);
  while (logEl.childElementCount > 80) logEl.lastChild.remove();
  console.log(`[muse-voice] ${text}`);
}

function showSplash(title, text) {
  $('splashTitle').textContent = title;
  $('splashText').textContent = text;
  splash.hidden = false;
}

// rAF does not run in a hidden tab; the timer keeps a backgrounded display from stalling.
const nextFrame = () =>
  new Promise((r) => {
    requestAnimationFrame(() => r());
    setTimeout(r, 100);
  });

// ── Session and catalog ───────────────────────────────────────────────────────────────────

const wall = await createInline3D({ lazy: false });
const modesSupported = wall.supported && inline3dDisplayModesSupported();
window.__wall = wall; // debug hook, same convention as the SDK samples

const catalog = await fetch(new URL('./assets/catalog.json', location.href))
  .then((r) => (r.ok ? r.json() : { models: {}, splats: {} }))
  .catch(() => ({ models: {}, splats: {} }));

function displayLabel() {
  if (!wall.supported) return '2D (no DisplayXR)';
  return wall.hardwareDisplayState ? `3D panel, ${wall.hardwareDisplayState}` : '3D panel';
}

function refreshBar() {
  $('dispState').textContent = displayLabel();
  $('contentState').textContent = call ? 'video call' : current ? current.label : 'nothing';
  $('depthState').textContent = depth.toFixed(2);
}

if (wall.supported) {
  wall.on?.('hardwaredisplaystatechange', (e) => {
    log(`panel reported ${e.state}`);
    refreshBar();
    sendStatus();
  });
}

/** name or url -> { url, label }. Names match catalog keys and aliases. */
function resolveSource(kind, args) {
  if (args.url) return { url: args.url, label: args.url.split('/').pop() || args.url };
  const table = kind === 'model' ? catalog.models : catalog.splats;
  const key = args.name.toLowerCase();
  for (const [name, entry] of Object.entries(table || {})) {
    if (name === key || (entry.aliases || []).includes(key)) {
      return { url: new URL(`./assets/${entry.file}`, location.href).href, label: entry.title || name };
    }
  }
  const known = Object.keys(table || {}).join(', ') || 'none';
  throw new Error(`no ${kind} called "${args.name}" (known: ${known})`);
}

// ── The stage ─────────────────────────────────────────────────────────────────────────────

let current = null; // { kind: 'model'|'splat', handle, canvas, label }
let call = null;
let depth = 0;
let wantStereo = true;

function teardown() {
  if (call) {
    try { call.leave(); } catch { /* already gone */ }
    call = null;
    callEl.replaceChildren();
    callEl.hidden = true;
  }
  if (current) {
    current.handle.remove();
    current.canvas.remove();
    current = null;
  }
}

function applyDepth() {
  const viewer = current?.handle?.viewer;
  if (viewer && 'depthOffset' in viewer) viewer.depthOffset = depth * DEPTH_RANGE_M;
}

async function mount(kind, url, label) {
  if (kind === 'splat' && current?.kind === 'splat' && current.handle.setSource) {
    // Same canvas, same window: the SDK's own swap (rule 2).
    await current.handle.setSource(url);
    current.label = label;
    applyDepth();
    return;
  }

  // A fresh canvas. Cover first, then drop the old window, so two woven canvases never coexist.
  cover.hidden = false;
  teardown();
  splash.hidden = true;

  const canvas = document.createElement('canvas');
  stage.prepend(canvas); // under the cover and the badge
  await nextFrame();
  await nextFrame();

  let handle;
  if (kind === 'model') {
    const { addModel } = await import('@displayxr/inline3d/model');
    handle = addModel(wall, canvas, url, TILE_OPTS);
  } else {
    const { addSplat } = await import('@displayxr/inline3d/splat');
    handle = addSplat(wall, canvas, url, { ...TILE_OPTS, engine: 'playcanvas' });
  }
  handle.exclude(badge);
  current = { kind, handle, canvas, label };

  try {
    await handle.ready;
  } catch (err) {
    teardown();
    cover.hidden = true;
    showSplash(`Could not load ${label}`, err?.message || String(err));
    throw err;
  }
  applyDepth();
  // The content is loaded, so the command can be acknowledged now. The cover stays until the
  // window is woven (up to the SDK's 1.2 s hold), unless another command replaced it meanwhile.
  const mounted = current;
  handle.firstWoven.then((woven) => {
    if (current !== mounted) return;
    cover.hidden = true; // hard cut, never a fade
    if (wall.supported && !woven.woven) log(`window not woven (${woven.reason}); showing it flat`, 'err');
  });
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────

const handlers = {
  async show_model(args) {
    const { url, label } = resolveSource('model', args);
    await mount('model', url, label);
    return `showing ${label}`;
  },

  async show_splat(args) {
    const { url, label } = resolveSource('splat', args);
    await mount('splat', url, label);
    return `showing ${label}`;
  },

  async set_mode({ mode }) {
    if (!modesSupported) {
      if (mode === '2d') return 'already 2D (no DisplayXR 3D display here)';
      throw new Error('no DisplayXR 3D display here, so the page stays 2D');
    }
    wantStereo = mode === '3d';
    await wall.setStereoEnabled(wantStereo); // eased; resolves once forwarded to the browser
    return `requested ${mode}`;
  },

  async start_call() {
    cover.hidden = true;
    teardown();
    splash.hidden = true;
    callEl.hidden = false;
    const { addCall } = await import('@displayxr/inline3d/call');
    const room = hash.get('room') || 'auto';
    call = await addCall(wall, callEl, { autoJoin: true, room });
    const base = params.get('invite_base') || DEFAULT_INVITE_BASE;
    const invite = call.room ? `${base}#room=${call.room}` : null;
    if (invite) log(`invite link: ${invite}`, 'ok');
    return invite ? `call started; invite: ${invite}` : 'call started';
  },

  async clear() {
    cover.hidden = true;
    teardown();
    showSplash('Cleared', 'Waiting for the next command.');
    return 'cleared';
  },

  async set_depth({ value }) {
    depth = value;
    applyDepth();
    return `depth ${value.toFixed(2)}`;
  },
};

// One command at a time: a show_model that arrives mid-load waits for the first to settle.
let queue = Promise.resolve();

function run(cmd, args = {}, origin = 'keyboard') {
  const result = queue.then(async () => {
    const problem = validateCommand(cmd, args);
    if (problem) throw new Error(problem);
    setBadge('wait', `${cmd.replace('_', ' ')}…`);
    const detail = await handlers[cmd](args);
    return detail;
  });
  queue = result.then(
    (detail) => {
      log(`${origin}: ${cmd} → ${detail}`, 'ok');
      setBadge('live', current?.label || (call ? 'video call' : 'ready'));
      refreshBar();
      sendStatus();
    },
    (err) => {
      log(`${origin}: ${cmd} failed: ${err?.message || err}`, 'err');
      setBadge('err', err?.message || String(err));
      refreshBar();
      sendStatus();
    },
  );
  return result;
}

// ── Mock mode: keyboard and the command box ──────────────────────────────────────────────

const modelNames = Object.keys(catalog.models || {});
const splatNames = Object.keys(catalog.splats || {});
let splatIdx = 0;

const KEYS = [
  ...modelNames.slice(0, 9).map((n, i) => [`${i + 1}`, `show_model ${n}`, () => run('show_model', { name: n })]),
  ['S', 'show_splat (next)', () => run('show_splat', { name: splatNames[splatIdx++ % splatNames.length] })],
  ['M', 'toggle 2D / 3D', () => run('set_mode', { mode: wantStereo ? '2d' : '3d' })],
  ['[ / ]', 'depth − / +', null],
  ['C', 'start_call', () => run('start_call')],
  ['X', 'clear', () => run('clear')],
];
$('keys').innerHTML = '';
for (const [key, what] of KEYS) {
  const row = document.createElement('div');
  row.innerHTML = `<kbd></kbd> <span></span>`;
  row.querySelector('kbd').textContent = key;
  row.querySelector('span').textContent = what;
  $('keys').append(row);
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === '[' || k === ']') {
    const v = Math.max(-1, Math.min(1, Math.round((depth + (k === ']' ? 0.1 : -0.1)) * 10) / 10));
    run('set_depth', { value: v }).catch(() => {});
    return;
  }
  if (k === 'escape') return void run('clear').catch(() => {});
  const hit = KEYS.find(([key, , fn]) => fn && key.toLowerCase() === k);
  if (hit) hit[2]().catch(() => {});
});

/** "show_model car" -> { cmd, args }. Same grammar as bridge/mock.js. */
function parseLine(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const args = {};
  for (const tok of rest) {
    const eq = tok.indexOf('=');
    if (eq > 0) {
      const k = tok.slice(0, eq);
      args[k] = k === 'value' ? Number(tok.slice(eq + 1)) : tok.slice(eq + 1);
    } else if (cmd === 'show_model' || cmd === 'show_splat') {
      args[/^https?:\/\//.test(tok) ? 'url' : 'name'] = tok;
    } else if (cmd === 'set_mode') {
      args.mode = tok.toLowerCase();
    } else if (cmd === 'set_depth') {
      args.value = Number(tok);
    }
  }
  return { cmd, args };
}

$('cmdForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const line = $('cmdInput').value;
  if (!line.trim()) return;
  const { cmd, args } = parseLine(line);
  run(cmd, args, 'typed').catch(() => {});
  $('cmdInput').value = '';
});

// ── Bridge connection ─────────────────────────────────────────────────────────────────────

// The secret arrives once as #secret=… and is then kept for this tab only, off the URL bar.
const SECRET_KEY = 'dxr-muse-voice-secret';
if (hash.has('secret')) {
  try { sessionStorage.setItem(SECRET_KEY, hash.get('secret')); } catch { /* storage blocked */ }
}
let secret = hash.get('secret');
if (!secret) {
  try { secret = sessionStorage.getItem(SECRET_KEY); } catch { secret = null; }
}
if (hash.has('secret')) {
  hash.delete('secret');
  const rest = hash.toString();
  history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
}

// Served by the bridge (http://localhost:8791/) -> same-origin /ws. On GitHub Pages there is no
// bridge, so the page is keyboard-only unless ?bridge=ws://localhost:8791/ws is given.
const bridgeUrl =
  params.get('bridge') ||
  (location.protocol === 'http:' ? `ws://${location.host}/ws` : null);

let socket = null;

function sendStatus() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'status',
    state: {
      content: call ? 'call' : current ? { kind: current.kind, label: current.label } : null,
      woven: wall.supported,
      hardware: wall.hardwareDisplayState ?? null,
      depth,
    },
  }));
}

function connect(delay = 1000) {
  const ws = new WebSocket(bridgeUrl);
  socket = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', role: 'display', name: 'display', secret }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'welcome') {
      delay = 1000;
      $('srcState').textContent = 'bridge connected';
      log(`connected to ${bridgeUrl}`, 'ok');
      sendStatus();
      return;
    }
    if (msg.type === 'command' && typeof msg.id === 'string') {
      run(msg.cmd, msg.args ?? {}, msg.from || 'bridge').then(
        (detail) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'ack', id: msg.id, ok: true, detail })),
        (err) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'ack', id: msg.id, ok: false, error: err?.message || String(err) })),
      );
    }
  };
  ws.onclose = (ev) => {
    if (ev.code === 4401) {
      $('srcState').textContent = 'bad secret';
      setBadge('err', 'bridge rejected the secret (open with #secret=…)');
      return; // retrying with the same secret cannot help
    }
    $('srcState').textContent = 'bridge offline, retrying';
    setTimeout(() => connect(Math.min(delay * 2, 10000)), delay);
  };
}

if (!bridgeUrl) {
  $('srcState').textContent = 'keyboard (mock)';
} else if (!secret) {
  $('srcState').textContent = 'no secret';
  log('open this page with #secret=<BRIDGE_SECRET> to receive voice commands', 'err');
} else {
  connect();
}

setBadge('live', wall.supported ? 'DisplayXR 3D ready' : '2D mode (open in the DisplayXR Browser for 3D)');
refreshBar();

// An invite link (#room=…) opens straight into the call.
if (hash.has('room')) run('start_call', {}, 'invite link').catch(() => {});
