#!/usr/bin/env bash
# Install the Job Radar user timer. Idempotent: re-run after upgrading Node or
# moving the checkout.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$unit_dir" "$repo/data" "$repo/reports" "$repo/artifacts"
node_bin="$(command -v node || true)"
if [ -z "$node_bin" ]; then
  echo "ERROR: no 'node' on PATH. Install Node, or run this from a shell that has it." >&2
  exit 1
fi
node_dir="$(dirname "$node_bin")"
echo "Pinning node: $node_bin ($("$node_bin" -v)); checkout: $repo"

# Version 1's timer runs a command that no longer exists. Retire it.
if systemctl --user list-unit-files job-radar-daily.timer --no-legend 2>/dev/null | grep -q job-radar-daily; then
  echo "Disabling the version 1 timer (job-radar-daily.timer)."
  systemctl --user disable --now job-radar-daily.timer || true
fi

# The unit names a default checkout path; rewrite it for this one.
sed "s#^WorkingDirectory=.*#WorkingDirectory=${repo}#; \
     s#^ReadWritePaths=.*#ReadWritePaths=${repo}/data ${repo}/reports ${repo}/artifacts#; \
     s#^Environment=PATH=.*#Environment=PATH=${node_dir}:/usr/local/bin:/usr/bin:/bin#" \
  "$here/jr-daily.service" > "$unit_dir/jr-daily.service"
cp "$here/jr-daily.timer" "$unit_dir/jr-daily.timer"
systemctl --user daemon-reload
systemctl --user enable --now jr-daily.timer
if ! loginctl show-user "$USER" -p Linger | grep -q yes; then
  echo "Note: lingering is off, so the timer only fires while you are logged in. Enable with: loginctl enable-linger $USER"
fi
systemctl --user list-timers jr-daily.timer --no-pager
