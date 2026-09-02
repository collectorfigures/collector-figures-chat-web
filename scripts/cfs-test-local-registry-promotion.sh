#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: cfs-test-local-registry-promotion.sh LOCAL_IMAGE" >&2
    exit 64
fi

local_image="$1"
registry_image="docker.io/library/registry:2@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278"
run_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"
container_name="cfs-oci-registry-$run_suffix"
repository="localhost:5000/cfs-oci-promotion-$run_suffix"
candidate_a="$repository:candidate-a"
candidate_b="$repository:candidate-b"
formal_tag="formal"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
work_dir="$(mktemp -d)"

cleanup() {
    docker rm -f "$container_name" >/dev/null 2>&1 || true
    docker image rm -f "$candidate_a" "$candidate_b" >/dev/null 2>&1 || true
    rm -rf "$work_dir"
}
trap cleanup EXIT

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

docker tag "$local_image" "$candidate_a"
docker push "$candidate_a" >/dev/null
docker buildx imagetools inspect --raw "$candidate_a" > "$work_dir/candidate-a.json"
candidate_a_digest="sha256:$(sha256sum "$work_dir/candidate-a.json" | cut -d' ' -f1)"

bash "$script_dir/cfs-promote-oci-tag.sh" \
    "$repository" "$formal_tag" "$candidate_a_digest" \
    "$work_dir/formal-first.json" "$work_dir/formal-first-metadata.json"
first_formal_digest="sha256:$(sha256sum "$work_dir/formal-first.json" | cut -d' ' -f1)"
first_metadata_digest="$(jq -er '.containerimage.descriptor.digest' "$work_dir/formal-first-metadata.json")"
test "$candidate_a_digest" = "$first_formal_digest"
test "$candidate_a_digest" = "$first_metadata_digest"

bash "$script_dir/cfs-promote-oci-tag.sh" \
    "$repository" "$formal_tag" "$candidate_a_digest" \
    "$work_dir/formal-idempotent.json" "$work_dir/formal-idempotent-metadata.json"
idempotent_digest="sha256:$(sha256sum "$work_dir/formal-idempotent.json" | cut -d' ' -f1)"
test "$idempotent_digest" = "$candidate_a_digest"

docker tag "$registry_image" "$candidate_b"
docker push "$candidate_b" >/dev/null
docker buildx imagetools inspect --raw "$candidate_b" > "$work_dir/candidate-b.json"
candidate_b_digest="sha256:$(sha256sum "$work_dir/candidate-b.json" | cut -d' ' -f1)"
test "$candidate_b_digest" != "$candidate_a_digest"

if bash "$script_dir/cfs-promote-oci-tag.sh" \
    "$repository" "$formal_tag" "$candidate_b_digest" \
    "$work_dir/formal-different.json" "$work_dir/formal-different-metadata.json"; then
    echo "different-digest overwrite was not rejected" >&2
    exit 1
fi

docker buildx imagetools inspect --raw "$repository:$formal_tag" > "$work_dir/formal-after-rejection.json"
after_rejection_digest="sha256:$(sha256sum "$work_dir/formal-after-rejection.json" | cut -d' ' -f1)"
test "$after_rejection_digest" = "$candidate_a_digest"

printf 'CFS_LOCAL_REGISTRY_PROMOTION_PASS candidate_formal_equal=true metadata_equal=true idempotent=true different_digest_rejected=true formal_unchanged=true registry_local_only=true\n'
