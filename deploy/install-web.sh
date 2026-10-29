#!/usr/bin/env bash
# Install the Job Radar web UI as a user service and publish it to your tailnet
# (never the public internet) with `tailscale serve`. Idempotent.
#
#   bash deploy/install-web.sh [https-port]      (default 8444)
#
# The server binds 127.0.0.1 only. `tailscale serve` terminates HTTPS with the
# machine's tailnet certificate and forwards to it, adding the viewer's tailnet
# login; the server admits only the hosts and logins in operations.yaml `web:`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
https_port="${1:-8444}"
unit_dir="$HOME/.config/systemd/user"

node_bin="$(command -v node || true)"
[ -n "$node_bin" ] || { echo "ERROR: no 'node' on PATH. Install Node, or run this from a shell that has it." >&2; exit 1; }
command -v tailscale >/dev/null || { echo "ERROR: tailscale is not installed." >&2; exit 1; }

cd "$repo"
# The config must already admit this machine's tailnet name and at least one login.
dns="$(tailscale status --self --json | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')"
read -r local_port hosts < <(npm run --silent cli -- serve --check)
if ! tr ',' '\n' <<<"$hosts" | grep -qx "$dns"; then
  cat >&2 <<MSG
ERROR: config/operations.yaml does not admit this machine's tailnet name yet. Add:

web:
  port: ${local_port}
  allowed_hosts: ["${dns}"]
  allowed_logins: ["you@example.com"]   # your tailnet login (tailscale status shows it)

then run this script again.
MSG
  exit 1
fi

echo "Pinning node: $node_bin ($("$node_bin" -v)); checkout: $repo; local port $local_port"
mkdir -p "$unit_dir" "$repo/data"
sed "s#^WorkingDirectory=.*#WorkingDirectory=${repo}#; \
     s#^ReadWritePaths=.*#ReadWritePaths=${repo}/data#; \
     s#^Environment=PATH=.*#Environment=PATH=$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin#" \
  "$here/jr-web.service" > "$unit_dir/jr-web.service"
systemctl --user daemon-reload
systemctl --user enable jr-web.service
systemctl --user restart jr-web.service

for _ in $(seq 1 40); do
  curl -fs -o /dev/null "http://127.0.0.1:${local_port}/assets/app.css" && break
  sleep 0.5
done
curl -fsS -o /dev/null "http://127.0.0.1:${local_port}/" || { echo "ERROR: the web UI did not come up; see: journalctl --user -u jr-web -n 50" >&2; exit 1; }

# Never take over a port another app already serves: `tailscale serve` silently
# replaces whatever is there. Re-running against our own proxy is fine.
existing="$(tailscale serve status --json | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const w=(JSON.parse(s||"{}").Web)||{};const h=w[process.argv[1]];const p=h&&h.Handlers&&h.Handlers["/"];console.log(p?(p.Proxy||"something other than a proxy"):"")})' "${dns}:${https_port}")"
if [ -n "$existing" ] && [ "$existing" != "http://127.0.0.1:${local_port}" ]; then
  echo "ERROR: https port ${https_port} already serves ${existing}. Pick a free port: bash deploy/install-web.sh <port>" >&2
  echo "       (tailscale serve status lists the ports in use)" >&2
  exit 1
fi

# Tailnet only. Never `tailscale funnel`: that would put it on the public internet
# (the server refuses Funnel requests anyway, but do not rely on one layer).
tailscale serve --bg --https="${https_port}" "http://127.0.0.1:${local_port}"
if tailscale funnel status 2>/dev/null | grep -A1 ":${https_port} (Funnel on)" | grep -q .; then
  echo "ERROR: port ${https_port} is exposed with Funnel. Turn it off: tailscale funnel --https=${https_port} off" >&2
  exit 1
fi
if ! loginctl show-user "$USER" -p Linger | grep -q yes; then
  echo "Note: lingering is off, so the service only runs while you are logged in. Enable with: loginctl enable-linger $USER"
fi
echo "Job Radar is at https://${dns}:${https_port}/ (tailnet only)."
