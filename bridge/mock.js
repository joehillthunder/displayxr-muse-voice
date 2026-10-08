#!/usr/bin/env node
// Mock command source: type commands instead of talking to Muse.
//
//   node mock.js                         interactive prompt
//   node mock.js show_model duck         one command, then exit (exit code 1 on failure)
//   node mock.js show_splat url=https://example.com/x.sog
//   node mock.js set_mode 2d | set_depth 0.3 | start_call | clear
//
// Reads BRIDGE_URL and BRIDGE_SECRET from ../.env (or the environment).

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { loadEnv } from './env.js';
import { COMMANDS, validateCommand } from './commands.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** "show_model duck" -> { cmd, args }. Positional arg meaning depends on the command. */
export function parseLine(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const args = {};
  for (const tok of rest) {
    const eq = tok.indexOf('=');
    if (eq > 0) {
      const k = tok.slice(0, eq);
      const v = tok.slice(eq + 1);
      args[k] = k === 'value' ? Number(v) : v;
    } else if (cmd === 'show_model' || cmd === 'show_splat') {
      if (/^https?:\/\//.test(tok)) args.url = tok;
      else args.name = tok;
    } else if (cmd === 'set_mode') {
      args.mode = tok.toLowerCase();
    } else if (cmd === 'set_depth') {
      args.value = Number(tok);
    }
  }
  return { cmd, args };
}

function connect(url, secret) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'hello', role: 'source', name: 'mock-cli', secret })));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'welcome') {
        res({
          ws,
          send(cmd, args) {
            const id = randomUUID();
            ws.send(JSON.stringify({ v: 1, type: 'command', id, cmd, args }));
            return new Promise((r) => pending.set(id, r));
          },
        });
      } else if (msg.type === 'ack' && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    ws.on('close', (code, reason) => rej(new Error(`bridge closed the connection (${code} ${reason})`)));
    ws.on('error', rej);
  });
}

async function main() {
  loadEnv(join(ROOT, '.env'));
  const url = process.env.BRIDGE_URL || `ws://localhost:${process.env.BRIDGE_PORT || 8791}/ws`;
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) {
    console.error('BRIDGE_SECRET is not set. Copy .env.example to .env and fill it in.');
    process.exit(2);
  }
  const conn = await connect(url, secret);

  const run = async (line) => {
    const { cmd, args } = parseLine(line);
    const problem = validateCommand(cmd, args);
    if (problem) {
      console.log(`  x ${problem}`);
      return false;
    }
    const ack = await conn.send(cmd, args);
    console.log(ack.ok ? `  ok ${ack.detail || ''}` : `  x ${ack.error}`);
    return ack.ok;
  };

  if (process.argv.length > 2) {
    const ok = await run(process.argv.slice(2).join(' '));
    conn.ws.close();
    process.exit(ok ? 0 : 1);
  }

  console.log(`connected to ${url}. commands: ${Object.keys(COMMANDS).join(', ')}  (Ctrl+C to quit)`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'dxr> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    if (line.trim()) await run(line);
    rl.prompt();
  });
  rl.on('close', () => conn.ws.close());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
