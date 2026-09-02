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
- prevent self-review: `false`;
- reason: Job is currently both the sole tag creator and sole reviewer, so enabling prevent-self-review would permanently lock the release path;
- deployment branch/tag policy limited to `cfs-web-v*`;
- no long-lived registry or signing secret; use the run-scoped `GITHUB_TOKEN` and GitHub OIDC;
- packages write and id-token write remain confined to the release job.

The Draft Release Workflow now declares the exact source-level binding `environment.name: cfs-web-release`. This is a fail-closed prerequisite only: the Environment, reviewer policy, Team, creation Ruleset, and permissions have not been created or changed. They must be created and independently verified before this Draft PR may be merged.

Formal-tag inspection is planned with `regctl v0.11.6` for linux/amd64, downloaded from the official release and pinned to SHA-256 `8e0e62a497fcdb8048d18aa927a139613176ba0531f412bc541044e28f9856bd`. The workflow must classify only explicit manifest-not-found/HTTP 404 as absent; every other inspect failure remains an error with zero formal writes.

Future separation-of-duties upgrade:

- tag creator: Job;
- Environment required reviewer: Future Technical Owner;
- prevent self-review: `true`;
- apply only after the Technical Owner role exists and a non-release dry run proves the approval path cannot lock out releases.

## Risks and rollback

- A creation ruleset without a valid bypass actor locks all release tag creation.
- A broad RepositoryRole or OrganizationAdmin bypass weakens the single-actor boundary.
- Removing or renaming the Environment can strand an approved release after tag creation.
- A final GHCR tag cannot be treated as rollback state unless its digest is recorded and verified.
- Rollback uses a new, higher version tag that points to a newly reviewed protected-main commit; never update, delete, or force-move an existing release tag.

## Break glass

The organization owner may temporarily add the future Technical Owner to the dedicated creation-only team after recording an incident and an expiry time. The existing no-update/no-deletion ruleset stays active. Break glass never permits force push, tag rewrite, package overwrite, or bypass of the workflow main-commit, scan, signature, attestation, and digest verification gates.
