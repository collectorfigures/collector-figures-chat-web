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
const expectedConcurrencyGroup = "cfs-web-immutable-release";
const releaseTagFixtures = ["cfs-web-v1.0.0", "cfs-web-v1.0.1", "cfs-web-v1.0.2"];

function verifyReleaseSingleFlight(source) {
    const match = source.match(
        /^concurrency:\r?\n {4}group: ([^\r\n]+)\r?\n {4}queue: ([^\r\n]+)\r?\n {4}cancel-in-progress: (true|false)\s*$/m,
    );
    assert.ok(match, "release concurrency must be a workflow-level block");
    assert.equal((source.match(/^concurrency:/gm) ?? []).length, 1);
    assert.ok(source.indexOf("concurrency:") < source.indexOf("jobs:"));
    assert.equal(match[1], expectedConcurrencyGroup);
    assert.equal(match[2], "max");
    assert.equal(match[3], "false");
    assert.doesNotMatch(match[2], /\$\{\{/);
    assert.doesNotMatch(match[1], /\$\{\{|ref|ref_name|sha|run_id|run_attempt|version|tag/i);

    const mappedGroups = releaseTagFixtures.map(() => match[1]);
    assert.deepEqual(mappedGroups, [expectedConcurrencyGroup, expectedConcurrencyGroup, expectedConcurrencyGroup]);
    assert.equal(new Set(mappedGroups).size, 1);
}

verifyReleaseSingleFlight(workflow);
const queueFixtures = [
    workflow.replace("    queue: max\n", ""),
    workflow.replace("    queue: max", "    queue: single"),
    workflow.replace("    queue: max", "    queue: 1"),
    workflow.replace("    queue: max", "    queue: true"),
    workflow.replace("    queue: max", "    queue: ${{ inputs.queue }}"),
    workflow.replace("    cancel-in-progress: false", "    cancel-in-progress: true"),
];
const jobOnlyConcurrencyFixture = workflow
    .replace(
        /^concurrency:\r?\n {4}group: [^\r\n]+\r?\n {4}queue: [^\r\n]+\r?\n {4}cancel-in-progress: [^\r\n]+\r?\n\r?\n/m,
        "",
    )
    .replace(
        /^jobs:\r?\n {4}build-scan-publish:/m,
        `jobs:\n    build-scan-publish:\n        concurrency:\n            group: ${expectedConcurrencyGroup}\n            queue: max\n            cancel-in-progress: false`,
    );
for (const fixture of [...queueFixtures, jobOnlyConcurrencyFixture]) {
    assert.throws(() => verifyReleaseSingleFlight(fixture));
}
for (const dynamicGroup of [
    "cfs-web-release-${{ github.ref_name }}",
    "cfs-web-release-${{ github.ref }}",
    "cfs-web-release-${{ github.sha }}",
    "cfs-web-release-${{ github.run_id }}",
    "cfs-web-release-${{ github.run_attempt }}",
    "cfs-web-release-${{ inputs.version }}",
    "cfs-web-release-${{ inputs.tag }}",
]) {
    const fixture = workflow.replace(
        `    group: ${expectedConcurrencyGroup}`,
        `    group: ${dynamicGroup}`,
    );
    assert.throws(() => verifyReleaseSingleFlight(fixture));
}
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
const pairInspectSha = promotionScript.indexOf('inspect_tag "SHA"');
const pairInspectVersion = promotionScript.indexOf('inspect_tag "VERSION"');
const shaMismatchGate = promotionScript.indexOf('sha tag points to a different digest');
const versionMismatchGate = promotionScript.indexOf('version tag points to a different digest');
const shaWrite = promotionScript.indexOf('promote_missing_tag "SHA"');
const versionWrite = promotionScript.indexOf('promote_missing_tag "TAG"');

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
assert.match(workflow, /environment:\s*\n\s*name:\s*cfs-web-release/);
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
assert.equal((workflow.match(/bash scripts\/cfs-promote-oci-tag\.sh/g) ?? []).length, 1);
assert.match(workflow, /"\$IMAGE" "\$GITHUB_REF_NAME" "sha-\$GITHUB_SHA" "\$digest" \./);
assert.doesNotMatch(workflow, /docker buildx imagetools create/);
assert.doesNotMatch(workflow, /if docker buildx imagetools inspect/);
assert.match(workflow, /CFS_REGCTL_VERSION:\s*v0\.11\.6/);
assert.match(workflow, /CFS_REGCTL_SHA256:\s*8e0e62a497fcdb8048d18aa927a139613176ba0531f412bc541044e28f9856bd/);
assert.match(workflow, /sha256sum -c -/);
assert.match(workflow, /OCI-INSPECTOR\.json/);
assert.match(workflow, /test "\$\{#digest\}" -eq 71/);
assert.match(workflow, /\^sha256:\[0-9a-f\]\{64\}\$/);
assert.match(promotionScript, /docker buildx imagetools create \\\n\s*--prefer-index=false \\\n\s*--metadata-file/);
assert.doesNotMatch(promotionScript, /imagetools create\s+--tag/);
assert.match(promotionScript, /\."containerimage\.descriptor"\.digest/);
assert.match(promotionScript, /\^sha256:\[0-9a-f\]\{64\}\$/);
assert.match(promotionScript, /MANIFEST_UNKNOWN/);
assert.match(promotionScript, /manifest unknown/);
assert.match(promotionScript, /manifest head "\$ref"/);
assert.doesNotMatch(promotionScript, /manifest head --format/);
assert.match(promotionScript, /DEFINITELY_NOT_FOUND/);
assert.match(promotionScript, /INSPECT_STATE="ERROR"/);
assert.match(promotionScript, /formal tag pair preflight failed before writes/);
assert.ok(
    pairInspectSha >= 0 &&
        pairInspectVersion > pairInspectSha &&
        shaMismatchGate > pairInspectVersion &&
        versionMismatchGate > shaMismatchGate &&
        shaWrite > versionMismatchGate &&
        versionWrite > shaWrite,
);
assert.match(promotionScript, /CFS_OCI_FAIL_BEFORE_VERSION_WRITE/);
assert.match(promotionScript, /partial_version_tag:\s*false/);
assert.match(integrationScript, /registry:2@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278/);
assert.match(integrationScript, /127\.0\.0\.1:5000:5000/);
assert.match(integrationScript, /repository_prefix="127\.0\.0\.1:5000\//);
assert.doesNotMatch(integrationScript, /repository_prefix="localhost:5000\//);
assert.match(integrationScript, /# A: both formal tags are absent/);
assert.match(integrationScript, /# B: both formal tags already exist/);
assert.match(integrationScript, /# C: SHA exists at a different digest/);
assert.match(integrationScript, /# D: version exists at a different digest/);
assert.match(integrationScript, /# E: SHA can be created/);
assert.match(integrationScript, /# F: a non-not-found inspect error/);
assert.match(integrationScript, /# G: every malformed digest/);
assert.match(integrationScript, /# H: destroy the localhost Registry/);
assert.match(integrationScript, /CFS_OCI_INSPECT_OVERRIDE/);
assert.match(integrationScript, /pair_preflight=true/);
assert.match(integrationScript, /sha_first=true/);
assert.match(integrationScript, /version_last=true/);
assert.match(integrationScript, /inspect_error_fail_closed=true/);
assert.match(integrationScript, /malformed_digest_rejected=true/);
assert.match(integrationScript, /partial_version_tag=false/);
assert.match(integrationScript, /cleanup=true/);
assert.match(ciWorkflow, /permissions:\s*\n\s*contents: read/);
assert.doesNotMatch(ciWorkflow, /packages:\s*write|id-token:\s*write/);
assert.match(ciWorkflow, /push:\s*false/);
assert.match(ciWorkflow, /fetch-depth:\s*0/);
assert.match(ciWorkflow, /CFS_REGCTL_VERSION:\s*v0\.11\.6/);
assert.match(ciWorkflow, /CFS_REGCTL_SHA256:\s*8e0e62a497fcdb8048d18aa927a139613176ba0531f412bc541044e28f9856bd/);
assert.match(ciWorkflow, /sha256sum -c -/);
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
assert.match(permissionPlan, /environment\.name: cfs-web-release/);
assert.match(permissionPlan, /regctl v0\.11\.6/);
assert.match(permissionPlan, /8e0e62a497fcdb8048d18aa927a139613176ba0531f412bc541044e28f9856bd/);
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
    promotionScript,
    integrationScript,
    replyTests,
    htmlUtilsTests,
    previewTests,
]) {
    for (const pattern of literalSecretPatterns) assert.doesNotMatch(source, pattern);
}

console.log(
    "CFS_WEB_RELEASE_WORKFLOW_R2_PASS main_gate=true candidate_first=true exact_identity=true prefer_index_false=true metadata_raw_candidate_equal=true pair_preflight=true sha_first=true version_last=true inspect_error_fail_closed=true malformed_digest_rejected=true environment=cfs-web-release local_registry_contract=true package_pins=true actual_credentials=0",
);
console.log(
    "CFS_RELEASE_SINGLE_FLIGHT_CONTRACT_PASS release_single_flight=true different_version_tags_same_group=true cross_tag_parallelism=false cancel_in_progress=false group=cfs-web-immutable-release",
);
console.log(
    "CFS_RELEASE_QUEUE_PRESERVATION_CONTRACT_PASS release_single_flight=true three_version_tags_same_group=true queue=max pending_capacity=100 pending_replacement=false_within_capacity=true cross_tag_parallelism=false cancel_in_progress=false",
);
