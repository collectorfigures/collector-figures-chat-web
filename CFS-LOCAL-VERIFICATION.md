# Local verification record

Date: 2026-08-31

```text
Upstream source commit: c43ef70b55030287677d884f8a3073808c4301d9
CFS Web Push/PWA contract groups: service-worker/push-cleanup/endpoint/CSP/branding/privacy PASS
CFS Web Push unit tests: 15/15 PASS
Affected Web regression suite: 94 PASS / 5 upstream skips
Production Webpack build: PASS
Generated PWA/Push artifact contract: PASS
CFS Web release workflow: scan-before-publish static contract PASS
Root sw.js token/decryption pattern findings: 0
Dedicated cfs-push/sw.js token/client pattern findings: 0
Standard PWA PNG icons: 192/512/maskable/Apple Touch PASS
CFS help page desktop/mobile visual QA: PASS
CFS modified-source oxlint: PASS
Actual credentials found: 0
Deployment performed: NO
Production mutation: 0
```

The full upstream TypeScript check reaches the CFS files without a CFS error, then stops on three pre-existing
`matrix-js-sdk@42.2.0` TypeScript 6 errors in `MSC4108SignInWithQR.ts`. This is not recorded as a full typecheck PASS. The
public Linux workflow uses the CFS unit, lint, privacy-contract, and production-build gates; upstream dependency drift remains
visible and must not be rewritten as green evidence.

Both generated `/sw.js` and `/cfs-push/sw.js`, including their source maps, contain no Matrix access-token lookup,
decryption, Authorization header or authenticated-media proxy path. Authenticated media remains in the Window/SDK request
path. This is a local remediation result pending public CI and independent Source Review R2.
