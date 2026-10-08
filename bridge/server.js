// displayxr-muse-voice bridge: a LAN-only WebSocket relay.
//
//   sources (Pi gadget, mock CLI, ESP32) --command--> bridge --> every display page
//   display page --ack--> bridge --> the source that sent the command
//
// It also serves the display page and assets over plain HTTP so the DisplayXR Browser on this
// PC can open http://localhost:PORT/ (an https page could not open ws:// to this relay).

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadEnv } from './env.js';
import { PROTOCOL_VERSION, validateCommand } from './commands.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const HELLO_TIMEOUT_MS = 5000;
const ACK_TIMEOUT_MS = 20000;
const MAX_PAYLOAD = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.sog': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8',
};

/** True for loopback, RFC 1918, link-local and IPv6 ULA / link-local addresses. */
export function isLanAddress(addr) {
  if (!addr) return false;
  let a = addr.toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a.startsWith('127.')) return true;
  if (a.startsWith('10.') || a.startsWith('192.168.') || a.startsWith('169.254.')) return true;
  const m = /^172\.(\d+)\./.exec(a);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a) || a.startsWith('fe80:')) return true;
  return false;
}

function digest(s) {
  return createHash('sha256').update(String(s)).digest();
}

/** Constant-time secret comparison (hashing first makes the lengths equal). */
export function secretMatches(given, expected) {
  return typeof given === 'string' && timingSafeEqual(digest(given), digest(expected));
}

/** Map a URL path to a file under one of the static roots, or null. */
export function staticFile(urlPath, roots) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (p.includes('\0')) return null;
  for (const [prefix, dir] of roots) {
    if (p !== prefix.slice(0, -1) && !p.startsWith(prefix)) continue;
    let rel = p.slice(prefix.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(dir, rel));
    if (file !== dir && !file.startsWith(dir + sep)) return null;
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      /* not found */
    }
    return null;
  }
  return null;
}

export function createBridge({ secret, port = 8787, host = '0.0.0.0', root = ROOT, log = console.log } = {}) {
  if (!secret || secret.length < 16) {
    throw new Error('BRIDGE_SECRET must be set (16+ characters). Copy .env.example to .env.');
  }
  const roots = [
    ['/assets/', join(root, 'assets')],
    ['/', join(root, 'display')],
  ];

  const displays = new Set();
  const sources = new Set();
  const pending = new Map(); // command id -> { source, timer }

  const http = createServer((req, res) => {
    if (!isLanAddress(req.socket.remoteAddress)) {
      res.writeHead(403).end('LAN only');
      return;
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, displays: displays.size, sources: sources.size }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const file = staticFile(req.url, roots);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  http.on('upgrade', (req, socket, head) => {
    const path = (req.url || '').split('?')[0];
    if (path !== '/ws' || !isLanAddress(req.socket.remoteAddress)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  });

  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...msg }));
  }

  function ackTo(sourceWs, id, ok, extra) {
    send(sourceWs, { type: 'ack', id, ok, ...extra });
  }

  function onConnection(ws, req) {
    const peer = req.socket.remoteAddress;
    let role = null;
    let name = '?';
    const helloTimer = setTimeout(() => ws.close(4408, 'hello timeout'), HELLO_TIMEOUT_MS);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(4400, 'text frames only');
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return ws.close(4400, 'bad json');
      }
      if (!msg || typeof msg !== 'object') return ws.close(4400, 'bad message');

      if (!role) {
        if (msg.type !== 'hello') return ws.close(4400, 'expected hello');
        if (!secretMatches(msg.secret, secret)) {
          log(`[bridge] rejected ${peer}: bad secret`);
          return ws.close(4401, 'unauthorized');
        }
        if (msg.role !== 'display' && msg.role !== 'source') return ws.close(4400, 'bad role');
        clearTimeout(helloTimer);
        role = msg.role;
        name = typeof msg.name === 'string' ? msg.name.slice(0, 40) : role;
        (role === 'display' ? displays : sources).add(ws);
        log(`[bridge] ${role} "${name}" connected from ${peer}`);
        send(ws, { type: 'welcome', displays: displays.size });
        return;
      }

      if (role === 'source' && msg.type === 'command') {
        const id = typeof msg.id === 'string' && msg.id.length <= 64 ? msg.id : randomUUID();
        const args = msg.args ?? {};
        const problem = validateCommand(msg.cmd, args);
        if (problem) return ackTo(ws, id, false, { error: problem });
        if (displays.size === 0) {
          return ackTo(ws, id, false, { error: 'no display connected to the bridge' });
        }
        log(`[bridge] ${name} -> ${msg.cmd} ${JSON.stringify(args)}`);
        const timer = setTimeout(() => {
          pending.delete(id);
          ackTo(ws, id, false, { error: 'display did not answer in time' });
        }, ACK_TIMEOUT_MS);
        pending.set(id, { source: ws, timer });
        for (const d of displays) send(d, { type: 'command', id, cmd: msg.cmd, args, from: name });
        return;
      }

      if (role === 'display' && msg.type === 'ack' && typeof msg.id === 'string') {
        const p = pending.get(msg.id);
        if (!p) return; // already answered by another display, or timed out
        clearTimeout(p.timer);
        pending.delete(msg.id);
        const extra = msg.ok
          ? { detail: String(msg.detail ?? '').slice(0, 500) }
          : { error: String(msg.error ?? 'failed').slice(0, 500) };
        ackTo(p.source, msg.id, Boolean(msg.ok), extra);
        return;
      }

      if (role === 'display' && msg.type === 'status') {
        for (const s of sources) send(s, { type: 'status', state: msg.state ?? null });
        return;
      }

      if (msg.type === 'ping') send(ws, { type: 'pong' });
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      displays.delete(ws);
      sources.delete(ws);
      for (const [id, p] of pending) {
        if (p.source === ws) {
          clearTimeout(p.timer);
          pending.delete(id);
        }
      }
      if (role) log(`[bridge] ${role} "${name}" disconnected`);
    });
    ws.on('error', () => {});
  }

  return {
    http,
    listen() {
      return new Promise((res, rej) => {
        http.once('error', rej);
        http.listen(port, host, () => res(http.address()));
      });
    },
    close() {
      for (const p of pending.values()) clearTimeout(p.timer);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((res) => http.close(() => res()));
    },
  };
}

// Run directly: node server.js
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv(join(ROOT, '.env'));
  const port = Number(process.env.BRIDGE_PORT) || 8787;
  try {
    const bridge = createBridge({ secret: process.env.BRIDGE_SECRET, port });
    await bridge.listen();
    console.log(`[bridge] listening on :${port} (LAN only)`);
    console.log(`[bridge] display page: http://localhost:${port}/#secret=<BRIDGE_SECRET>`);
    console.log(`[bridge] sources connect to ws://<this-pc-ip>:${port}/ws`);
  } catch (err) {
    console.error(`[bridge] ${err.message}`);
    process.exit(1);
  }
}
