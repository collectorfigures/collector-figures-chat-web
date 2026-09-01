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
const ENROLLMENT_KEY = "cfs_webpush_enrollment_v1";
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
    ownerFingerprint: string;
}

interface CfsWebPushEnrollment {
    state: "enabled" | "disabled";
    deviceId: string;
    ownerFingerprint: string;
}

interface CleanupTarget {
    appId: string;
    pushKey: string;
}

interface CleanupTombstone {
    deviceId: string;
    ownerFingerprint: string;
    targets: CleanupTarget[];
    browserUnsubscribePending: boolean;
}

interface OwnerContext {
    deviceId: string;
    ownerFingerprint: string;
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

async function accountFingerprint(appId: string, userId: string, deviceId: string): Promise<string> {
    const input = new TextEncoder().encode(`${appId}\u0000${userId}\u0000${deviceId}`);
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
    if (
        parsed.protocol !== "https:" ||
        parsed.port !== "" ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.hash !== "" ||
        parsed.pathname === "/"
    ) {
        throw new Error("Browser returned a disallowed Web Push endpoint");
    }

    const hostname = parsed.hostname.toLowerCase();
    const opaquePathToken = "[A-Za-z0-9:_-]{16,1024}";
    const mozillaPath = new RegExp(`^/wpush/v2/${opaquePathToken}$`);
    const fcmPath = new RegExp(`^/(?:fcm/send|wp)/${opaquePathToken}$`);
    const windowsHost = /^[a-z0-9-]+\.notify\.windows\.com$/;
    const windowsQuery = /^\?token=[A-Za-z0-9%._~-]{16,1900}$/;
    const validProviderShape =
        (hostname === "updates.push.services.mozilla.com" && mozillaPath.test(parsed.pathname) && parsed.search === "") ||
        (hostname === "fcm.googleapis.com" && fcmPath.test(parsed.pathname) && parsed.search === "") ||
        (windowsHost.test(hostname) && parsed.pathname === "/w/" && windowsQuery.test(parsed.search));
    if (!validProviderShape) {
        throw new Error("Browser returned a disallowed Web Push endpoint");
    }
}

function readStoredRegistration(): StoredRegistration | undefined {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as Partial<StoredRegistration>;
        if (
            !parsed.appId ||
            !parsed.pushKey ||
            !parsed.endpoint ||
            !parsed.deviceId ||
            !parsed.ownerFingerprint ||
            !/^[A-Za-z0-9_-]{22}$/.test(parsed.ownerFingerprint)
        ) {
            return undefined;
        }
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

function readEnrollment(): CfsWebPushEnrollment | undefined {
    try {
        const raw = localStorage.getItem(ENROLLMENT_KEY);
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as Partial<CfsWebPushEnrollment>;
        if (
            !["enabled", "disabled"].includes(parsed.state ?? "") ||
            !parsed.deviceId ||
            !parsed.ownerFingerprint ||
            !/^[A-Za-z0-9_-]{22}$/.test(parsed.ownerFingerprint)
        ) {
            return undefined;
        }
        return parsed as CfsWebPushEnrollment;
    } catch {
        return undefined;
    }
}

function writeEnrollment(enrollment: CfsWebPushEnrollment): void {
    localStorage.setItem(ENROLLMENT_KEY, JSON.stringify(enrollment));
}

function clearEnrollment(): void {
    localStorage.removeItem(ENROLLMENT_KEY);
}

async function resolveOwnerContext(
    client: MatrixClient,
    appId: string,
    stored?: StoredRegistration,
): Promise<OwnerContext> {
    const userId = client.getUserId();
    if (!userId) throw new Error("Cannot manage Web Push without an exact Matrix account");

    const clientDeviceId = client.getDeviceId();
    const deviceId = clientDeviceId ?? stored?.deviceId;
    if (!deviceId) throw new Error("Cannot manage Web Push without an exact Matrix device ID");

    const ownerFingerprint = await accountFingerprint(appId, userId, deviceId);
    if (!clientDeviceId && stored?.ownerFingerprint !== ownerFingerprint) {
        throw new Error("Stored Web Push device does not belong to the current Matrix account");
    }
    return { deviceId, ownerFingerprint };
}

function cleanupCacheUrl(path: string, ownerFingerprint?: string): string {
    const url = new URL(path, window.location.origin);
    if (ownerFingerprint) url.searchParams.set("owner", ownerFingerprint);
    return url.href;
}

async function readCleanupTombstone(ownerFingerprint: string): Promise<CleanupTombstone | undefined> {
    if (!("caches" in window)) return undefined;
    try {
        const cache = await window.caches.open(CLEANUP_CACHE);
        const response = await cache.match(cleanupCacheUrl(CLEANUP_PATH, ownerFingerprint));
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
        if (
            value.ownerFingerprint !== ownerFingerprint ||
            typeof value.deviceId !== "string" ||
            value.deviceId.length === 0 ||
            value.deviceId.length > 255
        ) {
            return undefined;
        }
        return {
            deviceId: value.deviceId,
            ownerFingerprint,
            targets,
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
        deviceId: tombstone.deviceId.slice(0, 255),
        ownerFingerprint: tombstone.ownerFingerprint,
        targets: [...uniqueTargets.values()].slice(0, 8),
        browserUnsubscribePending: tombstone.browserUnsubscribePending,
    };
    const cache = await window.caches.open(CLEANUP_CACHE);
    await cache.put(
        cleanupCacheUrl(CLEANUP_PATH, tombstone.ownerFingerprint),
        new Response(JSON.stringify(value), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        }),
    );
}

async function clearCleanupTombstone(ownerFingerprint: string): Promise<void> {
    if (!("caches" in window)) return;
    const cache = await window.caches.open(CLEANUP_CACHE);
    await cache.delete(cleanupCacheUrl(CLEANUP_PATH, ownerFingerprint));
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

async function retryCfsWebPushCleanup(client: MatrixClient, owner: OwnerContext): Promise<boolean> {
    const tombstone = await readCleanupTombstone(owner.ownerFingerprint);
    if (!tombstone) return true;
    if (tombstone.deviceId !== owner.deviceId) return false;

    const targets = new Map(tombstone.targets.map((target) => [`${target.appId}\u0000${target.pushKey}`, target]));
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

    if (remaining.length === 0 && !browserUnsubscribePending) {
        await clearCleanupTombstone(owner.ownerFingerprint);
        return true;
    }
    await writeCleanupTombstone({
        deviceId: tombstone.deviceId,
        ownerFingerprint: tombstone.ownerFingerprint,
        targets: remaining,
        browserUnsubscribePending,
    });
    return false;
}

export async function isCfsWebPushEnrollmentEnabledForClient(client: MatrixClient): Promise<boolean> {
    let config: CfsWebPushConfig | undefined;
    try {
        config = getConfig();
    } catch {
        return false;
    }
    if (!config) return false;
    const stored = readStoredRegistration();
    const enrollment = readEnrollment();
    if (!stored || !enrollment || enrollment.state !== "enabled") return false;
    try {
        const owner = await resolveOwnerContext(client, config.appId, stored);
        return (
            stored.appId === config.appId &&
            stored.ownerFingerprint === owner.ownerFingerprint &&
            stored.deviceId === owner.deviceId &&
            enrollment.ownerFingerprint === owner.ownerFingerprint &&
            enrollment.deviceId === owner.deviceId
        );
    } catch {
        return false;
    }
}

export async function getCfsWebPushStatus(client: MatrixClient): Promise<CfsWebPushStatus> {
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
    const stored = readStoredRegistration();
    const ownerMatches = Boolean(stored && (await isCfsWebPushEnrollmentEnabledForClient(client)));
    return {
        available: true,
        configured,
        enabled: Boolean(subscription && ownerMatches),
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

    const stored = readStoredRegistration();
    const owner = await resolveOwnerContext(client, config.appId, stored);
    if (!(await retryCfsWebPushCleanup(client, owner))) {
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

    if (
        stored?.appId === config.appId &&
        stored.deviceId === owner.deviceId &&
        stored.ownerFingerprint === owner.ownerFingerprint &&
        stored.pushKey !== pushKey
    ) {
        try {
            await client.removePusher(stored.pushKey, stored.appId);
        } catch (error) {
            await writeCleanupTombstone({
                deviceId: owner.deviceId,
                ownerFingerprint: owner.ownerFingerprint,
                targets: [{ appId: stored.appId, pushKey: stored.pushKey }],
                browserUnsubscribePending: false,
            });
            throw new AggregateError([error], "Stale CFS Web Push pusher cleanup failed");
        }
    }

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
            device_id: owner.deviceId,
            default_payload: {
                cfs_schema: 1,
                cfs_account_fingerprint: owner.ownerFingerprint,
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
            deviceId: owner.deviceId,
            ownerFingerprint: owner.ownerFingerprint,
            targets: [{ appId: config.appId, pushKey }],
            browserUnsubscribePending,
        });
        throw new AggregateError(failures, "Matrix pusher registration failed and was queued for cleanup");
    }

    writeStoredRegistration({
        appId: config.appId,
        pushKey,
        endpoint,
        deviceId: owner.deviceId,
        ownerFingerprint: owner.ownerFingerprint,
    });
    writeEnrollment({
        state: "enabled",
        deviceId: owner.deviceId,
        ownerFingerprint: owner.ownerFingerprint,
    });
    await clearCleanupTombstone(owner.ownerFingerprint);
}

export async function ensureCfsWebPushForGrantedPermission(client: MatrixClient): Promise<void> {
    if (!supportsWebPush() || Notification.permission !== "granted") return;
    const config = getConfig();
    if (!config) return;
    if (!(await isCfsWebPushEnrollmentEnabledForClient(client))) return;
    const stored = readStoredRegistration();
    const enrollment = readEnrollment();
    if (!stored || !enrollment) return;

    let owner: OwnerContext;
    try {
        owner = await resolveOwnerContext(client, config.appId, stored);
    } catch {
        return;
    }
    if (
        stored.appId !== config.appId ||
        stored.deviceId !== owner.deviceId ||
        stored.ownerFingerprint !== owner.ownerFingerprint ||
        enrollment.deviceId !== owner.deviceId ||
        enrollment.ownerFingerprint !== owner.ownerFingerprint
    ) {
        return;
    }
    if (!(await retryCfsWebPushCleanup(client, owner))) return;
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
    try {
        const owner = await resolveOwnerContext(client, appId, stored);
        writeEnrollment({ state: "disabled", deviceId: owner.deviceId, ownerFingerprint: owner.ownerFingerprint });
        if (
            !stored ||
            stored.appId !== appId ||
            stored.deviceId !== owner.deviceId ||
            stored.ownerFingerprint !== owner.ownerFingerprint
        ) {
            throw new Error("Cannot clean up Web Push without an exact owner-bound pusher target");
        }

        const failures: unknown[] = [];
        const failedTargets: CleanupTarget[] = [];
        try {
            await client.removePusher(stored.pushKey, stored.appId);
        } catch (error) {
            failures.push(error);
            failedTargets.push({ appId: stored.appId, pushKey: stored.pushKey });
        }

        let browserUnsubscribePending = false;
        try {
            await unsubscribeBrowser();
        } catch (error) {
            failures.push(error);
            browserUnsubscribePending = true;
        }
        clearStoredRegistration();

        if (failedTargets.length > 0 || browserUnsubscribePending) {
            await writeCleanupTombstone({
                deviceId: owner.deviceId,
                ownerFingerprint: owner.ownerFingerprint,
                targets: failedTargets,
                browserUnsubscribePending,
            });
        } else {
            await clearCleanupTombstone(owner.ownerFingerprint);
        }

        if (failures.length > 0) {
            throw new AggregateError(failures, "CFS Web Push cleanup was incomplete");
        }
    } catch (error) {
        if (!readEnrollment() || readEnrollment()?.state !== "disabled") clearEnrollment();
        throw error;
    }
}

export async function clearLocalCfsWebPushAfterSessionEnd(): Promise<void> {
    const stored = readStoredRegistration();
    const enrollment = readEnrollment();
    clearEnrollment();
    const ownerFingerprint = enrollment?.ownerFingerprint ?? stored?.ownerFingerprint;
    const deviceId = enrollment?.deviceId ?? stored?.deviceId;
    if (!ownerFingerprint || !deviceId) {
        clearStoredRegistration();
        return;
    }

    const existing = await readCleanupTombstone(ownerFingerprint);
    const targets = existing?.targets ??
        (stored?.ownerFingerprint === ownerFingerprint ? [{ appId: stored.appId, pushKey: stored.pushKey }] : []);
    try {
        await unsubscribeBrowser();
        if (targets.length > 0) {
            await writeCleanupTombstone({
                deviceId,
                ownerFingerprint,
                targets,
                browserUnsubscribePending: false,
            });
        } else {
            await clearCleanupTombstone(ownerFingerprint);
        }
    } catch (error) {
        logger.warn("Browser Push subscription cleanup failed during local logout wipe", error);
        try {
            await writeCleanupTombstone({
                deviceId,
                ownerFingerprint,
                targets,
                browserUnsubscribePending: true,
            });
        } catch (tombstoneError) {
            logger.warn("Unable to persist CFS Web Push cleanup retry state", tombstoneError);
        }
    } finally {
        clearStoredRegistration();
        clearEnrollment();
    }
}
