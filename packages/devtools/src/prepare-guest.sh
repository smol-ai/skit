#!/usr/bin/env bash
# Preparation for the pinned Debian ARM64 image. Version inputs belong to configuration.ts.
set -euo pipefail
if [[ $(uname -s) != Linux || $(uname -m) != aarch64 || $(id -un) != admin || $# != 5 ]]; then
  echo 'Run through pnpm vm baseline in the Debian ARM64 guest.' >&2
  exit 1
fi
if [[ -e "$HOME/.skit" || -e "$HOME/.codex/auth.json" ]]; then
  echo 'Baseline contains SKIT state or Codex credentials. Run pnpm vm reset.' >&2
  exit 1
fi
node_version=$1
node_sha256=$2
pnpm_version=$3
codex_version=$4
fingerprint=$5
sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  git ca-certificates curl xz-utils
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
download=$(mktemp -d)
trap 'rm -rf "$download"' EXIT
cd "$download"
node_archive="node-v${node_version}-linux-arm64.tar.xz"
curl -fsSL --retry 2 "https://nodejs.org/dist/v${node_version}/$node_archive" -o "$node_archive"
printf '%s  %s\n' "$node_sha256" "$node_archive" | sha256sum -c -
tar -xJf "$node_archive" -C "$HOME/.local" --strip-components=1
npm config set prefix "$HOME/.local"
if ! grep -qF 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.bashrc"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
fi
npm install -g "pnpm@$pnpm_version" "@openai/codex@$codex_version"
[[ $(node --version) == "v$node_version" ]]
[[ $(pnpm --version) == "$pnpm_version" ]]
node --version
pnpm --version
codex --version
printf '%s\n' "$fingerprint" > "$HOME/.skit-baseline"
sudo apt-get clean
rm -rf "$HOME/.npm/_cacache"
echo 'Baseline prepared without authentication.'
