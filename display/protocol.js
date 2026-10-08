// The command vocabulary, shared by the display page, the bridge and the Node mock CLI.
// The canonical copy: the browser page imports it directly, the bridge re-exports it.
// Keep in sync with gadget/displayxr_gadget/protocol.py and docs/protocol.md.

export const PROTOCOL_VERSION = 1;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function source(args) {
  const hasName = typeof args.name === 'string';
  const hasUrl = typeof args.url === 'string';
  if (hasName === hasUrl) return 'give exactly one of name or url';
  if (hasName && !NAME_RE.test(args.name)) return 'name must be lowercase letters, digits, - or _';
  if (hasUrl) {
    if (args.url.length > 2048) return 'url too long';
    let u;
    try {
      u = new URL(args.url);
    } catch {
      return 'url is not a valid URL';
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'url must be http or https';
  }
  return null;
}

export const COMMANDS = {
  show_model: source,
  show_splat: source,
  set_mode: (a) => (a.mode === '2d' || a.mode === '3d' ? null : 'mode must be "2d" or "3d"'),
  start_call: () => null,
  clear: () => null,
  set_depth: (a) =>
    typeof a.value === 'number' && Number.isFinite(a.value) && a.value >= -1 && a.value <= 1
      ? null
      : 'value must be a number from -1 to 1',
};

/** Returns null when valid, else a message. */
export function validateCommand(cmd, args) {
  if (typeof cmd !== 'string' || !Object.hasOwn(COMMANDS, cmd)) return `unknown command: ${cmd}`;
  if (args === undefined) args = {};
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'args must be an object';
  return COMMANDS[cmd](args);
}
