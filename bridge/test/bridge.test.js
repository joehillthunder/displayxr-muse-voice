import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createBridge, isLanAddress, secretMatches } from '../server.js';
import { validateCommand } from '../commands.js';
import { parseLine } from '../mock.js';

const SECRET = 'test-secret-0123456789';

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dxr-bridge-'));
  mkdirSync(join(root, 'display'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'display', 'index.html'), '<!doctype html>hi');
  writeFileSync(join(root, 'assets', 'a.glb'), 'glb');
  writeFileSync(join(root, 'secret.txt'), 'nope');
  return root;
}

async function start() {
  const bridge = createBridge({ secret: SECRET, port: 0, host: '127.0.0.1', root: fixtureRoot(), log: () => {} });
  const { port } = await bridge.listen();
  return { bridge, port };
}

/** Open a client, say hello, resolve once welcomed. Messages after that go to `inbox`. */
function client(port, role, secret = SECRET) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const inbox = [];
    const waiters = [];
    ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'hello', role, name: role, secret })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'welcome') return res({ ws, next });
      const w = waiters.shift();
      if (w) w(m);
      else inbox.push(m);
    });
    ws.on('close', (code) => rej(Object.assign(new Error('closed'), { code })));
    ws.on('error', () => {});
    function next() {
      return inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r));
    }
  });
}

test('validateCommand', () => {
  assert.equal(validateCommand('show_model', { name: 'duck' }), null);
  assert.equal(validateCommand('show_splat', { url: 'https://x.test/a.sog' }), null);
  assert.match(validateCommand('show_model', { name: 'duck', url: 'https://x.test/a' }), /exactly one/);
  assert.match(validateCommand('show_model', { url: 'javascript:alert(1)' }), /http or https/);
  assert.match(validateCommand('show_model', { name: '../etc' }), /lowercase/);
  assert.equal(validateCommand('set_mode', { mode: '2d' }), null);
  assert.match(validateCommand('set_mode', { mode: 'vr' }), /2d/);
  assert.equal(validateCommand('set_depth', { value: -0.5 }), null);
  assert.match(validateCommand('set_depth', { value: 3 }), /-1 to 1/);
  assert.equal(validateCommand('clear'), null);
  assert.match(validateCommand('rm_rf', {}), /unknown/);
  assert.match(validateCommand('toString', {}), /unknown/);
});

test('parseLine', () => {
  assert.deepEqual(parseLine('show_model duck'), { cmd: 'show_model', args: { name: 'duck' } });
  assert.deepEqual(parseLine('show_splat https://x.test/a.sog'), { cmd: 'show_splat', args: { url: 'https://x.test/a.sog' } });
  assert.deepEqual(parseLine('set_mode 2D'), { cmd: 'set_mode', args: { mode: '2d' } });
  assert.deepEqual(parseLine('set_depth 0.25'), { cmd: 'set_depth', args: { value: 0.25 } });
});

test('isLanAddress / secretMatches', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:192.168.1.4', '10.0.0.2', '172.20.1.1', 'fd12:3456::1']) {
    assert.ok(isLanAddress(a), a);
  }
  for (const a of ['8.8.8.8', '172.32.0.1', '2001:4860::8888', '', undefined]) assert.ok(!isLanAddress(a), a);
  assert.ok(secretMatches(SECRET, SECRET));
  assert.ok(!secretMatches('wrong', SECRET));
  assert.ok(!secretMatches(undefined, SECRET));
});

test('refuses to start without a strong secret', () => {
  assert.throws(() => createBridge({ secret: '' }), /BRIDGE_SECRET/);
  assert.throws(() => createBridge({ secret: 'short' }), /BRIDGE_SECRET/);
});

test('static files: serves display and assets, blocks traversal', async () => {
  const { bridge, port } = await start();
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/`)).status, 200);
    const glb = await fetch(`${base}/assets/a.glb`);
    assert.equal(glb.status, 200);
    assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
    assert.equal((await fetch(`${base}/%2e%2e/secret.txt`)).status, 404);
    assert.equal((await fetch(`${base}/assets/%2e%2e/secret.txt`)).status, 404);
    const health = await (await fetch(`${base}/healthz`)).json();
    assert.equal(health.ok, true);
  } finally {
    await bridge.close();
  }
});

test('bad secret is rejected with 4401', async () => {
  const { bridge, port } = await start();
  try {
    await assert.rejects(client(port, 'source', 'wrong-secret-xxxxxxxx'), (e) => e.code === 4401);
  } finally {
    await bridge.close();
  }
});

test('command relays to display and ack returns to the source', async () => {
  const { bridge, port } = await start();
  try {
    const display = await client(port, 'display');
    const source = await client(port, 'source');
    source.ws.send(JSON.stringify({ v: 1, type: 'command', id: 'c1', cmd: 'show_model', args: { name: 'duck' } }));
    const cmd = await display.next();
    assert.equal(cmd.type, 'command');
    assert.equal(cmd.cmd, 'show_model');
    assert.deepEqual(cmd.args, { name: 'duck' });
    display.ws.send(JSON.stringify({ v: 1, type: 'ack', id: 'c1', ok: true, detail: 'showing duck' }));
    const ack = await source.next();
    assert.deepEqual([ack.type, ack.id, ack.ok, ack.detail], ['ack', 'c1', true, 'showing duck']);
    display.ws.close();
    source.ws.close();
  } finally {
    await bridge.close();
  }
});

test('invalid command and no-display are answered by the bridge', async () => {
  const { bridge, port } = await start();
  try {
    const source = await client(port, 'source');
    source.ws.send(JSON.stringify({ v: 1, type: 'command', id: 'c2', cmd: 'set_mode', args: { mode: 'vr' } }));
    const bad = await source.next();
    assert.equal(bad.ok, false);
    assert.match(bad.error, /2d/);
    source.ws.send(JSON.stringify({ v: 1, type: 'command', id: 'c3', cmd: 'clear' }));
    const none = await source.next();
    assert.equal(none.ok, false);
    assert.match(none.error, /no display/);
    source.ws.close();
  } finally {
    await bridge.close();
  }
});
