/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [manifestText, configText, manager, pushWorker, pushPayload, shellWorker, lifecycle, indexPage, helpPage] =
    await Promise.all([
        read("apps/web/res/manifest.json"),
        read("apps/web/config.cfs.production.json"),
        read("apps/web/src/cfs-webpush/CfsWebPushManager.ts"),
        read("apps/web/src/cfs-webpush/serviceworker.ts"),
        read("apps/web/src/cfs-webpush/payload.ts"),
        read("apps/web/src/serviceworker/index.ts"),
        read("apps/web/src/Lifecycle.ts"),
        read("apps/web/src/vector/index.html"),
        read("apps/web/res/cfs-help/index.html"),
    ]);

const manifest = JSON.parse(manifestText);
const config = JSON.parse(configText);

assert.equal(manifest.name, "Collector Figures Chat");
assert.equal(manifest.short_name, "CFS Chat");
assert.deepEqual(
    manifest.icons.map(({ src, sizes, type, purpose }) => ({ src, sizes, type, purpose })),
    [
        { src: "/cfs-icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/cfs-icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/cfs-icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
);
assert.equal(manifest.start_url, "/");
assert.deepEqual(manifest.related_applications, []);
assert.equal(config.disable_custom_urls, true);
assert.equal(config.disable_guests, true);
assert.deepEqual(config.room_directory.servers, []);
assert.equal(config.cfs_webpush_app_id, "com.collectorfigures.chat.web");
assert.equal(config.cfs_webpush_gateway_url, "https://chat-push.collectorfigures.com");
assert.equal(config.help_url, "/cfs-help/index.html");
assert.deepEqual(config.mobile_builds, { ios: "", android: "", fdroid: "" });

assert.match(manager, /events_only:\s*true/);
assert.match(manager, /format:\s*"event_id_only"/);
assert.match(manager, /kind:\s*"http"/);
assert.match(manager, /removePusher/);
assert.match(manager, /unsubscribe/);
assert.match(manager, /EXPECTED_GATEWAY = "https:\/\/chat-push\.collectorfigures\.com"/);
assert.match(manager, /CLEANUP_CACHE/);
assert.match(manager, /retryCfsWebPushCleanup/);
assert.match(manager, /Previous CFS Web Push cleanup is still pending/);
assert.match(manager, /Matrix pusher registration failed and was queued for cleanup/);
assert.match(manager, /validateSubscriptionEndpoint/);

assert.match(pushWorker, /Collector Figures/);
assert.match(pushWorker, /You have a new message/);
assert.doesNotMatch(pushWorker, /access[_-]?token|MatrixClient|localStorage|indexedDB|getAuthData/i);
assert.doesNotMatch(pushWorker, /room_name|sender|content|email|matrix_id|mxid/i);
assert.match(pushWorker, /SUBSCRIPTION_CHANGE_PATH/);
assert.doesNotMatch(pushPayload, /access[_-]?token|MatrixClient|localStorage|indexedDB|getAuthData/i);
assert.doesNotMatch(pushPayload, /room_name|sender|content|email|matrix_id|mxid/i);

assert.match(shellWorker, /CFS_STATIC_PREFIXES/);
assert.match(shellWorker, /url\.pathname\.startsWith\("\/_matrix\/"\)/);
assert.doesNotMatch(shellWorker, /CFS_SHELL_PRECACHE[^;]*config\.json/s);
assert.doesNotMatch(
    shellWorker,
    /access[_-]?token|Authorization|Bearer|idbLoad|tryDecryptToken|getAuthData|pickleKey|media\/v3/i,
);
assert.ok(
    lifecycle.indexOf("clearLocalCfsWebPushAfterSessionEnd") <
        lifecycle.indexOf("clearStorage({ deleteEverything: true })"),
);
assert.match(lifecycle, /Push cleanup is best-effort[\s\S]*mandatory local account wipe/);
assert.doesNotMatch(indexPage, /(?:img|connect|media|frame)-src \*/);
for (const directive of ["base-uri 'none'", "object-src 'none'", "frame-src 'none'"]) {
    assert.match(indexPage, new RegExp(directive));
}

assert.match(helpPage, /official supported client/);
assert.match(helpPage, /optional third-party Matrix client/);
assert.match(helpPage, /background Web Push requires the Home Screen PWA/);
assert.match(helpPage, /No product analytics are enabled/);
assert.doesNotMatch(helpPage, /posthog|sentry|analytics_endpoint/i);

console.log(
    "CFS_WEBPUSH_CONTRACT_PASS policy_groups=service-worker,push-cleanup,endpoint,csp,branding,privacy actual_credentials=0",
);
