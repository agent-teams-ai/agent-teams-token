#!/usr/bin/env bash
set -euo pipefail

token_repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
token_tools_root="$token_repo_root/.tools"
mkdir -p "$token_tools_root/downloads" "$token_tools_root/bin"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This bootstrap currently supports macOS arm64 only. Linux uses CI containers." >&2
  exit 1
fi

download_verified() {
  local token_url=$1
  local token_sha=$2
  local token_target=$3

  if [[ ! -f "$token_target" ]]; then
    curl --fail --location --show-error --output "$token_target" "$token_url"
  fi

  local token_actual
  token_actual=$(shasum -a 256 "$token_target" | awk '{print $1}')
  if [[ "$token_actual" != "$token_sha" ]]; then
    echo "Checksum mismatch for $token_target" >&2
    exit 1
  fi
}

node_archive="$token_tools_root/downloads/node-v24.20.0-darwin-arm64.tar.gz"
download_verified \
  "https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-arm64.tar.gz" \
  "40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8" \
  "$node_archive"
if [[ ! -d "$token_tools_root/node-v24.20.0-darwin-arm64" ]]; then
  tar -xzf "$node_archive" -C "$token_tools_root"
fi

foundry_archive="$token_tools_root/downloads/foundry-v1.8.0-darwin-arm64.tar.gz"
download_verified \
  "https://github.com/foundry-rs/foundry/releases/download/v1.8.0/foundry_v1.8.0_darwin_arm64.tar.gz" \
  "0599b28a19af97c3ae91fab12ad868a1922db7770c4adff6b6d26235862153d0" \
  "$foundry_archive"
if [[ ! -d "$token_tools_root/foundry-v1.8.0" ]]; then
  mkdir -p "$token_tools_root/foundry-v1.8.0"
  tar -xzf "$foundry_archive" -C "$token_tools_root/foundry-v1.8.0"
fi

agave_archive="$token_tools_root/downloads/agave-v4.2.1-darwin-arm64.tar.bz2"
download_verified \
  "https://github.com/anza-xyz/agave/releases/download/v4.2.1/solana-release-aarch64-apple-darwin.tar.bz2" \
  "9fb744917877acc68ae2421aef8d7f44f0d5eb16428e9d3db2c98b1ae61fd239" \
  "$agave_archive"
if [[ ! -d "$token_tools_root/agave-v4.2.1" ]]; then
  mkdir -p "$token_tools_root/agave-v4.2.1"
  tar -xjf "$agave_archive" -C "$token_tools_root/agave-v4.2.1"
fi

source "$token_repo_root/scripts/env.sh"
corepack enable --install-directory "$token_tools_root/bin"
corepack prepare pnpm@11.24.0 --activate
pnpm install --frozen-lockfile=false

echo "Project-local toolchains are ready. Run ./dev doctor."
