#!/usr/bin/env bash
# One-command setup for the Muse gadget on a Raspberry Pi 5 (or any Linux box with Bluetooth LE).
#
#   bash setup-pi.sh             install the Muse SDK + our commands, then open pairing
#   bash setup-pi.sh --yes       don't ask before giving Muse the account
#   bash setup-pi.sh --no-pair   install only; pair later with: sudo musegadget pair
#   bash setup-pi.sh --mock-only no Muse at all: a local venv for `dxr-gadget mock`
#
# Reads MUSE_SDK_TOKEN, BRIDGE_SECRET and BRIDGE_URL from .env next to this script.
#
# What it does, in order (the Muse SDK's own installer does steps 2-3):
#   1. Saves the SDK token where the SDK reads it (/var/lib/musegadget/sdk_token, root, 0600),
#      through stdin, so it never appears on a command line.
#   2. Fetches the Muse Linux SDK at a pinned commit and runs its install.sh --no-pair.
#   3. (install.sh) creates /opt/musegadget/venv and the musegadget systemd service.
#   4. Installs this repo's displayxr_gadget package into that venv.
#   5. Writes /etc/displayxr-muse-voice.env (bridge URL + secret; root and the command
#      account's group only) and a systemd drop-in that runs `dxr-gadget muse run`.
#   6. Restarts the service and opens Bluetooth pairing for the Muse app.

set -euo pipefail

MUSE_SDK_REPO="https://github.com/facebookincubator/muse-gadget-sdk"
MUSE_SDK_COMMIT="86cf33fb4092ba700b4dc33928966d1bcb31556d"
STATE_DIR="/var/lib/musegadget"
VENV="/opt/musegadget/venv"
UV="/opt/musegadget/bin/uv"
ENV_OUT="/etc/displayxr-muse-voice.env"
DROPIN_DIR="/etc/systemd/system/musegadget.service.d"
WRAPPER="/usr/local/bin/dxr-gadget"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

ASSUME_YES=0 NO_PAIR=0 MOCK_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --yes|-y) ASSUME_YES=1 ;;
        --no-pair) NO_PAIR=1 ;;
        --mock-only) MOCK_ONLY=1 ;;
        -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
        *) die "unknown option: $arg (try --help)" ;;
    esac
done

[ "$(uname -s)" = Linux ] || die "this script is for the Linux gadget (Raspberry Pi). On Windows use setup-windows.bat."
[ "$(id -u)" -ne 0 ] || die "run this as your normal account (it uses sudo where needed); Muse gets that account."

# ── .env ─────────────────────────────────────────────────────────────────────────────────

env_value() {
    # Value of KEY from .env, without surrounding quotes. Does not source the file.
    local key="$1" line value
    line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$REPO/.env" | tail -n 1 || true)"
    value="${line#*=}"
    value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
    printf '%s' "$value"
}

[ -f "$REPO/.env" ] || die "no .env. Copy .env.example to .env and fill in MUSE_SDK_TOKEN, BRIDGE_SECRET and BRIDGE_URL (setup-windows.bat prints the last two)."
BRIDGE_SECRET="$(env_value BRIDGE_SECRET)"
BRIDGE_URL="$(env_value BRIDGE_URL)"
MUSE_SDK_TOKEN="$(env_value MUSE_SDK_TOKEN)"

