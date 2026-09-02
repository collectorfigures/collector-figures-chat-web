#!/bin/sh

set -eu

if [ "$#" -ne 5 ]; then
    echo "usage: cfs-promote-oci-tag.sh IMAGE TAG CANDIDATE_DIGEST FINAL_MANIFEST METADATA_FILE" >&2
    exit 64
fi

image="$1"
tag="$2"
candidate_digest="$3"
final_manifest="$4"
metadata_file="$5"
existing_manifest="${final_manifest%.json}-EXISTING.json"

case "$candidate_digest" in
    sha256:[0-9a-f][0-9a-f]*) ;;
    *)
        echo "invalid candidate digest" >&2
        exit 64
        ;;
esac

created=false
metadata_digest="$candidate_digest"

if docker buildx imagetools inspect --raw "$image:$tag" > "$existing_manifest" 2>/dev/null; then
    existing_digest="sha256:$(sha256sum "$existing_manifest" | cut -d' ' -f1)"
    if [ "$existing_digest" != "$candidate_digest" ]; then
        echo "refusing to overwrite $image:$tag ($existing_digest != $candidate_digest)" >&2
        exit 42
    fi
    jq -n --arg digest "$existing_digest" \
        '{"containerimage.descriptor": {digest: $digest}, cfs: {idempotent: true}}' \
        > "$metadata_file"
    metadata_digest="$(jq -er '."containerimage.descriptor".digest' "$metadata_file")"
else
    rm -f "$existing_manifest"
    docker buildx imagetools create \
        --prefer-index=false \
        --metadata-file "$metadata_file" \
        --tag "$image:$tag" \
        "$image@$candidate_digest"
    metadata_digest="$(jq -er '."containerimage.descriptor".digest' "$metadata_file")"
    test "$metadata_digest" = "$candidate_digest"
    created=true
fi

docker buildx imagetools inspect --raw "$image:$tag" > "$final_manifest"
raw_manifest_digest="sha256:$(sha256sum "$final_manifest" | cut -d' ' -f1)"
test "$raw_manifest_digest" = "$candidate_digest"
test "$metadata_digest" = "$candidate_digest"

printf 'CFS_OCI_PROMOTION_PASS tag=%s created=%s candidate=%s metadata=%s raw=%s\n' \
    "$tag" "$created" "$candidate_digest" "$metadata_digest" "$raw_manifest_digest"
