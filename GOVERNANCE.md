# Repository governance

The public repository is the authoritative Corresponding Source for each Collector Figures Web/PWA production image.

Required GitHub rules for `main`:

- deny force-push and branch deletion;
- require linear history;
- require the `CFS Web source verification / verify` status check;
- require conversations to be resolved before merge;
- block merge while the required check is stale or failing.

Release rules:

- production builds run only from an immutable `cfs-web-v*` tag;
- a tag must point to a commit already present on protected `main`;
- the tag is never moved or deleted;
- the release records source commit/tree, OCI digest, SHA-256, SBOM, raw Trivy output, and BuildKit provenance;
- a changed binary requires a new public source tag and a new immutable OCI digest.

Upstream workflow files are preserved under `.github/upstream-workflows-disabled/` for source/history context but are not
executed by GitHub. Only CFS workflows in `.github/workflows/` are active.
