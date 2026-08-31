/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [manifestText, configText, manager, pushWorker, shellWorker] = await Promise.all([
    read("apps/web/res/manifest.json"),
    read("apps/web/config.cfs.production.json"),
    read("apps/web/src/cfs-webpush/CfsWebPushManager.ts"),
    read("apps/web/src/cfs-webpush/serviceworker.ts"),
    read("apps/web/src/serviceworker/index.ts"),
]);

const manifest = JSON.parse(manifestText);
const config = JSON.parse(configText);

assert.equal(manifest.name, "Collector Figures");
assert.equal(manifest.start_url, "/");
assert.deepEqual(manifest.related_applications, []);
assert.equal(config.disable_custom_urls, true);
assert.equal(config.disable_guests, true);
assert.deepEqual(config.room_directory.servers, []);
assert.equal(config.cfs_webpush_app_id, "com.collectorfigures.chat.web");
assert.equal(config.cfs_webpush_gateway_url, "https://chat-push.collectorfigures.com");

assert.match(manager, /events_only:\s*true/);
assert.match(manager, /format:\s*"event_id_only"/);
assert.match(manager, /kind:\s*"http"/);
assert.match(manager, /removePusher/);
assert.match(manager, /unsubscribe/);

assert.match(pushWorker, /Collector Figures/);
assert.match(pushWorker, /You have a new message/);
assert.doesNotMatch(pushWorker, /access[_-]?token|MatrixClient|localStorage|indexedDB|getAuthData/i);
assert.doesNotMatch(pushWorker, /room_name|sender|content|email|matrix_id|mxid/i);

assert.match(shellWorker, /CFS_STATIC_PREFIXES/);
assert.match(shellWorker, /url\.pathname\.startsWith\("\/_matrix\/"\)/);
assert.doesNotMatch(shellWorker, /CFS_SHELL_PRECACHE[^;]*config\.json/s);

console.log("CFS_WEBPUSH_CONTRACT_PASS checks=20 actual_credentials=0");
