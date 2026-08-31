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

token_descriptor_fingerprint() {
  local token_descriptor=$1
  local token_identity
  case "$token_platform" in
    darwin-arm64)
      # macOS must fstat the inherited descriptor itself. Statting /dev/fd/N
      # reports the devfs pseudo-device instead of the held file's device.
      token_identity=$(/usr/bin/stat -f '%d|%i|%p|%u|%g|%z|%Fm|%Fc|%l' <&"$token_descriptor") || return 1
      ;;
    linux-x64)
      token_identity=$(/usr/bin/stat -L -c '%d|%i|%f|%u|%g|%s|%y|%z|%h' "/proc/self/fd/$token_descriptor") || return 1
      ;;
  esac
  [[ -n "$token_identity" ]] || return 1
  printf '%s\n' "$token_identity"
}

token_path_fingerprint() {
  local token_path=$1
  local token_identity
  case "$token_platform" in
    darwin-arm64)
      token_identity=$(/usr/bin/stat -L -f '%d|%i|%p|%u|%g|%z|%Fm|%Fc|%l' "$token_path") || return 1
      ;;
    linux-x64)
      token_identity=$(/usr/bin/stat -L -c '%d|%i|%f|%u|%g|%s|%y|%z|%h' "$token_path") || return 1
      ;;
  esac
  [[ -n "$token_identity" ]] || return 1
  printf '%s\n' "$token_identity"
}

token_fingerprint_inode_key() {
  local token_without_links=${1%|*}
  printf '%s\n' "${token_without_links%|*}"
}

token_fingerprint_size() {
  local token_device token_inode token_mode token_uid token_gid token_size
  local token_mtime token_ctime token_links
  IFS='|' read -r token_device token_inode token_mode token_uid token_gid token_size \
    token_mtime token_ctime token_links <<<"$1"
  [[ "$token_size" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$token_size"
}

token_assert_archive_fingerprint() {
  local token_fingerprint=$1
  local token_expected_size=$2
  local token_expected_links=${3:-}
  local token_device token_inode token_mode token_uid token_gid token_size
  local token_mtime token_ctime token_links
  IFS='|' read -r token_device token_inode token_mode token_uid token_gid token_size \
    token_mtime token_ctime token_links <<<"$token_fingerprint"
  [[ -n "$token_device" && -n "$token_inode" && -n "$token_mtime" && -n "$token_ctime" ]] \
    || return 1
  [[ "$token_size" == "$token_expected_size" && "$token_links" =~ ^[0-9]+$ ]] || return 1
  if [[ -n "$token_expected_links" && "$token_links" != "$token_expected_links" ]]; then
    return 1
  fi
  case "$token_platform" in
    darwin-arm64) [[ "$token_mode" == 100* ]] ;;
    linux-x64) [[ "$token_mode" == 8* ]] ;;
  esac
}

token_assert_private_snapshot_fingerprint() {
  local token_fingerprint=$1
  local token_expected_size=$2
  local token_expected_links=$3
  token_assert_archive_fingerprint \
    "$token_fingerprint" "$token_expected_size" "$token_expected_links" || return 1
  local token_device token_inode token_mode token_uid token_gid token_size
  local token_mtime token_ctime token_links
  IFS='|' read -r token_device token_inode token_mode token_uid token_gid token_size \
    token_mtime token_ctime token_links <<<"$token_fingerprint"
  [[ "$token_uid" == "$(/usr/bin/id -u)" && "$token_gid" == "$(/usr/bin/id -g)" ]] \
    || return 1
  case "$token_platform" in
    darwin-arm64) [[ "$token_mode" == 100400 ]] ;;
    linux-x64) [[ "$token_mode" == 8100 ]] ;;
  esac
}

token_run_clean() {
  /usr/bin/env -i \
    HOME=/nonexistent \
    LANG=C \
    LC_ALL=C \
    PATH=/usr/bin:/bin \
    TZ=UTC \
    "$@"
}

token_run_node() {
  token_run_clean "$token_pinned_node" "$@"
}

