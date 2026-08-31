/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import { logger } from "matrix-js-sdk/src/logger";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import SdkConfig from "../SdkConfig";

const CFS_PUSH_SCOPE = "/cfs-push/";
const CFS_PUSH_WORKER = `${CFS_PUSH_SCOPE}sw.js`;
const STORAGE_KEY = "cfs_webpush_registration_v1";
const CLEANUP_CACHE = "cfs-webpush-cleanup-v1";
const CLEANUP_PATH = `${CFS_PUSH_SCOPE}cleanup-retry.json`;
const SUBSCRIPTION_CHANGE_PATH = `${CFS_PUSH_SCOPE}subscription-change`;
const DEFAULT_APP_ID = "com.collectorfigures.chat.web";
const EXPECTED_GATEWAY = "https://chat-push.collectorfigures.com";

interface StoredRegistration {
    appId: string;
    pushKey: string;
    endpoint: string;
    deviceId: string;
}

interface CleanupTarget {
    appId: string;
    pushKey: string;
}

interface CleanupTombstone {
    deviceId?: string;
    targets: CleanupTarget[];
    needsEnumeration: boolean;
    browserUnsubscribePending: boolean;
}

interface CfsWebPushConfig {
    gatewayUrl: string;
    applicationServerKey: string;
    appId: string;
}

export interface CfsWebPushStatus {
    available: boolean;
    configured: boolean;
    enabled: boolean;
    permission: NotificationPermission | "unsupported";
}

function decodeBase64Url(value: string): ArrayBuffer {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const normalized = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    const binary = window.atob(normalized);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function encodeBase64Url(value: Uint8Array): string {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function accountFingerprint(appId: string, deviceId: string): Promise<string> {
    const input = new TextEncoder().encode(`${appId}\u0000${deviceId}`);
    const digest = await crypto.subtle.digest("SHA-256", input);
    return encodeBase64Url(new Uint8Array(digest).slice(0, 16));
}

function getConfig(): CfsWebPushConfig | undefined {
    if (SdkConfig.get("cfs_webpush_enabled") !== true) return undefined;

    const gatewayUrl = SdkConfig.get("cfs_webpush_gateway_url");
    const applicationServerKey = SdkConfig.get("cfs_webpush_application_server_key");
    const appId = SdkConfig.get("cfs_webpush_app_id") ?? DEFAULT_APP_ID;
    if (!gatewayUrl || !applicationServerKey || !appId) {
        throw new Error("CFS Web Push is enabled but its runtime configuration is incomplete");
    }

    const parsedGateway = new URL(gatewayUrl);
    if (
        parsedGateway.protocol !== "https:" ||
        parsedGateway.hostname !== "chat-push.collectorfigures.com" ||
        parsedGateway.port !== "" ||
        parsedGateway.username !== "" ||
        parsedGateway.password !== "" ||
        !["", "/"].includes(parsedGateway.pathname) ||
        parsedGateway.search !== "" ||
        parsedGateway.hash !== "" ||
        parsedGateway.origin !== EXPECTED_GATEWAY
    ) {
        throw new Error(`CFS Web Push gateway must be exactly ${EXPECTED_GATEWAY}`);
    }
    if (appId !== DEFAULT_APP_ID) {
        throw new Error(`Unexpected CFS Web Push app_id: ${appId}`);
    }

    return {
        gatewayUrl: parsedGateway.origin,
        applicationServerKey,
        appId,
    };
}

function validateSubscriptionEndpoint(endpoint: string): void {
    let parsed: URL;
    try {
        parsed = new URL(endpoint);
    } catch {
        throw new Error("Browser returned a malformed Web Push endpoint");
    }
    const hostname = parsed.hostname.toLowerCase();
    const allowed =
        hostname === "updates.push.services.mozilla.com" ||
        hostname === "fcm.googleapis.com" ||
        (hostname.endsWith(".notify.windows.com") && hostname !== "notify.windows.com");
    if (
        parsed.protocol !== "https:" ||
        parsed.port !== "" ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.hash !== "" ||
        parsed.pathname === "/" ||
        !allowed
    ) {
        throw new Error("Browser returned a disallowed Web Push endpoint");
    }
}

function readStoredRegistration(): StoredRegistration | undefined {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as Partial<StoredRegistration>;
        if (!parsed.appId || !parsed.pushKey || !parsed.endpoint || !parsed.deviceId) return undefined;
        return parsed as StoredRegistration;
    } catch {
        return undefined;
    }
}

function writeStoredRegistration(registration: StoredRegistration): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(registration));
}

