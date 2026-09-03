# CFS Web release permission plan

Status: **APPLIED AND READ-BACK VERIFIED ON 2026-09-03**.

This is a point-in-time permission snapshot. It does not authorize a tag, Release, package publication, Merge, deployment, or permission change. Authenticated API read-back is still required before every Merge and Release.

## Historical state before R3

- `Protect cfs-web release tags` targeted `refs/tags/cfs-web-v*` and blocked update and deletion with no bypass actor.
- Initial release-tag creation had no separate actor gate.
- The Release Workflow had no configured GitHub Environment approval gate.

## Applied state after R3

The Job-only release tag creator boundary is implemented with the organization Team:

- display name: `CFS Release Tag Creators`;
- slug: `cfs-release-tag-creators`;
- Team ID: `19325995`;
- privacy: `closed`;
- parent: none;
- sole member: `asiananlee` / user ID `248271261` / role `maintainer`;
- repository assignments: `0`.

The Web release gate is:

- Environment: `cfs-web-release`;
- required reviewer: `asiananlee` / user ID `248271261`;
- prevent self-review: `false`;
- can admins bypass: `false`;
- deployment branch policies: `0`;
- sole deployment tag policy: `cfs-web-v*`;
- Environment secrets: `0`;
- Environment variables: `0`;
- creation-only Ruleset: `Restrict cfs-web release tag creation` / ID `22177545`;
- creation bypass: Team ID `19325995` only, mode `always`;
- unchanged update/deletion Ruleset: `Protect cfs-web release tags` / ID `21900095`;
- update/deletion bypass actors: `0`.

The Draft Release Workflow declares `environment.name: cfs-web-release`. Packages write and id-token write remain confined to the Environment-protected release job; the preceding tag-validation job has only `contents: read`.

## Formal release tag admission

The GitHub `cfs-web-v*` pattern is only a coarse namespace filter. The authoritative Formal Release admission is the Runtime exact regex:

```text
^cfs-web-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$
```

Phase 1 accepts only stable `MAJOR.MINOR.PATCH`. Prerelease suffixes, build metadata, extra components, leading zeroes, wrong case, wrong repository prefixes, whitespace, slash suffixes, and other trailing content fail closed. The run-scoped candidate tag remains the non-formal candidate identity.

The protected tag target must equal the current protected `main` commit before any registry mutation. Formal-tag inspection uses `regctl v0.11.6` for linux/amd64, pinned to SHA-256 `8e0e62a497fcdb8048d18aa927a139613176ba0531f412bc541044e28f9856bd`. Only explicit manifest-not-found or HTTP 404 is absence; every other inspect failure is an error with zero formal writes.

Because a malformed tag that matches the coarse Ruleset namespace may be protected against update and deletion, Job must manually check the exact stable three-component format before creating any release tag.

## Future separation of duties

- tag creator: Job;
- Environment required reviewer: Future Technical Owner;
- prevent self-review: `true`;
- change only after the Technical Owner role exists and a non-release dry run proves the approval path cannot lock out releases.

## Risks and rollback

- A creation Ruleset without a valid Team bypass locks release-tag creation.
- A broad RepositoryRole or OrganizationAdmin bypass weakens the single-actor boundary.
- Removing or renaming the Environment can strand an approved release after tag creation.
- A final GHCR tag is not rollback state unless its digest is recorded and verified.
- Rollback uses a new, higher stable version tag on a newly reviewed protected-main commit; never update, delete, or force-move an existing release tag.

## Break glass

The organization owner may temporarily add the Future Technical Owner to the dedicated creation-only Team only after recording an incident and expiry time. The update/deletion Ruleset stays active. Break glass never permits force push, tag rewrite, package overwrite, or bypass of main-commit, scan, signature, attestation, digest, and strict tag-admission gates.
