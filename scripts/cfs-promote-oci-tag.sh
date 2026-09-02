#!/bin/sh

set -eu

if [ "$#" -ne 5 ]; then
    echo "usage: cfs-promote-oci-tag.sh IMAGE VERSION_TAG SHA_TAG CANDIDATE_DIGEST EVIDENCE_DIR" >&2
    exit 64
fi

image="$1"
version_tag="$2"
sha_tag="$3"
candidate_digest="$4"
evidence_dir="$5"
regctl_bin="${CFS_REGCTL_BIN:-}"
write_trace="${CFS_OCI_WRITE_TRACE:-}"
formal_writes=0

valid_digest() {
    value="$1"
    [ "${#value}" -eq 71 ] &&
        printf '%s' "$value" | LC_ALL=C grep -Eq '^sha256:[0-9a-f]{64}$'
}

valid_tag() {
    value="$1"
    [ -n "$value" ] &&
        [ "${#value}" -le 128 ] &&
        printf '%s' "$value" | LC_ALL=C grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
}

if ! valid_digest "$candidate_digest"; then
    echo "invalid candidate digest" >&2
    exit 64
fi
if ! valid_tag "$version_tag" || ! valid_tag "$sha_tag" || [ "$version_tag" = "$sha_tag" ]; then
    echo "invalid or duplicate formal tag" >&2
    exit 64
