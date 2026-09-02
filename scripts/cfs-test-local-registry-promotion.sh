#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: cfs-test-local-registry-promotion.sh LOCAL_IMAGE" >&2
    exit 64
fi
if [ -z "${CFS_REGCTL_BIN:-}" ] || [ ! -x "$CFS_REGCTL_BIN" ]; then
    echo "pinned regctl inspector is required" >&2
    exit 64
fi

local_image="$1"
registry_image="docker.io/library/registry:2@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278"
run_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"
container_name="cfs-oci-r2-registry-$run_suffix"
repository_prefix="127.0.0.1:5000/cfs-oci-r2-$run_suffix"
version_tag="cfs-test-v1"
sha_tag="sha-test-source"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
work_dir="$(mktemp -d)"

cleanup() {
    docker rm -f "$container_name" >/dev/null 2>&1 || true
    docker image ls --format '{{.Repository}}:{{.Tag}}' |
        grep "^$repository_prefix-" |
        xargs -r docker image rm -f >/dev/null 2>&1 || true
    rm -rf "$work_dir"
}
trap cleanup EXIT

valid_digest() {
    value="$1"
    [ "${#value}" -eq 71 ] &&
        printf '%s' "$value" | LC_ALL=C grep -Eq '^sha256:[0-9a-f]{64}$'
}

manifest_digest() {
    ref="$1"
    output="$2"
    docker buildx imagetools inspect --raw "$ref" >"$output"
    digest="sha256:$(sha256sum "$output" | cut -d' ' -f1)"
    valid_digest "$digest"
    printf '%s\n' "$digest"
}

seed_candidate() {
    repository="$1"
    tag="$2"
    source_image="$3"
    output="$4"
    ref="$repository:$tag"
    docker tag "$source_image" "$ref"
    docker push "$ref" >/dev/null
    manifest_digest "$ref" "$output"
}

tag_exists() {
    repository="$1"
    tag="$2"
    result_file="$work_dir/tags-$(printf '%s-%s' "$repository" "$tag" | tr '/:' '__').json"
    code="$(curl --silent --show-error --output "$result_file" --write-out '%{http_code}'         "http://127.0.0.1:5000/v2/${repository#127.0.0.1:5000/}/tags/list")"
    case "$code" in
        200)
            jq -e --arg tag "$tag" '.tags != null and (.tags | index($tag)) != null' \
                "$result_file" >/dev/null
            ;;
        404)
            return 1
            ;;
        *)
            echo "unexpected local Registry tags response: $code" >&2
            exit 1
            ;;
    esac
}

assert_tag_absent() {
    repository="$1"
    tag="$2"
    if tag_exists "$repository" "$tag"; then
        echo "unexpected tag exists: $repository:$tag" >&2
        exit 1
    fi
}

assert_tag_digest() {
    repository="$1"
    tag="$2"
    expected="$3"
    output="$4"
    actual="$(manifest_digest "$repository:$tag" "$output")"
    test "$actual" = "$expected"
}

docker run --detach --name "$container_name" --publish 127.0.0.1:5000:5000 "$registry_image" >/dev/null
ready=false
for _ in $(seq 1 30); do
    if curl --fail --silent http://127.0.0.1:5000/v2/ >/dev/null; then
        ready=true
        break
    fi
    sleep 1
done
test "$ready" = true
export CFS_OCI_DEBUG_LOCAL_INSPECT=1

# A: both formal tags are absent. SHA must be written first and version last.
repo_a="$repository_prefix-a"
candidate_a_digest="$(seed_candidate "$repo_a" candidate-a "$local_image" "$work_dir/a-candidate.json")"
trace_a="$work_dir/a-write-trace.txt"
CFS_OCI_WRITE_TRACE="$trace_a" sh "$script_dir/cfs-promote-oci-tag.sh" \
    "$repo_a" "$version_tag" "$sha_tag" "$candidate_a_digest" "$work_dir/a-evidence"
test "$(sed -n '1p' "$trace_a")" = "SHA"
test "$(sed -n '2p' "$trace_a")" = "TAG"
test "$(awk 'END { print NR }' "$trace_a")" -eq 2
assert_tag_digest "$repo_a" "$sha_tag" "$candidate_a_digest" "$work_dir/a-sha.json"
assert_tag_digest "$repo_a" "$version_tag" "$candidate_a_digest" "$work_dir/a-version.json"

# B: both formal tags already exist at the candidate digest. No writes are allowed.
trace_b="$work_dir/b-write-trace.txt"
CFS_OCI_WRITE_TRACE="$trace_b" sh "$script_dir/cfs-promote-oci-tag.sh" \
    "$repo_a" "$version_tag" "$sha_tag" "$candidate_a_digest" "$work_dir/b-evidence"
test ! -s "$trace_b"
assert_tag_digest "$repo_a" "$sha_tag" "$candidate_a_digest" "$work_dir/b-sha.json"
assert_tag_digest "$repo_a" "$version_tag" "$candidate_a_digest" "$work_dir/b-version.json"

# C: SHA exists at a different digest and version is absent. Pair preflight must write nothing.
repo_c="$repository_prefix-c"
candidate_c_digest="$(seed_candidate "$repo_c" candidate-a "$local_image" "$work_dir/c-candidate-a.json")"
different_c_digest="$(seed_candidate "$repo_c" candidate-b "$registry_image" "$work_dir/c-candidate-b.json")"
docker buildx imagetools create --prefer-index=false --tag "$repo_c:$sha_tag" "$repo_c@$different_c_digest"
trace_c="$work_dir/c-write-trace.txt"
if CFS_OCI_WRITE_TRACE="$trace_c" sh "$script_dir/cfs-promote-oci-tag.sh" \
    "$repo_c" "$version_tag" "$sha_tag" "$candidate_c_digest" "$work_dir/c-evidence"; then
    echo "mismatched SHA tag was not rejected" >&2
    exit 1
