#!/bin/bash
set -euo pipefail

token_bootstrap_source=${BASH_SOURCE[0]}
if [[ "$token_bootstrap_source" == */* ]]; then
  token_bootstrap_directory=${token_bootstrap_source%/*}
  [[ -n "$token_bootstrap_directory" ]] || token_bootstrap_directory=/
else
  token_bootstrap_directory=.
fi
token_repo_root=$(CDPATH= cd -- "$token_bootstrap_directory/.." && pwd -P)
token_mode=${1:-all}
token_tools_root="$token_repo_root/.tools"
token_downloads="$token_tools_root/downloads"
PATH=/usr/bin:/bin
export PATH

token_bootstrap_usage() {
  printf 'Usage: ./dev bootstrap [fetch|install --offline|verify --offline|all]\n' >&2
}

case "$token_mode" in
  fetch|install|verify|all|doctor)
    ;;
  help|-h|--help)
    token_bootstrap_usage
    exit 0
    ;;
  *)
    token_bootstrap_usage
    exit 64
    ;;
esac

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    token_platform=darwin-arm64
    token_node_archive=node-v24.20.0-darwin-arm64.tar.gz
    token_node_directory=node-v24.20.0-darwin-arm64
    token_node_url=https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-arm64.tar.gz
    token_node_sha256=40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8
    token_node_tar_flag=-xzf
    token_sha256_program=/usr/bin/shasum
    token_sha256_argument=-a
    ;;
  Linux:x86_64)
    token_platform=linux-x64
    token_node_archive=node-v24.20.0-linux-x64.tar.xz
    token_node_directory=node-v24.20.0-linux-x64
    token_node_url=https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz
    token_node_sha256=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
    token_node_tar_flag=-xJf
    token_sha256_program=/usr/bin/sha256sum
    token_sha256_argument=
    ;;
  *)
    printf 'TOOLCHAIN_UNSUPPORTED_PLATFORM platform=%s:%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

token_sha256() {
  if [[ -n "$token_sha256_argument" ]]; then
    "$token_sha256_program" "$token_sha256_argument" 256 "$1" | /usr/bin/awk '{print $1}'
  else
    "$token_sha256_program" "$1" | /usr/bin/awk '{print $1}'
  fi
}

token_descriptor_identity() {
  local token_descriptor=$1
  local token_identity
  case "$token_platform" in
    darwin-arm64)
      # macOS must fstat the inherited descriptor itself. Statting /dev/fd/N
      # reports the devfs pseudo-device instead of the held file's device.
      token_identity=$(/usr/bin/stat -f '%d:%i' <&"$token_descriptor") || return 1
      ;;
    linux-x64)
      token_identity=$(/usr/bin/stat -L -c '%d:%i' "/proc/self/fd/$token_descriptor") || return 1
      ;;
  esac
  [[ "$token_identity" =~ ^[0-9]+:[0-9]+$ ]] || return 1
  printf '%s\n' "$token_identity"
}

token_path_identity() {
  local token_path=$1
  local token_identity
  case "$token_platform" in
    darwin-arm64)
      token_identity=$(/usr/bin/stat -L -f '%d:%i' "$token_path") || return 1
      ;;
    linux-x64)
      token_identity=$(/usr/bin/stat -L -c '%d:%i' "$token_path") || return 1
      ;;
  esac
  [[ "$token_identity" =~ ^[0-9]+:[0-9]+$ ]] || return 1
  printf '%s\n' "$token_identity"
}

token_prepare_pinned_node() {
  local token_allow_fetch=$1
  local token_archive_path="$token_downloads/$token_node_archive"
  mkdir -p "$token_downloads"
  if [[ ! -f "$token_archive_path" ]] || [[ "$(token_sha256 "$token_archive_path")" != "$token_node_sha256" ]]; then
    if [[ "$token_allow_fetch" != true ]]; then
      printf 'TOOLCHAIN_OFFLINE_CACHE_MISS tool=node expected=%s\n' "$token_archive_path" >&2
      return 1
    fi
    rm -f "$token_archive_path"
    local token_part="$token_archive_path.part"
    rm -f "$token_part"
    /usr/bin/curl --fail --location --proto '=https' --show-error --output "$token_part" "$token_node_url"
    local token_actual_sha256
    token_actual_sha256=$(token_sha256 "$token_part")
    if [[ "$token_actual_sha256" != "$token_node_sha256" ]]; then
      printf 'TOOLCHAIN_CHECKSUM_MISMATCH tool=node expected=%s actual=%s partial=%s\n' \
        "$token_node_sha256" "$token_actual_sha256" "$token_part" >&2
      return 1
    fi
    mv "$token_part" "$token_archive_path"
  fi
  # Open independent descriptors before checking the checksum. The checksum and
  # extraction then remain bound to the same inode even if the archive pathname
  # is replaced between those operations.
  exec 7<"$token_archive_path"
  exec 8<"$token_archive_path"
  exec 9<"$token_archive_path"
  local token_descriptor_7_identity
  local token_descriptor_8_identity
  local token_descriptor_9_identity
  if ! token_descriptor_7_identity=$(token_descriptor_identity 7) \
    || ! token_descriptor_8_identity=$(token_descriptor_identity 8) \
    || ! token_descriptor_9_identity=$(token_descriptor_identity 9) \
    || [[ "$token_descriptor_7_identity" != "$token_descriptor_8_identity" ]] \
    || [[ "$token_descriptor_8_identity" != "$token_descriptor_9_identity" ]]; then
    printf 'TOOLCHAIN_ARCHIVE_IDENTITY_CHANGED tool=node path=%s\n' \
      "$token_archive_path" >&2
    exec 7<&- 8<&- 9<&-
    return 1
  fi
  local token_descriptor_sha256
  token_descriptor_sha256=$(token_sha256 /dev/fd/8)
  if [[ "$token_descriptor_sha256" != "$token_node_sha256" ]]; then
    printf 'TOOLCHAIN_CHECKSUM_MISMATCH tool=node expected=%s actual=%s path=%s\n' \
      "$token_node_sha256" "$token_descriptor_sha256" "$token_archive_path" >&2
    exec 7<&- 8<&- 9<&-
    return 1
  fi

  token_node_stage=$(/usr/bin/mktemp -d "$token_tools_root/.bootstrap-node-part.XXXXXX")
  trap 'rm -rf "$token_node_stage"' EXIT
  /usr/bin/tar --no-same-owner --no-same-permissions \
    "$token_node_tar_flag" /dev/fd/9 -C "$token_node_stage"
  local token_post_extract_sha256
  token_post_extract_sha256=$(token_sha256 /dev/fd/7)
  local token_final_descriptor_7_identity
  local token_final_descriptor_8_identity
  local token_final_descriptor_9_identity
  local token_final_path_identity
  if [[ "$token_post_extract_sha256" != "$token_node_sha256" ]] \
    || ! token_final_descriptor_7_identity=$(token_descriptor_identity 7) \
    || ! token_final_descriptor_8_identity=$(token_descriptor_identity 8) \
    || ! token_final_descriptor_9_identity=$(token_descriptor_identity 9) \
    || ! token_final_path_identity=$(token_path_identity "$token_archive_path") \
    || [[ "$token_final_descriptor_7_identity" != "$token_descriptor_7_identity" ]] \
    || [[ "$token_final_descriptor_8_identity" != "$token_descriptor_8_identity" ]] \
    || [[ "$token_final_descriptor_9_identity" != "$token_descriptor_9_identity" ]] \
    || [[ "$token_final_descriptor_7_identity" != "$token_final_descriptor_8_identity" ]] \
    || [[ "$token_final_descriptor_8_identity" != "$token_final_descriptor_9_identity" ]] \
    || [[ "$token_final_path_identity" != "$token_final_descriptor_7_identity" ]]; then
    printf 'TOOLCHAIN_ARCHIVE_SUBSTITUTED tool=node path=%s\n' \
      "$token_archive_path" >&2
    exec 7<&- 8<&- 9<&-
    return 1
  fi
  exec 7<&- 8<&- 9<&-
  token_pinned_node="$token_node_stage/$token_node_directory/bin/node"
  [[ "$($token_pinned_node --version)" == v24.20.0 ]]
}

case "$token_mode" in
  fetch)
    token_prepare_pinned_node true
    "$token_pinned_node" "$token_repo_root/scripts/toolchain.mjs" fetch "${@:2}"
    ;;
  install)
    token_prepare_pinned_node false
    "$token_pinned_node" "$token_repo_root/scripts/toolchain.mjs" install "${@:2}"
    ;;
  verify)
    token_prepare_pinned_node false
    "$token_pinned_node" "$token_repo_root/scripts/toolchain.mjs" verify "${@:2}"
    ;;
  doctor)
    token_prepare_pinned_node false
    "$token_pinned_node" "$token_repo_root/scripts/toolchain.mjs" verify --offline
    "$token_pinned_node" "$token_repo_root/scripts/doctor.mjs" "${@:2}"
    ;;
  all)
    token_prepare_pinned_node true
    "$token_pinned_node" "$token_repo_root/scripts/toolchain.mjs" fetch
    "$token_pinned_node" "$token_repo_root/scripts/toolchain.mjs" install --offline
    source "$token_repo_root/scripts/env.sh"
    if [[ "$(command -v pnpm)" != "$token_tools_root/bin/pnpm" ]]; then
      printf '%s\n' 'TOOLCHAIN_PNPM_PATH_MISMATCH expected=.tools/bin/pnpm' >&2
      exit 1
    fi
    if [[ "$(pnpm --version 2>/dev/null || true)" != "11.24.0" ]]; then
      printf '%s\n' 'TOOLCHAIN_PNPM_MISMATCH expected=11.24.0 action=install-the-exact-packageManager-version' >&2
      exit 1
    fi
    pnpm install --frozen-lockfile
    ;;
esac
