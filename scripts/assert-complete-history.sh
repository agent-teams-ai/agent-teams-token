#!/usr/bin/env bash
set -euo pipefail

rollback_expected_sha=${1:?expected commit SHA is required}
rollback_baseline_sha=${2:?baseline commit SHA is required}
rollback_git=/usr/bin/git

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

rollback_git_canonical() {
  /usr/bin/env \
    -u GIT_DIR \
    -u GIT_WORK_TREE \
    -u GIT_COMMON_DIR \
    -u GIT_OBJECT_DIRECTORY \
    -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
    -u GIT_NAMESPACE \
    -u GIT_REPLACE_REF_BASE \
    GIT_NO_REPLACE_OBJECTS=1 \
    "$rollback_git" "$@"
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
