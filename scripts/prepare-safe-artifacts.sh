#!/usr/bin/env bash
set -euo pipefail

# Explicit provisioning only; focused tests never download dependencies.
# Usage: bash scripts/prepare-safe-artifacts.sh [--fetch]
# Then export the two assignments printed on stdout before pnpm check:linux.
# Official @safe-global/safe-contracts@1.4.1, tag v1.4.1 at
# bf943f80fec5ac647159d26161446ac5d716a294 (safe-global/safe-smart-account).
root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
archive="$root/.tools/downloads/safe-contracts-1.4.1.tgz"
archive_sha=8803f7cf26e2c58300b8136342faa7b8bce59436e300f52115fa25b095e0bf79
pins_sha=c86407d16e2e9da4973d442ec57bb35176bf3567a265d8179ca0a94412e0e730
hash_check() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check --status
  elif command -v shasum >/dev/null 2>&1; then
    while IFS='  ' read -r expected file; do
      [[ $(shasum -a 256 "$file" | cut -d ' ' -f 1) == "$expected" ]] || return 1
    done
  else
    echo 'SHA256_TOOL_REQUIRED: install sha256sum or shasum' >&2
    return 1
  fi
}
[[ $# == 0 || ( $# == 1 && $1 == --fetch ) ]] || { echo 'Usage: prepare-safe-artifacts.sh [--fetch]' >&2; exit 1; }
umask 077
mkdir -p "$root/.tools/downloads" "$root/.local"
stage=$(mktemp -d "$root/.local/safe-1.4.1.XXXXXX")
# Only files created inside this private stage are removed on failure.
trap 'rm -f -- "$stage/archive.tgz" "$stage/Safe.json" "$stage/SafeProxy.json" "$stage/build-info.json" "$stage/pins.json"; rmdir -- "$stage"' EXIT
if [[ ! -e "$archive" && ${1:-} == --fetch ]]; then
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 180 \
    https://registry.npmjs.org/@safe-global/safe-contracts/-/safe-contracts-1.4.1.tgz \
    --output "$stage/archive.tgz"
else
  [[ -f "$archive" && ! -L "$archive" ]] || { echo 'SAFE_ARCHIVE_REQUIRED: run prepare-safe-artifacts.sh --fetch' >&2; exit 1; }
  cp -- "$archive" "$stage/archive.tgz"
fi
printf '%s  %s\n' "$archive_sha" "$stage/archive.tgz" | hash_check
# Extract only the three reviewed regular-file payloads, never archive paths.
tar -xOf "$stage/archive.tgz" package/build/artifacts/contracts/Safe.sol/Safe.json > "$stage/Safe.json"
tar -xOf "$stage/archive.tgz" package/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json > "$stage/SafeProxy.json"
tar -xOf "$stage/archive.tgz" package/build/artifacts/build-info/0128da95e283bfa75197e80e5a451911.json > "$stage/build-info.json"
cp -- "$root/tooling/testnet-ccip/artifacts/safe-1.4.1-pins.json" "$stage/pins.json"
printf '%s  %s\n' "$pins_sha" "$stage/pins.json" | hash_check
printf '%s  %s\n' \
  c36a5e99bc3f25c2d75ac5f7920b679200b3ce617c0d26e674b1321dbc6b0bdf "$stage/Safe.json" \
  b05eaeaf7278097e52a9e9b38410de2a812c23fa3622373473e73eaa19646ecd "$stage/SafeProxy.json" \
  0e26726d8b59a0a5b534b8c85d7119ce6640ed12610ca440c67c90617368bba4 "$stage/build-info.json" \
  | hash_check
# The E2E additionally authenticates artifact bytes, ABI, source metadata and runtime.
if [[ ! -e "$archive" ]]; then
  cp -- "$stage/archive.tgz" "$archive"
fi
rm -- "$stage/archive.tgz"
trap - EXIT
printf 'AGTMAI_SAFE_ARTIFACT_DIRECTORY=%s\nAGTMAI_SAFE_PINS_SHA256=0x%s\n' "$stage" "$pins_sha"