[ ${#BRIDGE_SECRET} -ge 16 ] || die "BRIDGE_SECRET in .env must be set (16+ characters), the same value as on the Windows PC."
case "$BRIDGE_URL" in
    ws://*/ws|wss://*/ws) ;;
    *) die "BRIDGE_URL in .env must look like ws://<windows-pc-ip>:8791/ws" ;;
esac
case "$BRIDGE_URL" in
    *://localhost*|*://127.*) warn "BRIDGE_URL points at this Pi ($BRIDGE_URL). It should be the Windows PC's LAN address." ;;
esac

check_bridge() {
    local http="${BRIDGE_URL/#ws/http}"
    http="${http%/ws}/healthz"
    if command -v curl >/dev/null && curl -fsS --max-time 3 "$http" >/dev/null 2>&1; then
        say "Bridge reachable at ${http%/healthz}"
    else
        warn "can't reach the bridge at ${http%/healthz} yet. Start it on the Windows PC (setup-windows.bat) and check the firewall; the gadget retries per command."
    fi
}

# ── Mock-only: no Muse, no root ──────────────────────────────────────────────────────────

if [ "$MOCK_ONLY" = 1 ]; then
    command -v python3 >/dev/null || die "python3 is needed."
    say "Creating $REPO/gadget/.venv"
    python3 -m venv "$REPO/gadget/.venv"
    "$REPO/gadget/.venv/bin/pip" install --quiet "$REPO/gadget"
    check_bridge
    say "Done. Try: $REPO/gadget/.venv/bin/dxr-gadget mock show_model car"
    exit 0
fi

# ── Muse ─────────────────────────────────────────────────────────────────────────────────

if [ -z "$MUSE_SDK_TOKEN" ]; then
    die "MUSE_SDK_TOKEN is empty in .env. Get one at https://gadgets.muse.ai/settings/sdk-tokens (gated by Meta; see the Gadget SDK Terms), or use --mock-only."
fi
# The same shape check the SDK's installer applies.
[[ "$MUSE_SDK_TOKEN" =~ ^mgst_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$ ]] \
    || die "MUSE_SDK_TOKEN in .env doesn't look like an SDK token (mgst_...). Copy it again from gadgets.muse.ai."

command -v sudo >/dev/null || die "sudo is needed."
sudo true || die "this needs sudo."
command -v git >/dev/null || { say "Installing git"; sudo apt-get update -qq && sudo apt-get install -y -qq git; }

say "Saving the SDK token to $STATE_DIR/sdk_token"
sudo install -d -m 0700 "$STATE_DIR"
printf '%s\n' "$MUSE_SDK_TOKEN" | sudo install -m 0600 /dev/stdin "$STATE_DIR/sdk_token"

SDK_DIR="$REPO/.vendor/muse-gadget-sdk"
if [ ! -d "$SDK_DIR/.git" ]; then
    say "Fetching the Muse Linux SDK"
    mkdir -p "$REPO/.vendor"
    git clone --quiet --filter=blob:none --no-checkout "$MUSE_SDK_REPO" "$SDK_DIR"
fi
git -C "$SDK_DIR" fetch --quiet origin "$MUSE_SDK_COMMIT" 2>/dev/null || git -C "$SDK_DIR" fetch --quiet origin
git -C "$SDK_DIR" -c advice.detachedHead=false checkout --quiet "$MUSE_SDK_COMMIT"
say "Muse Linux SDK pinned at ${MUSE_SDK_COMMIT:0:7}"

install_args=(--from "$SDK_DIR/linux" --run-as "$(id -un)" --no-pair)
[ "$ASSUME_YES" = 1 ] && install_args+=(--yes)
say "Running the Muse SDK installer (it explains what access Muse gets and asks first)"
bash "$SDK_DIR/linux/install.sh" "${install_args[@]}"

if [ ! -x "$VENV/bin/python" ] || [ ! -x "$UV" ]; then
    die "the Muse installer did not create $VENV; see its output above."
fi

say "Installing the DisplayXR commands into $VENV"
sudo "$UV" pip install --quiet --python "$VENV/bin/python" --no-deps --reinstall "$REPO/gadget"

say "Writing $ENV_OUT"
GROUP="$(id -gn)"
{
    printf 'BRIDGE_URL=%s\n' "$BRIDGE_URL"
    printf 'BRIDGE_SECRET=%s\n' "$BRIDGE_SECRET"
    printf 'DXR_CATALOG=%s\n' "$REPO/assets/catalog.json"
} | sudo install -m 0640 -o root -g "$GROUP" /dev/stdin "$ENV_OUT"

say "Pointing the musegadget service at dxr-gadget"
sudo install -d -m 0755 "$DROPIN_DIR"
sudo tee "$DROPIN_DIR/displayxr.conf" >/dev/null <<EOF
# Added by displayxr-muse-voice/setup-pi.sh. Remove this file to go back to plain musegadget.
[Service]
EnvironmentFile=$ENV_OUT
ExecStart=
ExecStart=$VENV/bin/dxr-gadget muse run
EOF

# For the fallback skill (Muse running dxr-gadget through system.run, as this account).
sudo tee "$WRAPPER" >/dev/null <<EOF
#!/bin/sh
DXR_ENV_FILE=$ENV_OUT exec $VENV/bin/dxr-gadget "\$@"
EOF
sudo chmod 0755 "$WRAPPER"

sudo systemctl daemon-reload
sudo systemctl restart musegadget.service
check_bridge

if sudo test -s "$STATE_DIR/pairing.json"; then
    say "Already paired; the service reconnects to your Muse with the DisplayXR commands."
elif [ "$NO_PAIR" = 1 ]; then
    say "Skipping pairing. Run 'sudo musegadget pair' when you're ready."
else
    cat <<EOF

Pair with your Muse:
  1. In the Muse app, turn on Settings > Devices > Developer mode.
  2. Add a device and choose the MuseGadget... device named below.
  3. When asked for Wi-Fi, pick the network shown; no password is needed.

EOF
    sudo /usr/local/bin/musegadget pair || warn "not paired. Run 'sudo musegadget pair' to try again."
fi

cat <<EOF

Done.
  Check:      sudo journalctl -u musegadget -f      (look for "added 6 DisplayXR commands")
  Test:       dxr-gadget mock show_model car        (straight to the bridge, no Muse)
  Then ask:   "Hey Muse, show the toy car on my 3D display."
  Undo ours:  sudo rm $DROPIN_DIR/displayxr.conf $ENV_OUT $WRAPPER && sudo systemctl daemon-reload && sudo systemctl restart musegadget
EOF
