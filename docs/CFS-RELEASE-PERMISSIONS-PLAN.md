# CFS Web release permission plan

Status: planning only — not applied. This document does not authorize a tag, release, package publication, environment, ruleset, or permission change.

## Before

- Repository ruleset `Protect cfs-web release tags` targets `refs/tags/cfs-web-v*`.
- Enforcement is active.
- It blocks tag update and deletion.
- It has no bypass actors and does not restrict initial tag creation.
- The release workflow has no configured GitHub Environment approval gate.

## After proposal

Keep the existing update/deletion ruleset unchanged and add a separate creation-only ruleset for `refs/tags/cfs-web-v*`:

- rule: block creation by default;
- sole bypass actor: a dedicated organization team containing only the Job account;
- boundary name: `Job-only release tag creator`;
- do not grant that team bypass on the existing update/deletion ruleset;
- require the tag target to equal the current protected `main` commit before the workflow performs any registry mutation.

Create a protected GitHub Environment named `cfs-web-release` before enabling the release workflow:

- required reviewer: Job;
- prevent self-review where supported;
- deployment branch/tag policy limited to `cfs-web-v*`;
- no long-lived registry or signing secret; use the run-scoped `GITHUB_TOKEN` and GitHub OIDC;
- packages write and id-token write remain confined to the release job.

## Risks and rollback

- A creation ruleset without a valid bypass actor locks all release tag creation.
- A broad RepositoryRole or OrganizationAdmin bypass weakens the single-actor boundary.
- Removing or renaming the Environment can strand an approved release after tag creation.
- A final GHCR tag cannot be treated as rollback state unless its digest is recorded and verified.
- Rollback uses a new, higher version tag that points to a newly reviewed protected-main commit; never update, delete, or force-move an existing release tag.

## Break glass

The organization owner may temporarily add the future Technical Owner to the dedicated creation-only team after recording an incident and an expiry time. The existing no-update/no-deletion ruleset stays active. Break glass never permits force push, tag rewrite, package overwrite, or bypass of the workflow main-commit, scan, signature, attestation, and digest verification gates.
