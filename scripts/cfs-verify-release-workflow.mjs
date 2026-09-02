/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/cfs-release.yml", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/cfs-ci.yml", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../apps/web/Dockerfile", import.meta.url), "utf8");
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
const sourceGate = workflow.indexOf("Verify release tag is the exact protected main commit");
const localBuild = workflow.indexOf("Build exact source locally");
const scan = workflow.indexOf("Scan local image before publication");
const provenance = workflow.indexOf("Create and verify prepublication provenance");
const mainRecheck = workflow.indexOf("Reverify protected main before any registry mutation");
const login = workflow.indexOf("docker/login-action");
const candidate = workflow.indexOf("Publish only the run-scoped candidate tag");
const sign = workflow.indexOf("Sign, attest and verify the candidate digest");
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
        promote > sign,
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
assert.match(workflow, /promote_or_verify_tag/);
assert.match(workflow, /test "\$existing_digest" = "\$digest"|"\$existing_digest" != "\$digest"/);
assert.match(workflow, /docker buildx imagetools create --tag "\$IMAGE:\$tag" "\$IMAGE@\$digest"/);
assert.match(workflow, /promote_or_verify_tag "\$GITHUB_REF_NAME" OCI-MANIFEST-TAG\.json/);
assert.match(workflow, /promote_or_verify_tag "sha-\$GITHUB_SHA" OCI-MANIFEST-SHA\.json/);
assert.match(workflow, /PREPUBLISH-SHA256SUMS\.txt/);
assert.doesNotMatch(workflow.slice(0, promote), /docker tag "\$LOCAL_IMAGE" "\$IMAGE:\$GITHUB_REF_NAME"/);

assert.equal(packageJson.dependencies["sanitize-html"], "2.17.7");
assert.match(lockfile, /sanitize-html@2\.17\.7:/);
assert.doesNotMatch(lockfile, /sanitize-html@2\.17\.6:/);
assert.match(dockerfile, /apk add --no-cache jq=1\.8\.2-r0 moreutils=0\.70-r1/);
assert.match(dockerfile, /apk add --no-cache unzip=6\.0-r15/);
assert.match(permissionPlan, /Before/);
assert.match(permissionPlan, /After/);
assert.match(permissionPlan, /cfs-web-v\*/);
assert.match(permissionPlan, /Job-only release tag creator/);
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
    "CFS_WEB_RELEASE_WORKFLOW_PASS main_gate=true candidate_first=true exact_identity=true final_no_overwrite=true package_pins=true actual_credentials=0",
);