token_cleanup_node_stage() {
  local token_status=$?
  trap - EXIT
  if [[ -n "${token_node_stage:-}" ]]; then
    if [[ "${token_pinned_node_trusted:-false}" == true ]]; then
      if ! token_run_node \
        "$token_repo_root/scripts/toolchain-cleanup.mjs" \
        cleanup-bootstrap-stage \
        "$token_node_stage" \
        "$token_tools_root" \
        "$token_node_stage_device" \
        "$token_node_stage_inode" \
        "$token_node_stage_custody_sha256"; then
        printf 'TOOLCHAIN_BOOTSTRAP_STAGE_PRESERVED path=%s\n' "$token_node_stage" >&2
        token_status=1
      fi
    else
      printf 'TOOLCHAIN_BOOTSTRAP_STAGE_PRESERVED path=%s\n' "$token_node_stage" >&2
    fi
  fi
  exec 6<&- 7<&- 8<&- 9<&- 10<&- 11<&- 12<&-
  exit "$token_status"
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
    token_run_clean /usr/bin/curl \
      --fail --location --proto '=https' --show-error --output "$token_part" "$token_node_url"
    local token_actual_sha256
    token_actual_sha256=$(token_sha256 "$token_part")
    if [[ "$token_actual_sha256" != "$token_node_sha256" ]]; then
      printf 'TOOLCHAIN_CHECKSUM_MISMATCH tool=node expected=%s actual=%s partial=%s\n' \
        "$token_node_sha256" "$token_actual_sha256" "$token_part" >&2
      return 1
    fi
    mv "$token_part" "$token_archive_path"
  fi
  if [[ -L "$token_archive_path" ]]; then
    printf 'TOOLCHAIN_ARCHIVE_UNSAFE tool=node path=%s reason=symlink\n' "$token_archive_path" >&2
    return 1
  fi
  exec 7<"$token_archive_path"
  exec 8<"$token_archive_path"
  exec 9<"$token_archive_path"
  local token_archive_fingerprint
  local token_archive_copy_fingerprint
  local token_archive_post_fingerprint
  local token_archive_path_fingerprint
  if ! token_archive_fingerprint=$(token_descriptor_fingerprint 7) \
    || ! token_archive_copy_fingerprint=$(token_descriptor_fingerprint 8) \
    || ! token_archive_post_fingerprint=$(token_descriptor_fingerprint 9) \
    || ! token_archive_path_fingerprint=$(token_path_fingerprint "$token_archive_path") \
    || [[ "$token_archive_fingerprint" != "$token_archive_copy_fingerprint" ]] \
    || [[ "$token_archive_fingerprint" != "$token_archive_post_fingerprint" ]] \
    || [[ "$token_archive_fingerprint" != "$token_archive_path_fingerprint" ]]; then
    printf 'TOOLCHAIN_ARCHIVE_IDENTITY_CHANGED tool=node path=%s\n' \
      "$token_archive_path" >&2
    exec 7<&- 8<&- 9<&-
    return 1
  fi
  local token_archive_size
  token_archive_size=$(token_fingerprint_size "$token_archive_fingerprint")
  token_assert_archive_fingerprint "$token_archive_fingerprint" "$token_archive_size"
  local token_archive_sha256
  token_archive_sha256=$(token_sha256 /dev/fd/7)
  if [[ "$token_archive_sha256" != "$token_node_sha256" ]]; then
    printf 'TOOLCHAIN_CHECKSUM_MISMATCH tool=node expected=%s actual=%s path=%s\n' \
      "$token_node_sha256" "$token_archive_sha256" "$token_archive_path" >&2
    exec 7<&- 8<&- 9<&-
    return 1
  fi

  token_node_stage=$(/usr/bin/mktemp -d "$token_tools_root/.bootstrap-node-part.XXXXXX")
  /bin/mkdir -m 700 "$token_node_stage/payload"
  exec 6<"$token_node_stage"
  local token_node_stage_identity
  token_node_stage_identity=$(token_descriptor_fingerprint 6)
  token_node_stage_device=${token_node_stage_identity%%|*}
  local token_stage_remainder=${token_node_stage_identity#*|}
  token_node_stage_inode=${token_stage_remainder%%|*}
  trap token_cleanup_node_stage EXIT

  local token_snapshot_path="$token_node_stage/archive.snapshot"
  token_run_clean /bin/dd if=/dev/fd/8 of="$token_snapshot_path" bs=1048576
  token_run_clean /bin/chmod 400 "$token_snapshot_path"
  local token_archive_post_sha256
  local token_archive_final_fingerprint
  local token_archive_final_path_fingerprint
  token_archive_post_sha256=$(token_sha256 /dev/fd/9)
  if [[ "$token_archive_post_sha256" != "$token_node_sha256" ]] \
    || ! token_archive_final_fingerprint=$(token_descriptor_fingerprint 9) \
    || ! token_archive_final_path_fingerprint=$(token_path_fingerprint "$token_archive_path") \
    || [[ "$token_archive_final_fingerprint" != "$token_archive_fingerprint" ]] \
    || [[ "$token_archive_final_path_fingerprint" != "$token_archive_fingerprint" ]]; then
    printf 'TOOLCHAIN_ARCHIVE_SUBSTITUTED tool=node path=%s\n' \
      "$token_archive_path" >&2
    return 1
  fi
  exec 7<&- 8<&- 9<&-

  exec 10<"$token_snapshot_path"
  exec 11<"$token_snapshot_path"
  exec 12<"$token_snapshot_path"
  local token_snapshot_fingerprint
  local token_snapshot_extract_fingerprint
  local token_snapshot_post_fingerprint
  local token_snapshot_path_fingerprint
  token_snapshot_fingerprint=$(token_descriptor_fingerprint 10)
  token_snapshot_extract_fingerprint=$(token_descriptor_fingerprint 11)
  token_snapshot_post_fingerprint=$(token_descriptor_fingerprint 12)
  token_snapshot_path_fingerprint=$(token_path_fingerprint "$token_snapshot_path")
  if [[ "$token_snapshot_fingerprint" != "$token_snapshot_extract_fingerprint" ]] \
    || [[ "$token_snapshot_fingerprint" != "$token_snapshot_post_fingerprint" ]] \
    || [[ "$token_snapshot_fingerprint" != "$token_snapshot_path_fingerprint" ]] \
    || ! token_assert_private_snapshot_fingerprint \
      "$token_snapshot_fingerprint" "$token_archive_size" 1; then
    printf 'TOOLCHAIN_ARCHIVE_SNAPSHOT_UNSAFE tool=node path=%s\n' \
      "$token_snapshot_path" >&2
    return 1
  fi
  local token_snapshot_sha256
  token_snapshot_sha256=$(token_sha256 /dev/fd/10)
  if [[ "$token_snapshot_sha256" != "$token_node_sha256" ]]; then
    printf 'TOOLCHAIN_CHECKSUM_MISMATCH tool=node expected=%s actual=%s snapshot=private\n' \
      "$token_node_sha256" "$token_snapshot_sha256" >&2
    return 1
  fi

  local token_snapshot_pre_unlink_fingerprint
  local token_snapshot_pre_unlink_extract_fingerprint
  local token_snapshot_pre_unlink_post_fingerprint
  local token_snapshot_pre_unlink_path_fingerprint
  if ! token_snapshot_pre_unlink_fingerprint=$(token_descriptor_fingerprint 10) \
    || ! token_snapshot_pre_unlink_extract_fingerprint=$(token_descriptor_fingerprint 11) \
    || ! token_snapshot_pre_unlink_post_fingerprint=$(token_descriptor_fingerprint 12) \
    || ! token_snapshot_pre_unlink_path_fingerprint=$(token_path_fingerprint "$token_snapshot_path") \
    || [[ "$token_snapshot_pre_unlink_fingerprint" != "$token_snapshot_fingerprint" ]] \
    || [[ "$token_snapshot_pre_unlink_extract_fingerprint" != "$token_snapshot_fingerprint" ]] \
    || [[ "$token_snapshot_pre_unlink_post_fingerprint" != "$token_snapshot_fingerprint" ]] \
    || [[ "$token_snapshot_pre_unlink_path_fingerprint" != "$token_snapshot_fingerprint" ]]; then
    printf 'TOOLCHAIN_ARCHIVE_SNAPSHOT_SUBSTITUTED tool=node phase=before-unlink\n' >&2
    return 1
  fi
  /bin/rm -f -- "$token_snapshot_path"

  local token_snapshot_held_fingerprint
  local token_snapshot_held_extract_fingerprint
  local token_snapshot_held_post_fingerprint
  token_snapshot_held_fingerprint=$(token_descriptor_fingerprint 10)
  token_snapshot_held_extract_fingerprint=$(token_descriptor_fingerprint 11)
  token_snapshot_held_post_fingerprint=$(token_descriptor_fingerprint 12)
  if [[ "$token_snapshot_held_fingerprint" != "$token_snapshot_held_extract_fingerprint" ]] \
    || [[ "$token_snapshot_held_fingerprint" != "$token_snapshot_held_post_fingerprint" ]] \
    || [[ "$(token_fingerprint_inode_key "$token_snapshot_held_fingerprint")" \
      != "$(token_fingerprint_inode_key "$token_snapshot_fingerprint")" ]] \
    || ! token_assert_private_snapshot_fingerprint \
      "$token_snapshot_held_fingerprint" "$token_archive_size" 0; then
    printf 'TOOLCHAIN_ARCHIVE_SNAPSHOT_NOT_PRIVATE tool=node phase=before-extraction\n' >&2
    return 1
  fi

  token_run_clean /usr/bin/tar --no-same-owner --no-same-permissions \
    "$token_node_tar_flag" /dev/fd/11 -C "$token_node_stage/payload"
  local token_final_snapshot_fingerprint
  local token_final_snapshot_extract_fingerprint
  local token_final_snapshot_post_fingerprint
  local token_post_extract_snapshot_sha256
  token_post_extract_snapshot_sha256=$(token_sha256 /dev/fd/12)
  if [[ "$token_post_extract_snapshot_sha256" != "$token_node_sha256" ]] \
    || ! token_final_snapshot_fingerprint=$(token_descriptor_fingerprint 10) \
    || ! token_final_snapshot_extract_fingerprint=$(token_descriptor_fingerprint 11) \
    || ! token_final_snapshot_post_fingerprint=$(token_descriptor_fingerprint 12) \
    || [[ "$token_final_snapshot_fingerprint" != "$token_snapshot_held_fingerprint" ]] \
    || [[ "$token_final_snapshot_extract_fingerprint" != "$token_snapshot_held_fingerprint" ]] \
    || [[ "$token_final_snapshot_post_fingerprint" != "$token_snapshot_held_fingerprint" ]] \
    || ! token_assert_private_snapshot_fingerprint \
      "$token_final_snapshot_fingerprint" "$token_archive_size" 0; then
    printf 'TOOLCHAIN_ARCHIVE_SNAPSHOT_SUBSTITUTED tool=node phase=after-extraction\n' >&2
    return 1
  fi
  exec 10<&- 11<&- 12<&-
  token_pinned_node="$token_node_stage/payload/$token_node_directory/bin/node"
  token_node_stage_custody_sha256=$(token_run_node \
    "$token_repo_root/scripts/toolchain-cleanup.mjs" \
    capture-bootstrap-stage-custody \
    "$token_node_stage" \
    "$token_tools_root" \
    "$token_node_stage_device" \
    "$token_node_stage_inode")
  [[ "$token_node_stage_custody_sha256" =~ ^[a-f0-9]{64}$ ]]
  token_pinned_node_trusted=true
  [[ "$(token_run_node --version)" == v24.20.0 ]]
}

case "$token_mode" in
  fetch)
    token_prepare_pinned_node true
    token_run_node "$token_repo_root/scripts/toolchain.mjs" fetch "${@:2}"
    ;;
  install)
    token_prepare_pinned_node false
    token_run_node "$token_repo_root/scripts/toolchain.mjs" install "${@:2}"
    ;;
  verify)
    token_prepare_pinned_node false
    token_run_node "$token_repo_root/scripts/toolchain.mjs" verify "${@:2}"
    ;;
  doctor)
    token_prepare_pinned_node false
    token_run_node "$token_repo_root/scripts/toolchain.mjs" verify --offline
    token_run_node "$token_repo_root/scripts/doctor.mjs" "${@:2}"
    ;;
  all)
    token_prepare_pinned_node true
    token_run_node "$token_repo_root/scripts/toolchain.mjs" fetch
    token_run_node "$token_repo_root/scripts/toolchain.mjs" install --offline
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