function clearStoredRegistration(): void {
    localStorage.removeItem(STORAGE_KEY);
}

function cleanupCacheUrl(path: string): string {
    return new URL(path, window.location.origin).href;
}

async function readCleanupTombstone(): Promise<CleanupTombstone | undefined> {
    if (!("caches" in window)) return undefined;
    try {
        const cache = await window.caches.open(CLEANUP_CACHE);
        const response = await cache.match(cleanupCacheUrl(CLEANUP_PATH));
        if (!response) return undefined;
        const value = (await response.json()) as Partial<CleanupTombstone>;
        const targets = Array.isArray(value.targets)
            ? value.targets
                  .filter(
                      (target): target is CleanupTarget =>
                          target?.appId === DEFAULT_APP_ID &&
                          typeof target.pushKey === "string" &&
                          target.pushKey.length > 0 &&
                          target.pushKey.length <= 512,
                  )
                  .slice(0, 8)
            : [];
        return {
            deviceId: typeof value.deviceId === "string" ? value.deviceId.slice(0, 255) : undefined,
            targets,
            needsEnumeration: value.needsEnumeration === true,
            browserUnsubscribePending: value.browserUnsubscribePending === true,
        };
    } catch (error) {
        logger.warn("Unable to read CFS Web Push cleanup tombstone", error);
        return undefined;
    }
}

async function writeCleanupTombstone(tombstone: CleanupTombstone): Promise<void> {
    if (!("caches" in window)) {
        logger.warn("Cache Storage is unavailable; CFS Web Push cleanup retry state cannot be persisted");
        return;
    }
    const uniqueTargets = new Map<string, CleanupTarget>();
    for (const target of tombstone.targets) {
        if (target.appId !== DEFAULT_APP_ID || !target.pushKey || target.pushKey.length > 512) continue;
        uniqueTargets.set(`${target.appId}\u0000${target.pushKey}`, target);
    }
    const value: CleanupTombstone = {
        deviceId: tombstone.deviceId?.slice(0, 255),
        targets: [...uniqueTargets.values()].slice(0, 8),
        needsEnumeration: tombstone.needsEnumeration,
        browserUnsubscribePending: tombstone.browserUnsubscribePending,
    };
    const cache = await window.caches.open(CLEANUP_CACHE);
    await cache.put(
        cleanupCacheUrl(CLEANUP_PATH),
        new Response(JSON.stringify(value), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        }),
    );
}

async function clearCleanupTombstone(): Promise<void> {
    if (!("caches" in window)) return;
    const cache = await window.caches.open(CLEANUP_CACHE);
    await cache.delete(cleanupCacheUrl(CLEANUP_PATH));
}

async function consumeSubscriptionChangeMarker(): Promise<boolean> {
    if (!("caches" in window)) return false;
    const cache = await window.caches.open(CLEANUP_CACHE);
    const marker = await cache.match(cleanupCacheUrl(SUBSCRIPTION_CHANGE_PATH));
    if (!marker) return false;
    await cache.delete(cleanupCacheUrl(SUBSCRIPTION_CHANGE_PATH));
    return true;
}

function supportsWebPush(): boolean {
    return (
        window.isSecureContext && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window
    );
}

async function getPushRegistration(): Promise<ServiceWorkerRegistration> {
    const registration = await navigator.serviceWorker.register(CFS_PUSH_WORKER, { scope: CFS_PUSH_SCOPE });
    await registration.update();
    return registration;
}

async function unsubscribeBrowser(registration?: ServiceWorkerRegistration): Promise<void> {
    if (!("serviceWorker" in navigator)) return;
    const resolved = registration ?? (await navigator.serviceWorker.getRegistration(CFS_PUSH_SCOPE));
    const subscription = await resolved?.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
}

