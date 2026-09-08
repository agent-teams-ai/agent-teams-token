#!/bin/bash
set -euo pipefail

# CI invokes this after env.sh restricts PATH to pinned tool directories.
rollback_expected_sha=${1:?expected commit SHA is required}
rollback_baseline_sha=${2:?baseline commit SHA is required}
rollback_git=/usr/bin/git
rollback_safe_directory=$(pwd -P)

rollback_sha256() {
  if [[ -x /usr/bin/sha256sum ]]; then
    /usr/bin/sha256sum "$1" | /usr/bin/awk '{print $1}'
  elif [[ -x /usr/bin/shasum ]]; then
    /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
  else
    printf 'ROLLBACK_SHA256_UNAVAILABLE\n' >&2
    return 1
  fi
}

rollback_sha256_stdin() {
  if [[ -x /usr/bin/sha256sum ]]; then
    /usr/bin/sha256sum | /usr/bin/awk '{print $1}'
  elif [[ -x /usr/bin/shasum ]]; then
    /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}'
  else
    printf 'ROLLBACK_SHA256_UNAVAILABLE\n' >&2
    return 1
  fi
}

if [[ "${GIT_ALTERNATE_OBJECT_DIRECTORIES+x}" == x ]]; then
  printf 'ROLLBACK_HISTORY_ALTERNATES_FORBIDDEN source=environment\n' >&2
  exit 1
fi

rollback_git_inspect() {
  /usr/bin/env \
    -i \
    HOME=/nonexistent \
    LANG=C \
    LC_ALL=C \
    PATH=/usr/bin:/bin \
    GCM_INTERACTIVE=never \
    GIT_ASKPASS=/bin/false \
    GIT_CONFIG_COUNT=0 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_NO_REPLACE_OBJECTS=1 \
    GIT_SSH_COMMAND=/bin/false \
    GIT_TERMINAL_PROMPT=0 \
    SSH_ASKPASS=/bin/false \
    "$rollback_git" \
    -c core.fsmonitor=false \
    -c core.hooksPath=/dev/null \
    -c core.attributesFile=/dev/null \
    -c credential.helper= \
    -c credential.interactive=never \
    -c "safe.directory=$rollback_safe_directory" \
    "$@"
}

rollback_assert_git_authority() {
  local rollback_key rollback_record rollback_value rollback_config_file
  rollback_config_file=$(/usr/bin/mktemp /tmp/agtmai-git-config.XXXXXX) || return 1
  if ! rollback_git_inspect config --local --no-includes --null --list >"$rollback_config_file"; then
    /bin/rm -f -- "$rollback_config_file"
    printf 'ROLLBACK_GIT_LOCAL_CONFIG_UNAVAILABLE\n' >&2
    return 1
  fi
  while IFS= read -r -d '' rollback_record; do
    rollback_key=${rollback_record%%$'\n'*}
    rollback_value=${rollback_record#*$'\n'}
    case "$rollback_key" in
      gc.auto)
        # actions/checkout v7.0.1 disables automatic GC; admit only literal 0.
        if [[ "$rollback_value" == 0 ]]; then continue; fi
        /bin/rm -f -- "$rollback_config_file"
        printf 'ROLLBACK_GIT_LOCAL_CONFIG_FORBIDDEN key=%s\n' "$rollback_key" >&2
        return 1
        ;;
      core.repositoryformatversion|core.filemode|core.bare|core.logallrefupdates|\
      core.ignorecase|core.precomposeunicode|user.name|user.email)
        ;;
      remote.*.url|remote.*.fetch|branch.*.remote|branch.*.merge)
        ;;
      *)
        /bin/rm -f -- "$rollback_config_file"
        printf 'ROLLBACK_GIT_LOCAL_CONFIG_FORBIDDEN key=%s\n' "$rollback_key" >&2
        return 1
        ;;
    esac
  done <"$rollback_config_file"
  /bin/rm -f -- "$rollback_config_file"

  local rollback_common_directory
  rollback_common_directory=$(rollback_git_inspect rev-parse --path-format=absolute --git-common-dir)
  local rollback_git_directory
  rollback_git_directory=$(rollback_git_inspect rev-parse --path-format=absolute --git-dir)
  if [[ -e "$rollback_git_directory/config.worktree" || -L "$rollback_git_directory/config.worktree" ]]; then
    printf 'ROLLBACK_GIT_WORKTREE_CONFIG_FORBIDDEN\n' >&2
    return 1
  fi
  local rollback_path rollback_name
  if [[ -d "$rollback_common_directory/hooks" ]]; then
    for rollback_path in "$rollback_common_directory/hooks"/*; do
      [[ -e "$rollback_path" || -L "$rollback_path" ]] || continue
      rollback_name=${rollback_path##*/}
      if [[ "$rollback_name" != *.sample || ! -f "$rollback_path" || -L "$rollback_path" ]]; then
        printf 'ROLLBACK_GIT_HOOK_FORBIDDEN name=%s\n' "$rollback_name" >&2
        return 1
      fi
    done
  fi
  if [[ -d "$rollback_common_directory/info" ]]; then
    for rollback_path in "$rollback_common_directory/info"/*; do
      [[ -e "$rollback_path" || -L "$rollback_path" ]] || continue
      rollback_name=${rollback_path##*/}
      if [[ "$rollback_name" != exclude || ! -f "$rollback_path" || -L "$rollback_path" ]]; then
        printf 'ROLLBACK_GIT_INFO_AUTHORITY_FORBIDDEN name=%s\n' "$rollback_name" >&2
        return 1
      fi
    done
  fi
}

