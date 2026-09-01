/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [
    manifestText,
    configText,
    endpointFixturesText,
    manager,
    mutationCoordinator,
    crossRealmTests,
    pushWorker,
    pushPayload,
    notificationGate,
    shellWorker,
    lifecycle,
    webPlatform,
    indexPage,
    helpPage,
] =
    await Promise.all([
        read("apps/web/res/manifest.json"),
        read("apps/web/config.cfs.production.json"),
        read("apps/web/src/cfs-webpush/fixtures/cfs-webpush-endpoints.json"),
        read("apps/web/src/cfs-webpush/CfsWebPushManager.ts"),
        read("apps/web/src/cfs-webpush/mutationCoordinator.ts"),
        read("apps/web/src/cfs-webpush/CfsWebPushCrossTab.test.ts"),
        read("apps/web/src/cfs-webpush/serviceworker.ts"),
        read("apps/web/src/cfs-webpush/payload.ts"),
        read("apps/web/src/cfs-webpush/notificationGate.ts"),
        read("apps/web/src/serviceworker/index.ts"),
        read("apps/web/src/Lifecycle.ts"),
        read("apps/web/src/vector/platform/WebPlatform.ts"),
        read("apps/web/src/vector/index.html"),
        read("apps/web/res/cfs-help/index.html"),
    ]);

const manifest = JSON.parse(manifestText);
const config = JSON.parse(configText);
const endpointFixtures = JSON.parse(endpointFixturesText);

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
assert.match(manager, /ENROLLMENT_KEY/);
assert.match(manager, /state: "enabled"/);
assert.match(manager, /clearEnrollment\(\)/);
assert.match(manager, /ownerFingerprint/);
assert.doesNotMatch(manager, /getPushers\(/);
assert.equal(endpointFixtures.schema, "cfs-webpush-endpoint-fixtures/v2");
assert.equal(endpointFixtures.fixture_values, "synthetic_redactions");
assert.equal(endpointFixtures.real_browser_acceptance, false);
assert.equal(endpointFixtures.safari_status, "fail_closed_pending_real_acceptance");
assert.equal(endpointFixtures.valid.length, 5);
assert.equal(endpointFixtures.invalid.length, 12);
assert.deepEqual(Object.keys(endpointFixtures.provenance).sort(), ["chrome", "edge", "firefox"]);
assert.equal(endpointFixtures.provenance.chrome.redacted_shape, "https://fcm.googleapis.com/wp/<opaque>");
assert.equal(endpointFixtures.provenance.edge.validation_boundary, "https_host_suffix_only_black_box_path_query");
assert.equal(
    createHash("sha256").update(endpointFixturesText).digest("hex"),
    "9999f3e68b1bba37355fccd5231c8026a679d7550bff1cd7359c97eabcb4aab6",
);
assert.match(webPlatform, /isCfsWebPushEnrollmentEnabledForClient/);
assert.ok(
    webPlatform.indexOf("isCfsWebPushEnrollmentEnabledForClient") <
        webPlatform.indexOf("ensureCfsWebPushForGrantedPermission(client)"),
);

assert.match(notificationGate, /Collector Figures/);
assert.match(notificationGate, /You have a new message/);
assert.match(pushWorker, /readActiveOwner/);
assert.match(pushWorker, /showCfsNotificationForActiveOwner/);
assert.doesNotMatch(pushWorker, /access[_-]?token|MatrixClient|localStorage|indexedDB|getAuthData/i);
assert.doesNotMatch(pushWorker, /room_name|sender|content|email|matrix_id|mxid/i);
assert.match(pushWorker, /SUBSCRIPTION_CHANGE_PATH/);
assert.doesNotMatch(pushPayload, /access[_-]?token|MatrixClient|localStorage|indexedDB|getAuthData/i);
assert.doesNotMatch(pushPayload, /room_name|sender|content|email|matrix_id|mxid/i);
assert.match(pushPayload, /\^\[A-Za-z0-9_-\]\{22\}\$/);
assert.match(notificationGate, /isCfsPushForActiveOwner/);
assert.match(notificationGate, /cfsNotificationClickTarget/);
assert.ok(
    notificationGate.indexOf("isCfsPushForActiveOwner") < notificationGate.indexOf("showNotification("),
);
assert.match(manager, /ACTIVE_OWNER_PATH/);
assert.match(manager, /publishCfsWebPushMutation/);
assert.match(manager, /waitForCurrentCfsWebPushMutation/);
assert.match(manager, /isCurrentCfsWebPushMutation/);
assert.match(mutationCoordinator, /cfs_webpush_mutation_v1/);
assert.match(mutationCoordinator, /window\.localStorage\.setItem/);
assert.match(mutationCoordinator, /window\.localStorage\.getItem/);
assert.doesNotMatch(mutationCoordinator, /let mutationGeneration/);
assert.ok(manager.indexOf("await client.setPusher(pusher)") < manager.indexOf("await commitCfsWebPushOwnerState"));
assert.match(manager, /await clearActiveOwnerMarker\(operation\)/);
assert.match(manager, /commitCfsWebPushOwnerState/);
assert.match(manager, /compareAndDeleteCfsWebPushOwnerState/);
assert.match(manager, /operationId: operation\.operationId/);
const ownerStateCommit = manager.slice(
    manager.indexOf("async function commitCfsWebPushOwnerState"),
    manager.indexOf("async function compareAndDeleteCfsWebPushOwnerState"),
);
assert.match(ownerStateCommit, /withCfsWebPushStateLock/);
assert.ok(ownerStateCommit.indexOf("writeStoredRegistration") < ownerStateCommit.indexOf("writeEnrollment"));
assert.ok(ownerStateCommit.indexOf("writeEnrollment") < ownerStateCommit.indexOf("cache.put"));
for (const phase of [
    "after-lock-assert-before-registration",
    "after-registration-write-before-assert",
    "after-enrollment-write-before-assert",
    "active-owner-cache-write-pending",
]) {
    assert.match(crossRealmTests, new RegExp(phase));
}
assert.match(crossRealmTests, /cross_realm_shared_storage_simulation:\s*true/);
assert.match(crossRealmTests, /real_two_page_browser_acceptance:\s*false/);
const sessionLockHandler = lifecycle.slice(
    lifecycle.indexOf("export async function onSessionLockStolen"),
    lifecycle.indexOf("function checkSessionLock"),
);
assert.ok(
    sessionLockHandler.indexOf("supersedeCfsWebPushMutationForSessionLock()") <
        sessionLockHandler.indexOf("stopMatrixClient();"),
);
const notificationClickHandler = pushWorker.slice(
    pushWorker.indexOf('worker.addEventListener("notificationclick"'),
    pushWorker.indexOf('worker.addEventListener("pushsubscriptionchange"'),
);
assert.ok(notificationClickHandler.indexOf("await readActiveOwner()") < notificationClickHandler.indexOf("cfsNotificationClickTarget"));
assert.ok(notificationClickHandler.indexOf("cfsNotificationClickTarget") < notificationClickHandler.indexOf("worker.clients.matchAll"));

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
assert.ok(
    lifecycle.indexOf("await prepareCfsWebPushForAccountReplacement") < lifecycle.indexOf("await doSetLoggedIn"),
);
assert.ok(
    manager.indexOf("await disableCfsWebPushMutation(client, operation)") <
        manager.indexOf("await clearLocalCfsWebPushAfterSessionEndMutation(operation)"),
);
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