async function retryCfsWebPushCleanup(client: MatrixClient): Promise<boolean> {
    const tombstone = await readCleanupTombstone();
    if (!tombstone) return true;

    const targets = new Map(tombstone.targets.map((target) => [`${target.appId}\u0000${target.pushKey}`, target]));
    let needsEnumeration = tombstone.needsEnumeration;
    if (needsEnumeration) {
        try {
            const { pushers } = await client.getPushers();
            for (const pusher of pushers) {
                if (pusher.app_id !== DEFAULT_APP_ID || pusher.kind !== "http") continue;
                const data = pusher.data as Record<string, unknown> | undefined;
                if (tombstone.deviceId && data?.device_id !== tombstone.deviceId) continue;
                targets.set(`${pusher.app_id}\u0000${pusher.pushkey}`, {
                    appId: pusher.app_id,
                    pushKey: pusher.pushkey,
                });
            }
            needsEnumeration = false;
        } catch (error) {
            logger.warn("Unable to enumerate stale CFS Web Push pushers", error);
        }
    }

    const remaining: CleanupTarget[] = [];
    for (const target of targets.values()) {
        try {
            await client.removePusher(target.pushKey, target.appId);
        } catch (error) {
            remaining.push(target);
            logger.warn("Unable to remove stale CFS Web Push pusher", error);
        }
    }

    let browserUnsubscribePending = tombstone.browserUnsubscribePending;
    if (browserUnsubscribePending) {
        try {
            await unsubscribeBrowser();
            browserUnsubscribePending = false;
        } catch (error) {
            logger.warn("Unable to remove stale browser Push subscription", error);
        }
    }

    if (!needsEnumeration && remaining.length === 0 && !browserUnsubscribePending) {
        await clearCleanupTombstone();
        return true;
    }
    await writeCleanupTombstone({
        deviceId: tombstone.deviceId,
        targets: remaining,
        needsEnumeration,
        browserUnsubscribePending,
    });
    return false;
}

export async function getCfsWebPushStatus(): Promise<CfsWebPushStatus> {
    const available = supportsWebPush();
    let configured = false;
    try {
        configured = Boolean(getConfig());
    } catch (error) {
        logger.error("Invalid CFS Web Push configuration", error);
    }

    if (!available) {
        return { available: false, configured, enabled: false, permission: "unsupported" };
    }

    const registration = await navigator.serviceWorker.getRegistration(CFS_PUSH_SCOPE);
    const subscription = await registration?.pushManager.getSubscription();
    return {
        available: true,
        configured,
        enabled: Boolean(subscription && readStoredRegistration()),
        permission: Notification.permission,
    };
}

export async function enableCfsWebPush(client: MatrixClient, requestPermission: boolean): Promise<void> {
    const config = getConfig();
    if (!config) throw new Error("CFS Web Push is disabled");
    if (!supportsWebPush()) throw new Error("This browser does not support Web Push");

    let permission = Notification.permission;
    if (permission === "default" && requestPermission) {
        permission = await Notification.requestPermission();
    }
    if (permission !== "granted") {
        throw new Error(
            permission === "denied" ? "Notification permission is blocked" : "Notification permission is required",
        );
    }

    const deviceId = client.getDeviceId();
    if (!deviceId) throw new Error("Cannot register Web Push without a Matrix device ID");
    if (!(await retryCfsWebPushCleanup(client))) {
        throw new Error("Previous CFS Web Push cleanup is still pending");
    }
    await consumeSubscriptionChangeMarker();

    const registration = await getPushRegistration();
    const existing = await registration.pushManager.getSubscription();
    const subscription =
        existing ??
        (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: decodeBase64Url(config.applicationServerKey),
        }));
    const serialized = subscription.toJSON();
    const endpoint = serialized.endpoint;
    const pushKey = serialized.keys?.p256dh;
    const auth = serialized.keys?.auth;
    if (!endpoint || !pushKey || !auth) {
        await subscription.unsubscribe();
        throw new Error("Browser returned an incomplete Web Push subscription");
    }
    try {
        validateSubscriptionEndpoint(endpoint);
    } catch (error) {
        await subscription.unsubscribe();
        throw error;
    }

    const stored = readStoredRegistration();
    if (stored?.appId === config.appId && stored.deviceId === deviceId && stored.pushKey !== pushKey) {
        try {
            await client.removePusher(stored.pushKey, stored.appId);
        } catch (error) {
            await writeCleanupTombstone({
                deviceId,
                targets: [{ appId: stored.appId, pushKey: stored.pushKey }],
                needsEnumeration: false,
                browserUnsubscribePending: false,
            });
            throw new AggregateError([error], "Stale CFS Web Push pusher cleanup failed");
        }
    }

    const fingerprint = await accountFingerprint(config.appId, deviceId);
    const pusher = {
        kind: "http",
        app_id: config.appId,
        app_display_name: "Collector Figures Web Push",
        device_display_name: "Collector Figures Web/PWA",
        pushkey: pushKey,
        lang: navigator.language,
        data: {
            url: `${config.gatewayUrl}/_matrix/push/v1/notify`,
            endpoint,
            auth,
            events_only: true,
            only_last_per_room: true,
            format: "event_id_only",
            device_id: deviceId,
            default_payload: {
                cfs_schema: 1,
                cfs_account_fingerprint: fingerprint,
            },
        },
        append: true,
    } as unknown as Parameters<MatrixClient["setPusher"]>[0];
    try {
        await client.setPusher(pusher);
    } catch (error) {
        let browserUnsubscribePending = false;
        const failures: unknown[] = [error];
        if (!existing) {
            try {
                await subscription.unsubscribe();
            } catch (unsubscribeError) {
                browserUnsubscribePending = true;
                failures.push(unsubscribeError);
            }
        }
        await writeCleanupTombstone({
            deviceId,
            targets: [{ appId: config.appId, pushKey }],
            needsEnumeration: false,
            browserUnsubscribePending,
        });
        throw new AggregateError(failures, "Matrix pusher registration failed and was queued for cleanup");
    }

    writeStoredRegistration({ appId: config.appId, pushKey, endpoint, deviceId });
    await clearCleanupTombstone();
}