rollback_git_canonical() {
  rollback_assert_git_authority
  rollback_git_inspect "$@"
}

if [[ ! -x "$rollback_git" ]]; then
  printf 'ROLLBACK_HISTORY_GIT_UNAVAILABLE path=%s\n' "$rollback_git" >&2
  exit 1
fi

if [[ ! "$rollback_expected_sha" =~ ^[a-f0-9]{40}$ ]] \
  || [[ ! "$rollback_baseline_sha" =~ ^[a-f0-9]{40}$ ]]; then
  printf 'ROLLBACK_HISTORY_SHA_INVALID expected=%s baseline=%s\n' \
    "$rollback_expected_sha" "$rollback_baseline_sha" >&2
  exit 1
fi

rollback_replacements=$(rollback_git_canonical for-each-ref --format='%(refname)' refs/replace/)
if [[ -n "$rollback_replacements" ]]; then
  printf 'ROLLBACK_HISTORY_REPLACEMENT_FORBIDDEN\n' >&2
  exit 1
fi

rollback_common_dir=$(rollback_git_canonical rev-parse --path-format=absolute --git-common-dir)
rollback_grafts="$rollback_common_dir/info/grafts"
if [[ -e "$rollback_grafts" || -L "$rollback_grafts" ]]; then
  printf 'ROLLBACK_HISTORY_GRAFTS_FORBIDDEN path=%s\n' "$rollback_grafts" >&2
  exit 1
fi

rollback_alternates="$rollback_common_dir/objects/info/alternates"
if [[ -e "$rollback_alternates" || -L "$rollback_alternates" ]]; then
  printf 'ROLLBACK_HISTORY_ALTERNATES_FORBIDDEN source=file path=%s\n' \
    "$rollback_alternates" >&2
  exit 1
fi

rollback_shallow=$(rollback_git_canonical rev-parse --is-shallow-repository)
if [[ "$rollback_shallow" != false ]]; then
  printf 'ROLLBACK_HISTORY_SHALLOW expected=false actual=%s\n' "$rollback_shallow" >&2
  exit 1
fi

if rollback_git_canonical config --get extensions.partialClone >/dev/null \
  || rollback_git_canonical config --get-regexp '^remote\..*\.promisor$' >/dev/null; then
  printf 'ROLLBACK_HISTORY_PARTIAL_CLONE_FORBIDDEN\n' >&2
  exit 1
fi

rollback_actual_sha=$(rollback_git_canonical rev-parse --verify 'HEAD^{commit}')
if [[ "$rollback_actual_sha" != "$rollback_expected_sha" ]]; then
  printf 'ROLLBACK_HISTORY_HEAD_MISMATCH expected=%s actual=%s\n' \
    "$rollback_expected_sha" "$rollback_actual_sha" >&2
  exit 1
fi

if ! rollback_git_canonical cat-file -e "$rollback_baseline_sha^{commit}" 2>/dev/null; then
  printf 'ROLLBACK_HISTORY_BASELINE_UNAVAILABLE baseline=%s\n' \
    "$rollback_baseline_sha" >&2
  exit 1
fi

if ! rollback_git_canonical merge-base --is-ancestor "$rollback_baseline_sha" "$rollback_expected_sha"; then
  printf 'ROLLBACK_HISTORY_BASELINE_NOT_ANCESTOR baseline=%s head=%s\n' \
    "$rollback_baseline_sha" "$rollback_expected_sha" >&2
  exit 1
