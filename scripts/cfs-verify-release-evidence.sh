#!/usr/bin/env bash
# Copyright 2026 Collector Figures
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail

stage="${1:?local, bind, candidate, or signed}"
case "$stage" in local|bind|candidate|signed) ;; *) exit 64;; esac
case "${GITHUB_REPOSITORY:?}" in
  collectorfigures/collector-figures-chat-web) component=web; dockerfile=apps/web/Dockerfile;;
  collectorfigures/collector-figures-chat-push) component=push; dockerfile=docker/Dockerfile;;
  *) echo "unexpected release repository" >&2; exit 64;;
esac
test "$IMAGE" = "ghcr.io/$GITHUB_REPOSITORY"
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]]
[[ "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
release_pattern="^cfs-${component}-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"
[[ "$GITHUB_REF_TYPE" = tag && "$GITHUB_REF" = "refs/tags/$GITHUB_REF_NAME" ]]
[[ "$GITHUB_REF_NAME" =~ $release_pattern ]]

regular() { test -f "$1" && test ! -L "$1" && test -s "$1"; }
digest() { [[ "$1" =~ ^sha256:[0-9a-f]{64}$ && "${#1}" = 71 ]]; }
local_files=(
  trivy.json sbom.spdx.json sbom.cyclonedx.json BUILD-PROVENANCE.json
  BUILDKIT-METADATA.json LOCAL-IMAGE-INSPECT.json LOCAL-IMAGE-SHA256.txt
  OCI-INSPECTOR.json RELEASE-TAG-ADMISSION.json RELEASE-SOURCE.json
)
candidate_files=(
  OCI-DIGEST.txt OCI-MANIFEST-CANDIDATE.json OCI-PLATFORM-MANIFEST.json
  OCI-DIGEST-BINDING.json
)
signature_files=(COSIGN-VERIFY.json COSIGN-ATTESTATION-VERIFY.raw.jsonl COSIGN-ATTESTATION-VERIFY.json)
verify_list() {
  local manifest="$1"; shift
  regular "$manifest"
  local expected actual file
  expected="$(printf '%s\n' "$@" | LC_ALL=C sort)"
  actual="$(awk 'NF != 2 || length($1) != 64 || $1 ~ /[^0-9a-f]/ {exit 1} {print $2}' "$manifest" | LC_ALL=C sort)"
  test "$actual" = "$expected"
  for file in "$@"; do regular "$file"; done
  sha256sum --check --strict "$manifest"
}
verify_list PREPUBLISH-SHA256SUMS.txt "${local_files[@]}"
regular LOCAL-IMAGE.tar
regular "$dockerfile"
test "$(awk 'NF==2 && length($1)==64 && $1 !~ /[^a-f0-9]/ && $2=="LOCAL-IMAGE.tar" {n++} END{print n+0}' LOCAL-IMAGE-SHA256.txt)" = 1
test "$(wc -l < LOCAL-IMAGE-SHA256.txt)" = 1
sha256sum --check --strict LOCAL-IMAGE-SHA256.txt

jq -e --arg sha "$GITHUB_SHA" '
  type=="array" and length==1 and .[0].Os=="linux" and .[0].Architecture=="amd64"
  and .[0].Config.Labels["org.opencontainers.image.revision"]==$sha
' LOCAL-IMAGE-INSPECT.json > /dev/null
test "$(docker image inspect "$LOCAL_IMAGE" | jq -r '.[0].Id')" = "$(jq -r '.[0].Id' LOCAL-IMAGE-INSPECT.json)"
config_path="$(tar -xOf LOCAL-IMAGE.tar manifest.json | jq -er 'select(type=="array" and length==1) | .[0].Config')"
[[ "$config_path" =~ ^(blobs/sha256/)?[0-9a-f]{64}(\.json)?$ ]]
config_digest="sha256:$(tar -xOf LOCAL-IMAGE.tar "$config_path" | sha256sum | cut -d' ' -f1)"
digest "$config_digest"
tar -xOf LOCAL-IMAGE.tar "$config_path" | jq -e --arg sha "$GITHUB_SHA" '
 .os=="linux" and .architecture=="amd64" and .config.Labels["org.opencontainers.image.revision"]==$sha
' > /dev/null
metadata_config="$(jq -r '.["containerimage.config.digest"] // empty' BUILDKIT-METADATA.json)"
if [[ -n "$metadata_config" ]]; then
  digest "$metadata_config"; test "$metadata_config" = "$config_digest"
else
  # The Docker containerd image store reports a manifest Id, not a config Id.
  # BuildKit's OCI descriptor must be present in the saved tar and bind its config.
  local_manifest="$(jq -er '.["containerimage.digest"] | strings' BUILDKIT-METADATA.json)"
  digest "$local_manifest"
  jq -e --arg manifest "$local_manifest" '.["containerimage.descriptor"].digest==$manifest' BUILDKIT-METADATA.json > /dev/null
  manifest_path="blobs/sha256/${local_manifest#sha256:}"
  test "sha256:$(tar -xOf LOCAL-IMAGE.tar "$manifest_path" | sha256sum | cut -d' ' -f1)" = "$local_manifest"
  tar -xOf LOCAL-IMAGE.tar "$manifest_path" | jq -e --arg config "$config_digest" '.schemaVersion==2 and .config.digest==$config' > /dev/null
fi
jq -e --arg config "$config_digest" '
 .ArtifactType=="container_image" and .Metadata.ImageID==$config and (.Results|type)=="array"
 and ([.Results[]?.Vulnerabilities[]? | select(.Severity=="CRITICAL" or .Severity=="HIGH")] | length)==0
' trivy.json > /dev/null
jq -e --arg config "$config_digest" '
 .spdxVersion=="SPDX-2.3" and .SPDXID=="SPDXRef-DOCUMENT"
 and any(.packages[]; .primaryPackagePurpose=="CONTAINER"
   and any(.annotations[]?; .comment==("ImageID: "+$config)))
' sbom.spdx.json > /dev/null
jq -e --arg config "$config_digest" '
 .bomFormat=="CycloneDX" and .metadata.component.type=="container"
 and any(.metadata.component.properties[]; .name=="aquasecurity:trivy:ImageID" and .value==$config)
' sbom.cyclonedx.json > /dev/null
jq -e --arg sha "$GITHUB_SHA" --arg ref "$GITHUB_REF" '
 .tag_ref==$ref and .tag_commit==$sha and .protected_main_commit==$sha
' RELEASE-SOURCE.json > /dev/null
jq -e --arg ref "$GITHUB_REF" --arg name "$GITHUB_REF_NAME" --arg pattern "$release_pattern" '
 .ref==$ref and .ref_name==$name and .ref_type=="tag" and .expected_pattern==$pattern
 and .stable_three_component_version==true and .prerelease_allowed==false
 and .build_metadata_allowed==false and .registry_mutations_before_validation==0
' RELEASE-TAG-ADMISSION.json > /dev/null
jq -e --arg version "$CFS_REGCTL_VERSION" --arg hash "$CFS_REGCTL_SHA256" '
 .tool=="regctl-linux-amd64" and .version==$version and .sha256==$hash
' OCI-INSPECTOR.json > /dev/null
source_uri="git+https://github.com/${GITHUB_REPOSITORY}@refs/tags/${GITHUB_REF_NAME}"
jq -e --arg source "$source_uri" --arg sha "$GITHUB_SHA" --arg dockerfile "$dockerfile" \
  --arg builder "https://github.com/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  --arg invocation "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" \
  --arg dh "$(sha256sum "$dockerfile" | cut -d' ' -f1)" \
  --arg th "$(cut -d' ' -f1 LOCAL-IMAGE-SHA256.txt)" '
 .buildDefinition.buildType=="https://collectorfigures.com/attestations/github-actions-docker/v1"
 and .buildDefinition.externalParameters=={source:$source,dockerfile:$dockerfile}
 and .buildDefinition.internalParameters.platform=="linux/amd64"
 and .buildDefinition.resolvedDependencies==[{uri:$source,digest:{gitCommit:$sha}}]
 and .runDetails.builder.id==$builder and .runDetails.metadata.invocationId==$invocation
 and .runDetails.byproducts==[{name:"dockerfile",digest:{sha256:$dh}},{name:"local-image-tar",digest:{sha256:$th}}]
' BUILD-PROVENANCE.json > /dev/null

if [[ "$stage" != local ]]; then
  regular OCI-DIGEST.txt
  regular OCI-MANIFEST-CANDIDATE.json
  read -r candidate image extra < OCI-DIGEST.txt
  digest "$candidate"; test "$image" = "$IMAGE"; test -z "$extra"
  test "$(wc -l < OCI-DIGEST.txt)" = 1
  test "$candidate" = "sha256:$(sha256sum OCI-MANIFEST-CANDIDATE.json | cut -d' ' -f1)"
  platform="$candidate"
  if jq -e 'has("manifests")' OCI-MANIFEST-CANDIDATE.json > /dev/null; then
    platform="$(jq -er 'select(.manifests|length==1) | .manifests[0] | select(.platform.os=="linux" and .platform.architecture=="amd64") | .digest' OCI-MANIFEST-CANDIDATE.json)"
    digest "$platform"
  fi
  if [[ "$stage" = bind ]]; then
    if [[ "$platform" = "$candidate" ]]; then
      cp OCI-MANIFEST-CANDIDATE.json OCI-PLATFORM-MANIFEST.json
    else
      docker buildx imagetools inspect --raw "$IMAGE@$platform" > OCI-PLATFORM-MANIFEST.json
    fi
    jq -n --arg source "$GITHUB_SHA" --arg run "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" \
      --arg config "$config_digest" --arg platform "$platform" --arg candidate "$candidate" \
      '{source_commit:$source,run:$run,config_digest:$config,platform_manifest_digest:$platform,registry_candidate_digest:$candidate}' > OCI-DIGEST-BINDING.json
  else
    verify_list CANDIDATE-SHA256SUMS.txt "${candidate_files[@]}"
  fi
  regular OCI-PLATFORM-MANIFEST.json
  test "$platform" = "sha256:$(sha256sum OCI-PLATFORM-MANIFEST.json | cut -d' ' -f1)"
  jq -e --arg config "$config_digest" '.schemaVersion==2 and .config.digest==$config' OCI-PLATFORM-MANIFEST.json > /dev/null
  jq -e --arg source "$GITHUB_SHA" --arg run "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" \
    --arg config "$config_digest" --arg platform "$platform" --arg candidate "$candidate" '
    .source_commit==$source and .run==$run and .config_digest==$config
    and .platform_manifest_digest==$platform and .registry_candidate_digest==$candidate
  ' OCI-DIGEST-BINDING.json > /dev/null
fi
if [[ "$stage" = signed ]]; then
  verify_list SIGNATURES-SHA256SUMS.txt "${signature_files[@]}"
  # Preserve the exact successful stdout and require lossless normalization.
  jq -se --slurpfile normalized COSIGN-ATTESTATION-VERIFY.json '
    length>0 and all(.[]; type=="object") and $normalized==[.]
  ' COSIGN-ATTESTATION-VERIFY.raw.jsonl > /dev/null
  jq -e --arg image "$IMAGE" --arg digest "$candidate" '
    type=="array" and length>0 and all(.[];
      .critical.identity["docker-reference"]==$image and .critical.image["docker-manifest-digest"]==$digest)
  ' COSIGN-VERIFY.json > /dev/null
  jq -e --arg image "$IMAGE" --arg digest "${candidate#sha256:}" --slurpfile predicate BUILD-PROVENANCE.json '
    type=="array" and length>0 and all(.[];
      .payloadType=="application/vnd.in-toto+json"
      and (.signatures|type)=="array" and (.signatures|length)>0
      and all(.signatures[]; (.sig|type)=="string" and (.sig|length)>0)
      and (.payload|type)=="string" and (.payload|length)>0
      and ((.payload|@base64d|@base64)==.payload)
      and ((.payload | @base64d | fromjson) as $statement
      | $statement._type=="https://in-toto.io/Statement/v0.1"
      and $statement.predicateType=="https://slsa.dev/provenance/v1"
      and $statement.subject==[{name:$image,digest:{sha256:$digest}}]
      and $statement.predicate==$predicate[0]))
  ' COSIGN-ATTESTATION-VERIFY.json > /dev/null
fi
printf 'CFS_RELEASE_EVIDENCE_GUARD_PASS stage=%s frozen_checksums_verified=true config_digest=%s\n' "$stage" "$config_digest"