fi
if [ -z "${CFS_OCI_INSPECT_OVERRIDE:-}" ]; then
    case "$regctl_bin" in
        /*) ;;
        *)
            echo "CFS_REGCTL_BIN must be an absolute executable path" >&2
            exit 64
            ;;
    esac
    if [ ! -x "$regctl_bin" ]; then
        echo "pinned OCI inspector is unavailable" >&2
        exit 64
    fi
fi

mkdir -p "$evidence_dir"

INSPECT_STATE=""
INSPECT_DIGEST=""

inspect_tag() {
    label="$1"
    tag="$2"
    ref="$image:$tag"
    stdout_file="$evidence_dir/.inspect-$label.stdout"
    stderr_file="$evidence_dir/.inspect-$label.stderr"
    state_file="$evidence_dir/OCI-INSPECT-$label.json"
    registry_host="${image%%/*}"
    rc=0

    rm -f "$stdout_file" "$stderr_file"

    if [ -n "${CFS_OCI_INSPECT_OVERRIDE:-}" ]; then
        if "$CFS_OCI_INSPECT_OVERRIDE" "$ref" >"$stdout_file" 2>"$stderr_file"; then
            rc=0
        else
            rc=$?
        fi
    else
        case "$registry_host" in
            localhost:* | 127.0.0.1:*)
                if "$regctl_bin" manifest head \
                    --host "reg=$registry_host,tls=disabled" "$ref" \
                    >"$stdout_file" 2>"$stderr_file"; then
                    rc=0
                else
                    rc=$?
                fi
                ;;
            *)
                if "$regctl_bin" manifest head "$ref" \
                    >"$stdout_file" 2>"$stderr_file"; then
                    rc=0
                else
                    rc=$?
                fi
                ;;
        esac
    fi

    INSPECT_STATE=""
    INSPECT_DIGEST=""

    if [ "$rc" -eq 0 ]; then
        line_count="$(awk 'END { print NR }' "$stdout_file")"
        digest="$(sed -n '1p' "$stdout_file")"
        if [ "$line_count" -ne 1 ] || ! valid_digest "$digest"; then
            INSPECT_STATE="ERROR"
            echo "OCI inspector returned an invalid digest for $label" >&2
        else
            INSPECT_STATE="EXISTS"
            INSPECT_DIGEST="$digest"
        fi
    elif grep -Eiq \
        '(^|[^[:alnum:]_])MANIFEST_UNKNOWN([^[:alnum:]_]|$)|manifest unknown|HTTP(/[0-9.]+)?[[:space:]]+404([[:space:]]|$)|status([=:]|[[:space:]])+404([[:space:]]|$)' \
        "$stderr_file"; then
        INSPECT_STATE="DEFINITELY_NOT_FOUND"
    else
        INSPECT_STATE="ERROR"
        echo "OCI inspector failed without an explicit manifest-not-found result for $label" >&2
        case "$registry_host" in
            localhost:* | 127.0.0.1:*)
                if [ "${CFS_OCI_DEBUG_LOCAL_INSPECT:-0}" = "1" ]; then
                    printf 'CFS_LOCAL_INSPECT_ERROR rc=%s message=' "$rc" >&2
                    sed -n '1p' "$stderr_file" >&2
                fi
                ;;
        esac
    fi

    jq -n \
        --arg ref "$ref" \
        --arg state "$INSPECT_STATE" \
        --arg digest "$INSPECT_DIGEST" \
        '{
          ref: $ref,
          state: $state,
          digest: (if $digest == "" then null else $digest end),
          credential_values_logged: false
        }' >"$state_file"

    rm -f "$stdout_file" "$stderr_file"

    [ "$INSPECT_STATE" != "ERROR" ]
}

RAW_DIGEST=""

verify_raw_manifest() {
    label="$1"
    tag="$2"
    raw_file="$evidence_dir/OCI-MANIFEST-$label.json"

    docker buildx imagetools inspect --raw "$image:$tag" >"$raw_file"
    RAW_DIGEST="sha256:$(sha256sum "$raw_file" | cut -d' ' -f1)"
    if ! valid_digest "$RAW_DIGEST" || [ "$RAW_DIGEST" != "$candidate_digest" ]; then
        echo "raw manifest digest mismatch for $label" >&2
        exit 42
    fi
}

record_existing_tag() {
    label="$1"
    tag="$2"
    metadata_file="$evidence_dir/OCI-PROMOTION-$label-METADATA.json"

    verify_raw_manifest "$label" "$tag"
    jq -n \
        --arg digest "$RAW_DIGEST" \
        '{
          "containerimage.descriptor": {digest: $digest},
          cfs: {created: false, idempotent: true}
        }' >"$metadata_file"
}

promote_missing_tag() {
    label="$1"
    tag="$2"
    metadata_file="$evidence_dir/OCI-PROMOTION-$label-METADATA.json"

    if [ -n "$write_trace" ]; then
        printf '%s\n' "$label" >>"$write_trace"
    fi

    docker buildx imagetools create \
        --prefer-index=false \
        --metadata-file "$metadata_file" \
        --tag "$image:$tag" \
        "$image@$candidate_digest"

    metadata_line_count="$(jq -r '."containerimage.descriptor".digest // empty' "$metadata_file" | awk 'END { print NR }')"
    metadata_digest="$(jq -r '."containerimage.descriptor".digest // empty' "$metadata_file")"
    if [ "$metadata_line_count" -ne 1 ] ||
        ! valid_digest "$metadata_digest" ||
        [ "$metadata_digest" != "$candidate_digest" ]; then
        echo "promotion metadata digest mismatch for $label" >&2
        exit 42
    fi

    verify_raw_manifest "$label" "$tag"
    formal_writes=$((formal_writes + 1))
}

if ! inspect_tag "SHA" "$sha_tag"; then
    echo "formal tag pair preflight failed before writes" >&2
    exit 70
fi
sha_state="$INSPECT_STATE"
sha_digest="$INSPECT_DIGEST"

if ! inspect_tag "VERSION" "$version_tag"; then
    echo "formal tag pair preflight failed before writes" >&2
    exit 70
fi
version_state="$INSPECT_STATE"
version_digest="$INSPECT_DIGEST"

printf 'CFS_OCI_PAIR_PREFLIGHT pair_preflight=true sha_state=%s version_state=%s formal_tag_writes=0\n' \
    "$sha_state" "$version_state"

if [ "$sha_state" = "EXISTS" ] && [ "$sha_digest" != "$candidate_digest" ]; then
    echo "refusing pair promotion: sha tag points to a different digest" >&2
    exit 42
fi
if [ "$version_state" = "EXISTS" ] && [ "$version_digest" != "$candidate_digest" ]; then
    echo "refusing pair promotion: version tag points to a different digest" >&2
    exit 42
fi

if [ "$sha_state" = "EXISTS" ]; then
    record_existing_tag "SHA" "$sha_tag"
fi
if [ "$version_state" = "EXISTS" ]; then
    record_existing_tag "TAG" "$version_tag"
fi

if [ "$sha_state" = "DEFINITELY_NOT_FOUND" ]; then
    promote_missing_tag "SHA" "$sha_tag"
fi

if [ "${CFS_OCI_FAIL_BEFORE_VERSION_WRITE:-0}" = "1" ] &&
    [ "$version_state" = "DEFINITELY_NOT_FOUND" ]; then
    echo "injected failure before version tag write" >&2
    exit 75
fi

if [ "$version_state" = "DEFINITELY_NOT_FOUND" ]; then
    promote_missing_tag "TAG" "$version_tag"
fi

jq -n \
    --arg candidate_digest "$candidate_digest" \
    --arg sha_state "$sha_state" \
    --arg version_state "$version_state" \
    --argjson formal_writes "$formal_writes" \
    '{
      pair_preflight: true,
      candidate_digest: $candidate_digest,
      sha_state: $sha_state,
      version_state: $version_state,
      formal_writes: $formal_writes,
      sha_first: true,
      version_last: true,
      inspect_error_fail_closed: true,
      malformed_digest_rejected: true,
      partial_version_tag: false
    }' >"$evidence_dir/OCI-PROMOTION-SUMMARY.json"

printf 'CFS_OCI_PAIR_PROMOTION_PASS pair_preflight=true sha_first=true version_last=true inspect_error_fail_closed=true malformed_digest_rejected=true partial_version_tag=false formal_writes=%s\n' \
    "$formal_writes"