fi

# A non-shallow flag is insufficient for a partial or corrupt object graph.
# Traverse and fsck every object reachable from the exact candidate head.
rollback_git_canonical rev-list --objects "$rollback_expected_sha" >/dev/null
rollback_git_canonical fsck --strict --no-dangling "$rollback_expected_sha" >/dev/null

# Bind every tracked path's type, executable mode and bytes to the validated
# candidate tree before this verifier returns control to any checkout-provided
# bootstrap, cache or workspace executable.
rollback_inventory_file=$(/usr/bin/mktemp /tmp/agtmai-candidate-inventory.XXXXXX)
trap '/bin/rm -f -- "$rollback_inventory_file"' EXIT
rollback_inventory_count=0
while IFS= read -r -d '' rollback_record; do
  rollback_header=${rollback_record%%$'\t'*}
  rollback_path=${rollback_record#*$'\t'}
  if [[ "$rollback_header" == "$rollback_record" ]] || [[ -z "$rollback_path" ]]; then
    printf 'ROLLBACK_INVENTORY_RECORD_INVALID\n' >&2
    exit 1
  fi
  read -r rollback_mode rollback_type rollback_oid <<<"$rollback_header"
  if [[ "$rollback_type" != blob ]] \
    || [[ ! "$rollback_mode" =~ ^(100644|100755|120000)$ ]] \
    || [[ ! "$rollback_oid" =~ ^[a-f0-9]{40}$ ]]; then
    printf 'ROLLBACK_INVENTORY_ENTRY_UNSUPPORTED pathSha256=%s\n' \
      "$(printf '%s' "$rollback_path" | rollback_sha256_stdin)" >&2
    exit 1
  fi
  if [[ ! -e "$rollback_path" && ! -L "$rollback_path" ]]; then
    printf 'ROLLBACK_INVENTORY_PATH_MISSING pathSha256=%s\n' \
      "$(printf '%s' "$rollback_path" | rollback_sha256_stdin)" >&2
    exit 1
  fi
  case "$rollback_mode" in
    120000)
      [[ -L "$rollback_path" ]] || {
        printf 'ROLLBACK_INVENTORY_TYPE_MISMATCH pathSha256=%s\n' \
          "$(printf '%s' "$rollback_path" | rollback_sha256_stdin)" >&2
        exit 1
      }
      ;;
    100755)
      [[ -f "$rollback_path" && ! -L "$rollback_path" && -x "$rollback_path" ]] || {
        printf 'ROLLBACK_INVENTORY_MODE_MISMATCH pathSha256=%s\n' \
          "$(printf '%s' "$rollback_path" | rollback_sha256_stdin)" >&2
        exit 1
      }
      ;;
    100644)
      [[ -f "$rollback_path" && ! -L "$rollback_path" && ! -x "$rollback_path" ]] || {
        printf 'ROLLBACK_INVENTORY_MODE_MISMATCH pathSha256=%s\n' \
          "$(printf '%s' "$rollback_path" | rollback_sha256_stdin)" >&2
        exit 1
      }
      ;;
  esac
  rollback_actual_oid=$(rollback_git_canonical hash-object --no-filters -- "$rollback_path")
  if [[ "$rollback_actual_oid" != "$rollback_oid" ]]; then
    printf 'ROLLBACK_INVENTORY_BYTES_MISMATCH pathSha256=%s expected=%s actual=%s\n' \
      "$(printf '%s' "$rollback_path" | rollback_sha256_stdin)" \
      "$rollback_oid" "$rollback_actual_oid" >&2
    exit 1
  fi
  printf '%s\0' "$rollback_record" >>"$rollback_inventory_file"
  rollback_inventory_count=$((rollback_inventory_count + 1))
done < <(rollback_git_canonical ls-tree -rz --full-tree "$rollback_expected_sha")

if [[ "$rollback_inventory_count" -le 0 ]]; then
  printf 'ROLLBACK_INVENTORY_EMPTY\n' >&2
  exit 1
fi
rollback_inventory_sha256=$(rollback_sha256 "$rollback_inventory_file")

printf 'ROLLBACK_HISTORY_OK head=%s baseline=%s shallow=false partial=false inventoryEntries=%s inventorySha256=%s\n' \
  "$rollback_expected_sha" "$rollback_baseline_sha" "$rollback_inventory_count" "$rollback_inventory_sha256"
