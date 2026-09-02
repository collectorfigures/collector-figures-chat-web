/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/cfs-release.yml", import.meta.url), "utf8");
const localBuild = workflow.indexOf("Build exact source locally");
const scan = workflow.indexOf("Scan local image before publication");
const provenance = workflow.indexOf("Create and verify prepublication provenance");
const login = workflow.indexOf("docker/login-action");
const publish = workflow.indexOf("Publish the already-scanned local image");

assert.ok(localBuild >= 0 && scan > localBuild && provenance > scan && login > provenance && publish > login);
assert.match(workflow, /load:\s*true/);
assert.match(workflow, /push:\s*false/);
assert.doesNotMatch(workflow, /push:\s*true/);
assert.match(workflow, /format:\s*spdx-json/);
assert.match(workflow, /format:\s*cyclonedx/);
assert.match(workflow, /test "\$tag_digest" = "\$sha_digest"/);
assert.match(workflow, /cosign sign --yes/);
assert.match(workflow, /cosign verify-attestation --type slsaprovenance/);
assert.match(workflow, /PREPUBLISH-SHA256SUMS\.txt/);

console.log("CFS_WEB_RELEASE_WORKFLOW_PASS scan_before_publish=true");
