/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/cfs-release.yml", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/cfs-ci.yml", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../apps/web/Dockerfile", import.meta.url), "utf8");
const dockerPackage = readFileSync(new URL("./docker-package.sh", import.meta.url), "utf8");
const packageText = readFileSync(new URL("../apps/web/package.json", import.meta.url), "utf8");
const packageJson = JSON.parse(packageText);
const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const permissionPlan = readFileSync(
    new URL("../docs/CFS-RELEASE-PERMISSIONS-PLAN.md", import.meta.url),
    "utf8",
);
const replyTests = readFileSync(new URL("../apps/web/test/unit-tests/utils/Reply-test.ts", import.meta.url), "utf8");
const htmlUtilsTests = readFileSync(new URL("../apps/web/test/unit-tests/HtmlUtils-test.tsx", import.meta.url), "utf8");
const previewTests = readFileSync(
    new URL("../apps/web/test/unit-tests/stores/message-preview/previews/MessageEventPreview-test.ts", import.meta.url),
    "utf8",
);
const promotionScript = readFileSync(new URL("../scripts/cfs-promote-oci-tag.sh", import.meta.url), "utf8");
const integrationScript = readFileSync(
    new URL("../scripts/cfs-test-local-registry-promotion.sh", import.meta.url),
    "utf8",
);
const sourceGate = workflow.indexOf("Verify release tag is the exact protected main commit");
const localBuild = workflow.indexOf("Build exact source locally");
const scan = workflow.indexOf("Scan local image before publication");
const provenance = workflow.indexOf("Create and verify prepublication provenance");
const mainRecheck = workflow.indexOf("Reverify protected main before any registry mutation");
const login = workflow.indexOf("docker/login-action");
const candidate = workflow.indexOf("Publish only the run-scoped candidate tag");
const sign = workflow.indexOf("Sign, attest and verify the candidate digest");
const promotionMainRecheck = workflow.indexOf("Reverify protected main before formal tag promotion");
const promote = workflow.indexOf("Promote the verified digest without overwriting formal tags");

assert.ok(
    sourceGate >= 0 &&
        localBuild > sourceGate &&
        scan > localBuild &&
        provenance > scan &&
        mainRecheck > provenance &&
        login > mainRecheck &&
        candidate > login &&
        sign > candidate &&
        promotionMainRecheck > sign &&
        promote > promotionMainRecheck,
);
assert.match(workflow, /load:\s*true/);
assert.match(workflow, /push:\s*false/);
assert.doesNotMatch(workflow, /push:\s*true/);
assert.match(workflow, /format:\s*spdx-json/);
assert.match(workflow, /format:\s*cyclonedx/);
assert.match(workflow, /refs\/remotes\/origin\/main\^\{commit\}/);
assert.match(workflow, /test "\$tag_commit" = "\$main_commit"/);
assert.match(workflow, /CANDIDATE_TAG: candidate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ github\.sha \}\}/);
assert.match(workflow, /cosign sign --yes/);
assert.match(workflow, /cosign verify-attestation --type slsaprovenance/);
assert.match(workflow, /--certificate-identity "\$CERTIFICATE_IDENTITY"/);
assert.doesNotMatch(workflow, /certificate-identity-regexp/);
assert.match(
    workflow,
    /CERTIFICATE_IDENTITY: https:\/\/github\.com\/\$\{\{ github\.repository \}\}\/\.github\/workflows\/cfs-release\.yml@refs\/tags\/\$\{\{ github\.ref_name \}\}/,
);
assert.match(workflow, /bash scripts\/cfs-promote-oci-tag\.sh/);
assert.doesNotMatch(workflow, /docker buildx imagetools create/);
assert.match(promotionScript, /docker buildx imagetools create \\\n\s*--prefer-index=false \\\n\s*--metadata-file/);
assert.doesNotMatch(promotionScript, /imagetools create\s+--tag/);
assert.match(promotionScript, /\."containerimage\.descriptor"\.digest/);
assert.match(promotionScript, /test "\$metadata_digest" = "\$candidate_digest"/);
assert.match(promotionScript, /test "\$raw_manifest_digest" = "\$candidate_digest"/);
assert.match(promotionScript, /refusing to overwrite/);
assert.match(integrationScript, /registry:2@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278/);
assert.match(integrationScript, /127\.0\.0\.1:5000:5000/);
assert.match(integrationScript, /different_digest_rejected=true/);
assert.match(integrationScript, /formal_unchanged=true/);
assert.match(ciWorkflow, /permissions:\s*\n\s*contents: read/);
assert.doesNotMatch(ciWorkflow, /packages:\s*write|id-token:\s*write/);
assert.match(ciWorkflow, /push:\s*false/);
assert.match(ciWorkflow, /fetch-depth:\s*0/);
assert.match(ciWorkflow, /CFS_DOCKER_DIST_VERSION=v0\.0\.0-cfs-ci\./);
assert.match(ciWorkflow, /CFS_WEB_LOCAL_DOCKER_BUILD_PASS/);
assert.match(ciWorkflow, /cfs-test-local-registry-promotion\.sh/);
assert.match(workflow, /PREPUBLISH-SHA256SUMS\.txt/);
assert.doesNotMatch(workflow.slice(0, promote), /docker tag "\$LOCAL_IMAGE" "\$IMAGE:\$GITHUB_REF_NAME"/);

assert.equal(packageJson.dependencies["sanitize-html"], "2.17.7");
assert.match(lockfile, /sanitize-html@2\.17\.7:/);
assert.doesNotMatch(lockfile, /sanitize-html@2\.17\.6:/);
assert.match(dockerfile, /apk add --no-cache jq=1\.8\.2-r0 moreutils=0\.70-r1/);
assert.match(dockerfile, /apk add --no-cache unzip=6\.0-r15/);
assert.match(dockerfile, /ARG CFS_DOCKER_DIST_VERSION=""/);
assert.match(dockerPackage, /if \[\[ -n \$\{CFS_DOCKER_DIST_VERSION:-\} \]\]/);
assert.match(permissionPlan, /Before/);
assert.match(permissionPlan, /After/);
assert.match(permissionPlan, /cfs-web-v\*/);
assert.match(permissionPlan, /Job-only release tag creator/);
assert.match(permissionPlan, /prevent self-review: `false`/);
assert.match(permissionPlan, /Future Technical Owner/);
assert.match(permissionPlan, /prevent self-review: `true`/);
assert.match(permissionPlan, /not applied/i);

const literalSecretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/-]{12,}/i,
];
for (const source of [
    workflow,
    ciWorkflow,
    dockerfile,
    packageText,
    lockfile,
    permissionPlan,
    replyTests,
    htmlUtilsTests,
    previewTests,
]) {
    for (const pattern of literalSecretPatterns) assert.doesNotMatch(source, pattern);
}

console.log(
    "CFS_WEB_RELEASE_WORKFLOW_PASS main_gate=true candidate_first=true exact_identity=true prefer_index_false=true metadata_raw_candidate_equal=true final_no_overwrite=true local_registry_contract=true package_pins=true actual_credentials=0",
);
