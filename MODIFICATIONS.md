# Collector Figures modifications

Modification date: 2026-08-31

- Rebrand the Web/PWA client as `Collector Figures` and use Collector Figures icons.
- Replace upstream welcome/help/mobile-download surfaces with a CFS help page and PWA installation guidance; Element X is
  disclosed only as an optional third-party client.
- Fix the homeserver and SSO entry points; remove custom homeserver, open registration, public Matrix discovery, room/space
  creation, invitations, integrations, calls, and upstream native-app promotion from the supported CFS surface.
- Add a dedicated CFS Web Push worker and Matrix pusher registration using
  `app_id=com.collectorfigures.chat.web` and `events_only=true`.
- Keep Web Push system notifications generic and exclude message bodies, email addresses, and public Matrix IDs.
- Remove the CFS pusher and browser Push subscription on logout/session termination.
- Add application-shell-only offline caching. Matrix APIs, runtime config, messages, media, tokens, and decrypted content are
  excluded from the cache.
- Disable automatic analytics and remote diagnostic upload. Diagnostics remain user-initiated and local-only pending the
  separately reviewed redaction flow.
- Declare the Element Web Nx project name/root explicitly so the pinned source builds reproducibly on Windows as well as Linux.

The upstream authenticated-media worker is still present and transiently derives the Matrix token when fetching protected
media. The new CFS Push worker is isolated under `/cfs-push/` and never reads or receives the Matrix token. The stricter
requirement that _no_ service worker may transiently handle a Matrix token remains an explicit production review item; it is
not silently declared closed by this fork.