export async function ensureCfsWebPushForGrantedPermission(client: MatrixClient): Promise<void> {
    if (!supportsWebPush() || Notification.permission !== "granted") return;
    if (!getConfig()) return;
    if (!(await retryCfsWebPushCleanup(client))) return;
    await enableCfsWebPush(client, false);
}

export async function disableCfsWebPush(client: MatrixClient): Promise<void> {
    let config: CfsWebPushConfig | undefined;
    try {
        config = getConfig();
    } catch (error) {
        logger.warn("Ignoring invalid runtime config while cleaning up the CFS Web Push registration", error);
    }
    const stored = readStoredRegistration();
    const appId = config?.appId ?? stored?.appId ?? DEFAULT_APP_ID;
    const deviceId = client.getDeviceId();
    const targets = new Map<string, string>();
    const failures: unknown[] = [];
    let needsEnumeration = false;

    if (stored?.appId === appId) targets.set(`${stored.appId}\u0000${stored.pushKey}`, stored.pushKey);
    try {
        const { pushers } = await client.getPushers();
        for (const pusher of pushers) {
            if (pusher.app_id !== appId || pusher.kind !== "http") continue;
            const data = pusher.data as Record<string, unknown> | undefined;
            if (deviceId && data?.device_id !== deviceId && pusher.pushkey !== stored?.pushKey) continue;
            targets.set(`${pusher.app_id}\u0000${pusher.pushkey}`, pusher.pushkey);
        }
    } catch (error) {
        needsEnumeration = true;
        failures.push(error);
        logger.warn("Unable to enumerate CFS Web Push pushers; removing the locally tracked pusher", error);
    }

    const failedTargets: CleanupTarget[] = [];
    for (const pushKey of targets.values()) {
        try {
            await client.removePusher(pushKey, appId);
        } catch (error) {
            failures.push(error);
            failedTargets.push({ appId, pushKey });
        }
    }

    let browserUnsubscribePending = false;
    try {
        await unsubscribeBrowser();
    } catch (error) {
        failures.push(error);
        browserUnsubscribePending = true;
    }
    clearStoredRegistration();

    if (needsEnumeration || failedTargets.length > 0 || browserUnsubscribePending) {
        await writeCleanupTombstone({
            deviceId: deviceId ?? stored?.deviceId,
            targets: failedTargets,
            needsEnumeration,
            browserUnsubscribePending,
        });
    } else {
        await clearCleanupTombstone();
    }

    if (failures.length > 0) {
        throw new AggregateError(failures, "CFS Web Push cleanup was incomplete");
    }
}

export async function clearLocalCfsWebPushAfterSessionEnd(): Promise<void> {
    const stored = readStoredRegistration();
    const existing = await readCleanupTombstone();
    try {
        await unsubscribeBrowser();
        if (existing) {
            await writeCleanupTombstone({ ...existing, browserUnsubscribePending: false });
        }
    } catch (error) {
        logger.warn("Browser Push subscription cleanup failed during local logout wipe", error);
        try {
            await writeCleanupTombstone({
                deviceId: existing?.deviceId ?? stored?.deviceId,
                targets: existing?.targets ?? (stored ? [{ appId: stored.appId, pushKey: stored.pushKey }] : []),
                needsEnumeration: existing?.needsEnumeration ?? Boolean(stored),
                browserUnsubscribePending: true,
            });
        } catch (tombstoneError) {
            logger.warn("Unable to persist CFS Web Push cleanup retry state", tombstoneError);
        }
    } finally {
        clearStoredRegistration();
    }
}