fi
test ! -s "$trace_c"
assert_tag_absent "$repo_c" "$version_tag"
assert_tag_digest "$repo_c" "$sha_tag" "$different_c_digest" "$work_dir/c-sha.json"

# D: version exists at a different digest and SHA is absent. Pair preflight must write nothing.
repo_d="$repository_prefix-d"
candidate_d_digest="$(seed_candidate "$repo_d" candidate-a "$local_image" "$work_dir/d-candidate-a.json")"
different_d_digest="$(seed_candidate "$repo_d" candidate-b "$registry_image" "$work_dir/d-candidate-b.json")"
docker buildx imagetools create --prefer-index=false --tag "$repo_d:$version_tag" "$repo_d@$different_d_digest"
trace_d="$work_dir/d-write-trace.txt"
if CFS_OCI_WRITE_TRACE="$trace_d" sh "$script_dir/cfs-promote-oci-tag.sh" \
    "$repo_d" "$version_tag" "$sha_tag" "$candidate_d_digest" "$work_dir/d-evidence"; then
    echo "mismatched version tag was not rejected" >&2
    exit 1
fi
test ! -s "$trace_d"
assert_tag_absent "$repo_d" "$sha_tag"
assert_tag_digest "$repo_d" "$version_tag" "$different_d_digest" "$work_dir/d-version.json"

# E: SHA can be created, but an injected failure must occur before any version write.
repo_e="$repository_prefix-e"
candidate_e_digest="$(seed_candidate "$repo_e" candidate-a "$local_image" "$work_dir/e-candidate.json")"
trace_e="$work_dir/e-write-trace.txt"
if CFS_OCI_WRITE_TRACE="$trace_e" CFS_OCI_FAIL_BEFORE_VERSION_WRITE=1 \
    sh "$script_dir/cfs-promote-oci-tag.sh" \
    "$repo_e" "$version_tag" "$sha_tag" "$candidate_e_digest" "$work_dir/e-evidence"; then
    echo "injected pre-version failure did not stop promotion" >&2
    exit 1
fi
test "$(cat "$trace_e")" = "SHA"
assert_tag_digest "$repo_e" "$sha_tag" "$candidate_e_digest" "$work_dir/e-sha.json"
assert_tag_absent "$repo_e" "$version_tag"

# F: a non-not-found inspect error must fail before every formal write.
inspect_error_hook="$work_dir/inspect-error.sh"
printf '%s\n' '#!/bin/sh' 'echo "simulated Registry status=503" >&2' 'exit 1' >"$inspect_error_hook"
chmod 0755 "$inspect_error_hook"
repo_f="$repository_prefix-f"
candidate_f_digest="$(seed_candidate "$repo_f" candidate-a "$local_image" "$work_dir/f-candidate.json")"
trace_f="$work_dir/f-write-trace.txt"
if CFS_OCI_WRITE_TRACE="$trace_f" CFS_OCI_INSPECT_OVERRIDE="$inspect_error_hook" \
    sh "$script_dir/cfs-promote-oci-tag.sh" \
    "$repo_f" "$version_tag" "$sha_tag" "$candidate_f_digest" "$work_dir/f-evidence"; then
    echo "inspect ERROR was treated as an absent tag" >&2
    exit 1
fi
test ! -s "$trace_f"
assert_tag_absent "$repo_f" "$sha_tag"
assert_tag_absent "$repo_f" "$version_tag"

# G: every malformed digest must be rejected before inspect or Registry writes.
reject_malformed() {
    case_id="$1"
    bad_digest="$2"
    repository="$repository_prefix-g-$case_id"
    trace="$work_dir/g-$case_id-write-trace.txt"
    if CFS_OCI_WRITE_TRACE="$trace" sh "$script_dir/cfs-promote-oci-tag.sh" \
        "$repository" "$version_tag" "$sha_tag" "$bad_digest" "$work_dir/g-$case_id-evidence"; then
        echo "malformed digest was accepted: $case_id" >&2
        exit 1
    fi
    test ! -s "$trace"
    assert_tag_absent "$repository" "$sha_tag"
    assert_tag_absent "$repository" "$version_tag"
}

valid_hex="${candidate_a_digest#sha256:}"
reject_malformed empty ""
reject_malformed short "sha256:abc"
reject_malformed long "sha256:${valid_hex}a"
reject_malformed uppercase "sha256:$(printf '%s' "$valid_hex" | tr 'a-f' 'A-F')"
reject_malformed nonhex "sha256:$(printf '%s' "$valid_hex" | sed 's/.$/g/')"
reject_malformed leading-space " $candidate_a_digest"
reject_malformed suffix "${candidate_a_digest}suffix"
reject_malformed multiline "$(printf '%s\n%s' "$candidate_a_digest" extra)"

# H: destroy the localhost Registry, temporary image tags, and runtime files.
cleanup
trap - EXIT
if docker inspect "$container_name" >/dev/null 2>&1; then
    echo "temporary Registry container still exists" >&2
    exit 1
fi
if docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -q "^$repository_prefix-"; then
    echo "temporary Registry image tags still exist" >&2
    exit 1
fi
test ! -e "$work_dir"

printf 'CFS_LOCAL_REGISTRY_PROMOTION_R2_PASS pair_preflight=true sha_first=true version_last=true inspect_error_fail_closed=true malformed_digest_rejected=true partial_version_tag=false registry_local_only=true cleanup=true\n'
