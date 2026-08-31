# Local verification record

Date: 2026-08-31

```text
Upstream source commit: c43ef70b55030287677d884f8a3073808c4301d9
CFS Web Push contract: 20/20 PASS
CFS Web Push unit tests: 3/3 PASS
Production Webpack build: PASS
Generated PWA/Push artifact contract: PASS
CFS modified-source oxlint: PASS
Actual credentials found: 0
Deployment performed: NO
Production mutation: 0
```

The full upstream TypeScript check reaches the CFS files without a CFS error, then stops on three pre-existing
`matrix-js-sdk@42.2.0` TypeScript 6 errors in `MSC4108SignInWithQR.ts`. This is not recorded as a full typecheck PASS. The
public Linux workflow uses the CFS unit, lint, privacy-contract, and production-build gates; upstream dependency drift remains
visible and must not be rewritten as green evidence.

The new `/cfs-push/sw.js` artifact contains no Matrix token, Matrix client, IndexedDB, or authenticated-media code. The
upstream root `sw.js` remains responsible for authenticated media and transiently derives a Matrix token. The strict “no
service worker transient token handling” interpretation therefore remains an explicit independent-review item.
