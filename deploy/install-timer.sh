#!/usr/bin/env bash
#
# Install the Job Radar daily timer as a USER systemd unit.
#
# User units, not system units, on purpose: the job reads a config directory in
# $HOME, writes into a checkout in $HOME, and needs no privilege at all. It is
# also the difference between `systemctl --user` and needing sudo to inspect
# why last night's run failed.
#
# Idempotent: safe to re-run after editing the unit files.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/job-radar/env"

mkdir -p "$UNIT_DIR" "$(dirname "$ENV_FILE")"

if [ ! -f "$ENV_FILE" ]; then
  # 600 before anything is written to it, not after.
  install -m 600 /dev/null "$ENV_FILE"
  cat > "$ENV_FILE" <<'ENVEOF'
# Job Radar environment. chmod 600 - this holds an API key.
ANTHROPIC_API_KEY=
# Optional, for `inbox` (read-only Gmail):
# JOB_RADAR_GMAIL_CLIENT_ID=
# JOB_RADAR_GMAIL_CLIENT_SECRET=
# JOB_RADAR_GMAIL_REFRESH_TOKEN=
ENVEOF
  echo "Created $ENV_FILE - put your ANTHROPIC_API_KEY in it before the first run."
fi

# Resolve the node this shell actually uses, and pin it into the unit.
#
# systemd user units do not source a shell profile, so nvm and friends are
# invisible to them: without this the unit silently gets /usr/bin/node. On the
# machine this was written on that meant Node 18 against a shell running Node
# 24, and the first unattended run died on "Playwright requires Node.js 20 or
# higher" - a failure that cannot be reproduced from a terminal.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: no 'node' on PATH. Install Node, or run this from a shell that has it." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"
echo "Pinning node: $NODE_BIN ($("$NODE_BIN" -v))"

# The unit hardcodes a WorkingDirectory under %h; rewrite it for this checkout
# so a clone anywhere still works.
sed "s#^WorkingDirectory=.*#WorkingDirectory=${REPO}#; \
     s#^ReadWritePaths=.*#ReadWritePaths=${REPO}/data ${REPO}/reports#; \
     s#^Environment=PATH=.*#Environment=PATH=${NODE_DIR}:/usr/local/bin:/usr/bin:/bin#" \
  "$REPO/deploy/job-radar-daily.service" > "$UNIT_DIR/job-radar-daily.service"
cp "$REPO/deploy/job-radar-daily.timer" "$UNIT_DIR/job-radar-daily.timer"

systemctl --user daemon-reload
systemctl --user enable --now job-radar-daily.timer

# Without lingering, user units stop when the last session closes - so the
# timer would only ever fire while logged in, which is not a schedule.
if [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null || echo no)" != "yes" ]; then
  echo
  echo "WARNING: lingering is off, so this timer only runs while you are logged in."
  echo "  Fix with: sudo loginctl enable-linger $USER"
fi

echo
systemctl --user list-timers job-radar-daily.timer --no-pager
echo
echo "Run it once now:  systemctl --user start job-radar-daily.service"
echo "Watch it:         journalctl --user -u job-radar-daily.service -f"
echo "Stop scheduling:  systemctl --user disable --now job-radar-daily.timer"
