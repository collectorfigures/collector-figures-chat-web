/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import { logger } from "matrix-js-sdk/src/logger";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import SdkConfig from "../SdkConfig";

import {
    assertCurrentCfsWebPushMutation,
    type CfsWebPushMutation,
    isCurrentCfsWebPushMutation,
    publishCfsWebPushMutation,
    SupersededCfsWebPushMutationError,
    supersedeCfsWebPushMutation,
    waitForCurrentCfsWebPushMutation,
} from "./mutationCoordinator";

const CFS_PUSH_SCOPE = "/cfs-push/";
const CFS_PUSH_WORKER = `${CFS_PUSH_SCOPE}sw.js`;
const STORAGE_KEY = "cfs_webpush_registration_v1";
const ENROLLMENT_KEY = "cfs_webpush_enrollment_v1";
const CLEANUP_CACHE = "cfs-webpush-cleanup-v1";
const CLEANUP_PATH = `${CFS_PUSH_SCOPE}cleanup-retry.json`;
const ACTIVE_OWNER_PATH = `${CFS_PUSH_SCOPE}active-owner.json`;
const SUBSCRIPTION_CHANGE_PATH = `${CFS_PUSH_SCOPE}subscription-change`;
const DEFAULT_APP_ID = "com.collectorfigures.chat.web";
const EXPECTED_GATEWAY = "https://chat-push.collectorfigures.com";

interface StoredRegistration {
    appId: string;
    pushKey: string;
    endpoint: string;
    deviceId: string;
    ownerFingerprint: string;
    operationId: string;
}

interface CfsWebPushEnrollment {
    state: "enabled" | "disabled";
    deviceId: string;
    ownerFingerprint: string;
    operationId: string;
}

interface ActiveOwnerMarker {
    cfs_schema: 1;
    ownerFingerprint: string;
    operationId: string;
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

export type CfsWebPushCommitPhase =
    | "after-lock-assert-before-registration"
    | "after-registration-write-before-assert"
    | "after-enrollment-write-before-assert"
    | "active-owner-cache-write-pending";

type CfsWebPushCommitTestHook = (
    phase: CfsWebPushCommitPhase,
    operation: CfsWebPushMutation,
) => Promise<void>;

let commitTestHook: CfsWebPushCommitTestHook | undefined;

/** @internal Test-only deterministic interleaving hook. */
export function setCfsWebPushCommitTestHook(hook?: CfsWebPushCommitTestHook): void {
    commitTestHook = hook;
}

async function runCommitTestHook(phase: CfsWebPushCommitPhase, operation: CfsWebPushMutation): Promise<void> {
    if (commitTestHook) await commitTestHook(phase, operation);
}

async function waitForMutationIfPresent<T>(
    operation: CfsWebPushMutation | undefined,
    action: () => Promise<T>,
): Promise<T> {
    return operation ? waitForCurrentCfsWebPushMutation(operation, action) : action();
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

async function accountFingerprint(
    appId: string,
    userId: string,
    deviceId: string,
    operation?: CfsWebPushMutation,
): Promise<string> {
    const input = new TextEncoder().encode(`${appId}\u0000${userId}\u0000${deviceId}`);
    const digest = operation
        ? await waitForCurrentCfsWebPushMutation(operation, () => crypto.subtle.digest("SHA-256", input))
        : await crypto.subtle.digest("SHA-256", input);
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

export function validateSubscriptionEndpoint(endpoint: string): void {
    if (endpoint.length === 0 || endpoint.length > 2048) {
        throw new Error("Browser returned a disallowed Web Push endpoint");
    }
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
        parsed.hash !== ""
    ) {
        throw new Error("Browser returned a disallowed Web Push endpoint");
    }

    const hostname = parsed.hostname.toLowerCase();
    const opaquePathToken = "[A-Za-z0-9:_-]{16,1024}";
    const mozillaPath = new RegExp(`^/wpush/v2/${opaquePathToken}$`);
    const fcmPath = new RegExp(`^/(?:fcm/send|wp)/${opaquePathToken}$`);
    const windowsHost = /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/;
    const validProviderShape =
        (hostname === "updates.push.services.mozilla.com" && mozillaPath.test(parsed.pathname) && parsed.search === "") ||
        (hostname === "fcm.googleapis.com" && fcmPath.test(parsed.pathname) && parsed.search === "") ||
        windowsHost.test(hostname);
    if (!validProviderShape) {
        throw new Error("Browser returned a disallowed Web Push endpoint");
    }
}

function isOperationId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    );
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
            !/^[A-Za-z0-9_-]{22}$/.test(parsed.ownerFingerprint) ||
            !isOperationId(parsed.operationId)
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
            !/^[A-Za-z0-9_-]{22}$/.test(parsed.ownerFingerprint) ||
            !isOperationId(parsed.operationId)
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
    operation?: CfsWebPushMutation,
): Promise<OwnerContext> {
    const userId = client.getUserId();
    if (!userId) throw new Error("Cannot manage Web Push without an exact Matrix account");

    const clientDeviceId = client.getDeviceId();
    const deviceId = clientDeviceId ?? stored?.deviceId;
    if (!deviceId) throw new Error("Cannot manage Web Push without an exact Matrix device ID");

    const ownerFingerprint = await accountFingerprint(appId, userId, deviceId, operation);
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

async function withCfsWebPushStateLock<T>(action: () => Promise<T>): Promise<T> {
    if (!("locks" in navigator)) throw new Error("Web Locks is unavailable for cross-page Push ownership");
    return navigator.locks.request("cfs-webpush-state-v1", { mode: "exclusive" }, action);
}

async function mutateActiveOwnerMarker<T>(operation: CfsWebPushMutation, action: () => Promise<T>): Promise<T> {
    return waitForCurrentCfsWebPushMutation(operation, () =>
        withCfsWebPushStateLock(async () => {
            assertCurrentCfsWebPushMutation(operation);
            const result = await action();
            assertCurrentCfsWebPushMutation(operation);
            return result;
        }),
    );
}

async function readActiveOwnerMarkerRecord(operation?: CfsWebPushMutation): Promise<ActiveOwnerMarker | undefined> {
    if (!("caches" in window)) return undefined;
    try {
        const cache = await waitForMutationIfPresent(operation, () => window.caches.open(CLEANUP_CACHE));
        const response = await waitForMutationIfPresent(operation, () =>
            cache.match(cleanupCacheUrl(ACTIVE_OWNER_PATH)),
        );
        if (!response) return undefined;
        const marker = (await waitForMutationIfPresent(operation, () => response.json())) as Partial<ActiveOwnerMarker>;
        return marker.cfs_schema === 1 &&
            typeof marker.ownerFingerprint === "string" &&
            /^[A-Za-z0-9_-]{22}$/.test(marker.ownerFingerprint) &&
            isOperationId(marker.operationId)
            ? (marker as ActiveOwnerMarker)
            : undefined;
    } catch {
        return undefined;
    }
}

async function clearActiveOwnerMarker(operation: CfsWebPushMutation): Promise<void> {
    if (!("caches" in window)) return;
    await mutateActiveOwnerMarker(operation, async () => {
        const cache = await window.caches.open(CLEANUP_CACHE);
        assertCurrentCfsWebPushMutation(operation);
        await cache.delete(cleanupCacheUrl(ACTIVE_OWNER_PATH));
        assertCurrentCfsWebPushMutation(operation);
    });
    assertCurrentCfsWebPushMutation(operation);
}

async function commitCfsWebPushOwnerState(
    registration: Omit<StoredRegistration, "operationId">,
    enrollment: Omit<CfsWebPushEnrollment, "operationId">,
    operation: CfsWebPushMutation,
): Promise<void> {
    if (!("caches" in window)) throw new Error("Cache Storage is unavailable for the active Push owner marker");
    await withCfsWebPushStateLock(async () => {
        assertCurrentCfsWebPushMutation(operation);
        await runCommitTestHook("after-lock-assert-before-registration", operation);
        assertCurrentCfsWebPushMutation(operation);

        writeStoredRegistration({ ...registration, operationId: operation.operationId });
        await runCommitTestHook("after-registration-write-before-assert", operation);
        assertCurrentCfsWebPushMutation(operation);

        writeEnrollment({ ...enrollment, operationId: operation.operationId });
        await runCommitTestHook("after-enrollment-write-before-assert", operation);
        assertCurrentCfsWebPushMutation(operation);

        const cache = await window.caches.open(CLEANUP_CACHE);
        assertCurrentCfsWebPushMutation(operation);
        const marker: ActiveOwnerMarker = {
            cfs_schema: 1,
            ownerFingerprint: registration.ownerFingerprint,
            operationId: operation.operationId,
        };
        const markerWrite = cache.put(
            cleanupCacheUrl(ACTIVE_OWNER_PATH),
            new Response(JSON.stringify(marker), {
                headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
            }),
        );
        await runCommitTestHook("active-owner-cache-write-pending", operation);
        await markerWrite;
        assertCurrentCfsWebPushMutation(operation);
    });
    assertCurrentCfsWebPushMutation(operation);
}

async function compareAndDeleteCfsWebPushOwnerState(operation: CfsWebPushMutation): Promise<void> {
    await withCfsWebPushStateLock(async () => {
        if (readStoredRegistration()?.operationId === operation.operationId) clearStoredRegistration();
        if (readEnrollment()?.operationId === operation.operationId) clearEnrollment();
        if (!("caches" in window)) return;

        const cache = await window.caches.open(CLEANUP_CACHE);
        const response = await cache.match(cleanupCacheUrl(ACTIVE_OWNER_PATH));
        if (!response) return;
        const marker = (await response.json()) as Partial<ActiveOwnerMarker>;
        if (marker.operationId === operation.operationId) {
            await cache.delete(cleanupCacheUrl(ACTIVE_OWNER_PATH));
        }
    });
}

async function readCleanupTombstone(
    ownerFingerprint: string,
    operation?: CfsWebPushMutation,
): Promise<CleanupTombstone | undefined> {
    if (!("caches" in window)) return undefined;
    try {
        const cache = await waitForMutationIfPresent(operation, () => window.caches.open(CLEANUP_CACHE));
        const response = await waitForMutationIfPresent(operation, () =>
            cache.match(cleanupCacheUrl(CLEANUP_PATH, ownerFingerprint)),
        );
        if (!response) return undefined;
        const value = (await waitForMutationIfPresent(operation, () => response.json())) as Partial<CleanupTombstone>;
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

async function writeCleanupTombstone(
    tombstone: CleanupTombstone,
    operation?: CfsWebPushMutation,
): Promise<void> {
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
    const cache = await waitForMutationIfPresent(operation, () => window.caches.open(CLEANUP_CACHE));
    await waitForMutationIfPresent(operation, () =>
        cache.put(
            cleanupCacheUrl(CLEANUP_PATH, tombstone.ownerFingerprint),
            new Response(JSON.stringify(value), {
                headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
            }),
        ),
    );
}

async function clearCleanupTombstone(ownerFingerprint: string, operation?: CfsWebPushMutation): Promise<void> {
    if (!("caches" in window)) return;
    const cache = await waitForMutationIfPresent(operation, () => window.caches.open(CLEANUP_CACHE));
    await waitForMutationIfPresent(operation, () =>
        cache.delete(cleanupCacheUrl(CLEANUP_PATH, ownerFingerprint)),
    );
}

async function consumeSubscriptionChangeMarker(operation: CfsWebPushMutation): Promise<boolean> {
    if (!("caches" in window)) return false;
    const cache = await waitForCurrentCfsWebPushMutation(operation, () => window.caches.open(CLEANUP_CACHE));
    const marker = await waitForCurrentCfsWebPushMutation(operation, () =>
        cache.match(cleanupCacheUrl(SUBSCRIPTION_CHANGE_PATH)),
    );
    if (!marker) return false;
    await waitForCurrentCfsWebPushMutation(operation, () =>
        cache.delete(cleanupCacheUrl(SUBSCRIPTION_CHANGE_PATH)),
    );
    return true;
}

function supportsWebPush(): boolean {
    return (
        window.isSecureContext &&
        "Notification" in window &&
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "locks" in navigator
    );
}

async function getPushRegistration(operation: CfsWebPushMutation): Promise<ServiceWorkerRegistration> {
    const registration = await waitForCurrentCfsWebPushMutation(operation, () =>
        navigator.serviceWorker.register(CFS_PUSH_WORKER, { scope: CFS_PUSH_SCOPE }),
    );
    await waitForCurrentCfsWebPushMutation(operation, () => registration.update());
    return registration;
}

async function unsubscribeBrowser(
    registration?: ServiceWorkerRegistration,
    operation?: CfsWebPushMutation,
): Promise<void> {
    if (!("serviceWorker" in navigator)) return;
    const resolved =
        registration ??
        (await waitForMutationIfPresent(operation, () => navigator.serviceWorker.getRegistration(CFS_PUSH_SCOPE)));
    const subscription = await waitForMutationIfPresent(operation, async () => resolved?.pushManager.getSubscription());
    if (!subscription) return;
    const removed = await waitForMutationIfPresent(operation, () => subscription.unsubscribe());
    if (removed === false) throw new Error("Browser Push subscription unsubscribe was rejected");
    if (await waitForMutationIfPresent(operation, async () => resolved?.pushManager.getSubscription())) {
        throw new Error("Browser Push subscription still exists after unsubscribe");
    }
}

async function retryCfsWebPushCleanup(
    client: MatrixClient,
    owner: OwnerContext,
    operation: CfsWebPushMutation,
): Promise<boolean> {
    const tombstone = await readCleanupTombstone(owner.ownerFingerprint, operation);
    if (!tombstone) return true;
    if (tombstone.deviceId !== owner.deviceId) return false;

    const targets = new Map(tombstone.targets.map((target) => [`${target.appId}\u0000${target.pushKey}`, target]));
    const remaining: CleanupTarget[] = [];
    for (const target of targets.values()) {
        try {
            await waitForCurrentCfsWebPushMutation(operation, () => client.removePusher(target.pushKey, target.appId));
        } catch (error) {
            if (error instanceof SupersededCfsWebPushMutationError || !isCurrentCfsWebPushMutation(operation)) {
                throw error;
            }
            remaining.push(target);
            logger.warn("Unable to remove stale CFS Web Push pusher", error);
        }
    }

    let browserUnsubscribePending = tombstone.browserUnsubscribePending;
    if (browserUnsubscribePending) {
        try {
            await unsubscribeBrowser(undefined, operation);
            browserUnsubscribePending = false;
        } catch (error) {
            if (error instanceof SupersededCfsWebPushMutationError || !isCurrentCfsWebPushMutation(operation)) {
                throw error;
            }
            logger.warn("Unable to remove stale browser Push subscription", error);
        }
    }

    if (remaining.length === 0 && !browserUnsubscribePending) {
        await clearCleanupTombstone(owner.ownerFingerprint, operation);
        return true;
    }
    await writeCleanupTombstone(
        {
            deviceId: tombstone.deviceId,
            ownerFingerprint: tombstone.ownerFingerprint,
            targets: remaining,
            browserUnsubscribePending,
        },
        operation,
    );
    return false;
}

export async function isCfsWebPushEnrollmentEnabledForClient(
    client: MatrixClient,
    operation?: CfsWebPushMutation,
): Promise<boolean> {
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
        const owner = await resolveOwnerContext(client, config.appId, stored, operation);
        const marker = await readActiveOwnerMarkerRecord(operation);
        return (
            stored.appId === config.appId &&
            stored.ownerFingerprint === owner.ownerFingerprint &&
            stored.deviceId === owner.deviceId &&
            enrollment.ownerFingerprint === owner.ownerFingerprint &&
            enrollment.deviceId === owner.deviceId &&
            stored.operationId === enrollment.operationId &&
            marker?.operationId === stored.operationId &&
            marker.ownerFingerprint === owner.ownerFingerprint
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

async function cleanSupersededCfsWebPushEnable(
    client: MatrixClient,
    owner: OwnerContext,
    target: CleanupTarget,
    operation: CfsWebPushMutation,
    cause: unknown,
): Promise<never> {
    const failures: unknown[] = [cause];
    try {
        await client.removePusher(target.pushKey, target.appId);
    } catch (removeError) {
        failures.push(removeError);
        try {
            await writeCleanupTombstone({
                deviceId: owner.deviceId,
                ownerFingerprint: owner.ownerFingerprint,
                targets: [target],
                browserUnsubscribePending: false,
            });
        } catch (tombstoneError) {
            failures.push(tombstoneError);
        }
    }
    try {
        await compareAndDeleteCfsWebPushOwnerState(operation);
    } catch (stateError) {
        failures.push(stateError);
    }
    throw new AggregateError(failures, "CFS Web Push enable was superseded and exact cleanup was attempted");
}

async function enableCfsWebPushMutation(
    client: MatrixClient,
    requestPermission: boolean,
    operation: CfsWebPushMutation,
): Promise<void> {
    assertCurrentCfsWebPushMutation(operation);
    const config = getConfig();
    if (!config) throw new Error("CFS Web Push is disabled");
    if (!supportsWebPush()) throw new Error("This browser does not support Web Push");

    let permission = Notification.permission;
    if (permission === "default" && requestPermission) {
        permission = await waitForCurrentCfsWebPushMutation(operation, () => Notification.requestPermission());
    }
    if (permission !== "granted") {
        throw new Error(
            permission === "denied" ? "Notification permission is blocked" : "Notification permission is required",
        );
    }

    const stored = readStoredRegistration();
    const owner = await resolveOwnerContext(client, config.appId, stored, operation);
    assertCurrentCfsWebPushMutation(operation);
    if (!(await retryCfsWebPushCleanup(client, owner, operation))) {
        throw new Error("Previous CFS Web Push cleanup is still pending");
    }
    assertCurrentCfsWebPushMutation(operation);
    await consumeSubscriptionChangeMarker(operation);

    const registration = await getPushRegistration(operation);
    let existing = await waitForCurrentCfsWebPushMutation(operation, () =>
        registration.pushManager.getSubscription(),
    );
    const existingOwnerBound = Boolean(
        existing &&
            stored?.appId === config.appId &&
            stored.deviceId === owner.deviceId &&
            stored.ownerFingerprint === owner.ownerFingerprint,
    );
    if (existing && !existingOwnerBound) {
        await clearActiveOwnerMarker(operation);
        await unsubscribeBrowser(registration, operation);
        existing = await waitForCurrentCfsWebPushMutation(operation, () =>
            registration.pushManager.getSubscription(),
        );
        if (existing) throw new Error("Unowned browser Push subscription could not be removed");
    }
    assertCurrentCfsWebPushMutation(operation);
    const subscription =
        existing ??
        (await waitForCurrentCfsWebPushMutation(operation, () =>
            registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: decodeBase64Url(config.applicationServerKey),
            }),
        ));
    const createdBrowserSubscription = !existing;
    const serialized = subscription.toJSON();
    const endpoint = serialized.endpoint;
    const pushKey = serialized.keys?.p256dh;
    const auth = serialized.keys?.auth;
    if (!endpoint || !pushKey || !auth) {
        await unsubscribeBrowser(registration, operation);
        throw new Error("Browser returned an incomplete Web Push subscription");
    }
    try {
        validateSubscriptionEndpoint(endpoint);
    } catch (error) {
        await unsubscribeBrowser(registration, operation);
        throw error;
    }

    if (
        stored?.appId === config.appId &&
        stored.deviceId === owner.deviceId &&
        stored.ownerFingerprint === owner.ownerFingerprint &&
        stored.pushKey !== pushKey
    ) {
        try {
            await waitForCurrentCfsWebPushMutation(operation, () =>
                client.removePusher(stored.pushKey, stored.appId),
            );
        } catch (error) {
            if (isCurrentCfsWebPushMutation(operation)) {
                await writeCleanupTombstone(
                    {
                        deviceId: owner.deviceId,
                        ownerFingerprint: owner.ownerFingerprint,
                        targets: [{ appId: stored.appId, pushKey: stored.pushKey }],
                        browserUnsubscribePending: false,
                    },
                    operation,
                );
            }
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

    const ownTarget = { appId: config.appId, pushKey };
    let setPusherSucceeded = false;
    try {
        assertCurrentCfsWebPushMutation(operation);
        await client.setPusher(pusher);
        setPusherSucceeded = true;
        assertCurrentCfsWebPushMutation(operation);
    } catch (error) {
        if (!isCurrentCfsWebPushMutation(operation)) {
            if (setPusherSucceeded) {
                return cleanSupersededCfsWebPushEnable(client, owner, ownTarget, operation, error);
            }
            await compareAndDeleteCfsWebPushOwnerState(operation);
            throw new AggregateError([error], "CFS Web Push enable was superseded by another page");
        }

        let browserUnsubscribePending = false;
        const failures: unknown[] = [error];
        if (createdBrowserSubscription) {
            try {
                await unsubscribeBrowser(registration, operation);
            } catch (unsubscribeError) {
                browserUnsubscribePending = true;
                failures.push(unsubscribeError);
            }
        }
        if (browserUnsubscribePending) {
            await writeCleanupTombstone(
                {
                    deviceId: owner.deviceId,
                    ownerFingerprint: owner.ownerFingerprint,
                    targets: [],
                    browserUnsubscribePending,
                },
                operation,
            );
        }
        throw new AggregateError(failures, "Matrix pusher registration failed and was queued for cleanup");
    }

    try {
        assertCurrentCfsWebPushMutation(operation);
        await commitCfsWebPushOwnerState(
            {
                appId: config.appId,
                pushKey,
                endpoint,
                deviceId: owner.deviceId,
                ownerFingerprint: owner.ownerFingerprint,
            },
            {
                state: "enabled",
                deviceId: owner.deviceId,
                ownerFingerprint: owner.ownerFingerprint,
            },
            operation,
        );
        assertCurrentCfsWebPushMutation(operation);
        await clearCleanupTombstone(owner.ownerFingerprint, operation);
        assertCurrentCfsWebPushMutation(operation);
    } catch (error) {
        if (!isCurrentCfsWebPushMutation(operation) || error instanceof SupersededCfsWebPushMutationError) {
            return cleanSupersededCfsWebPushEnable(client, owner, ownTarget, operation, error);
        }

        const failures: unknown[] = [error];
        try {
            await compareAndDeleteCfsWebPushOwnerState(operation);
        } catch (stateError) {
            failures.push(stateError);
        }
        const targets: CleanupTarget[] = [];
        try {
            await waitForCurrentCfsWebPushMutation(operation, () =>
                client.removePusher(ownTarget.pushKey, ownTarget.appId),
            );
        } catch (removeError) {
            targets.push({ appId: config.appId, pushKey });
            failures.push(removeError);
        }
        let browserUnsubscribePending = false;
        if (createdBrowserSubscription) {
            try {
                await unsubscribeBrowser(registration, operation);
            } catch (unsubscribeError) {
                browserUnsubscribePending = true;
                failures.push(unsubscribeError);
            }
        }
        if (targets.length > 0 || browserUnsubscribePending) {
            await writeCleanupTombstone(
                {
                    deviceId: owner.deviceId,
                    ownerFingerprint: owner.ownerFingerprint,
                    targets,
                    browserUnsubscribePending,
                },
                operation,
            );
        }
        throw new AggregateError(failures, "CFS Web Push enable was superseded or could not persist owner state");
    }
}

export async function enableCfsWebPush(client: MatrixClient, requestPermission: boolean): Promise<void> {
    return enableCfsWebPushMutation(client, requestPermission, publishCfsWebPushMutation());
}

export async function ensureCfsWebPushForGrantedPermission(client: MatrixClient): Promise<void> {
    const operation = publishCfsWebPushMutation();
    if (!supportsWebPush() || Notification.permission !== "granted") return;
    const config = getConfig();
    if (!config) return;
    if (!(await isCfsWebPushEnrollmentEnabledForClient(client, operation))) return;
    assertCurrentCfsWebPushMutation(operation);
    const stored = readStoredRegistration();
    const enrollment = readEnrollment();
    if (!stored || !enrollment) return;

    let owner: OwnerContext;
    try {
        owner = await resolveOwnerContext(client, config.appId, stored, operation);
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
    if (!(await retryCfsWebPushCleanup(client, owner, operation))) return;
    assertCurrentCfsWebPushMutation(operation);
    await enableCfsWebPushMutation(client, false, operation);
    assertCurrentCfsWebPushMutation(operation);
}

async function disableCfsWebPushMutation(client: MatrixClient, operation: CfsWebPushMutation): Promise<void> {
    const failures: unknown[] = [];
    try {
        await clearActiveOwnerMarker(operation);
    } catch (error) {
        failures.push(error);
    }
    assertCurrentCfsWebPushMutation(operation);

    let config: CfsWebPushConfig | undefined;
    try {
        config = getConfig();
    } catch (error) {
        logger.warn("Ignoring invalid runtime config while cleaning up the CFS Web Push registration", error);
    }
    const stored = readStoredRegistration();
    const appId = config?.appId ?? stored?.appId ?? DEFAULT_APP_ID;
    let owner: OwnerContext | undefined;
    try {
        owner = await resolveOwnerContext(client, appId, stored, operation);
        assertCurrentCfsWebPushMutation(operation);
        clearEnrollment();
        assertCurrentCfsWebPushMutation(operation);
    } catch (error) {
        assertCurrentCfsWebPushMutation(operation);
        clearEnrollment();
        assertCurrentCfsWebPushMutation(operation);
        failures.push(error);
    }

    let browserUnsubscribePending = false;
    try {
        await unsubscribeBrowser(undefined, operation);
    } catch (error) {
        failures.push(error);
        browserUnsubscribePending = true;
    }
    assertCurrentCfsWebPushMutation(operation);

    const failedTargets: CleanupTarget[] = [];
    const exactTarget = Boolean(
        owner &&
            stored?.appId === appId &&
            stored.deviceId === owner.deviceId &&
            stored.ownerFingerprint === owner.ownerFingerprint,
    );
    if (exactTarget && owner && stored) {
        try {
            await waitForCurrentCfsWebPushMutation(operation, () =>
                client.removePusher(stored.pushKey, stored.appId),
            );
        } catch (error) {
            failures.push(error);
            failedTargets.push({ appId: stored.appId, pushKey: stored.pushKey });
        }
    } else {
        failures.push(new Error("Cannot clean up Web Push without an exact owner-bound pusher target"));
    }
    assertCurrentCfsWebPushMutation(operation);
    clearStoredRegistration();
    assertCurrentCfsWebPushMutation(operation);

    if (owner) {
        if (failedTargets.length > 0 || browserUnsubscribePending) {
            await writeCleanupTombstone(
                {
                    deviceId: owner.deviceId,
                    ownerFingerprint: owner.ownerFingerprint,
                    targets: failedTargets,
                    browserUnsubscribePending,
                },
                operation,
            );
        } else {
            await clearCleanupTombstone(owner.ownerFingerprint, operation);
        }
    }

    if (failures.length > 0) {
        throw new AggregateError(failures, "CFS Web Push cleanup was incomplete");
    }
}

export async function disableCfsWebPush(client: MatrixClient): Promise<void> {
    return disableCfsWebPushMutation(client, publishCfsWebPushMutation());
}

async function clearLocalCfsWebPushAfterSessionEndMutation(operation: CfsWebPushMutation): Promise<void> {
    try {
        await clearActiveOwnerMarker(operation);
    } catch (error) {
        logger.warn("Unable to clear the active CFS Web Push owner marker during logout", error);
    }
    assertCurrentCfsWebPushMutation(operation);

    const stored = readStoredRegistration();
    const enrollment = readEnrollment();
    clearEnrollment();
    assertCurrentCfsWebPushMutation(operation);
    const ownerFingerprint = enrollment?.ownerFingerprint ?? stored?.ownerFingerprint;
    const deviceId = enrollment?.deviceId ?? stored?.deviceId;

    const existing = ownerFingerprint ? await readCleanupTombstone(ownerFingerprint, operation) : undefined;
    const targets =
        existing?.targets ??
        (ownerFingerprint && stored?.ownerFingerprint === ownerFingerprint
            ? [{ appId: stored.appId, pushKey: stored.pushKey }]
            : []);
    try {
        await unsubscribeBrowser(undefined, operation);
        if (ownerFingerprint && deviceId && targets.length > 0) {
            await writeCleanupTombstone(
                {
                    deviceId,
                    ownerFingerprint,
                    targets,
                    browserUnsubscribePending: false,
                },
                operation,
            );
        } else if (ownerFingerprint) {
            await clearCleanupTombstone(ownerFingerprint, operation);
        }
    } catch (error) {
        if (error instanceof SupersededCfsWebPushMutationError || !isCurrentCfsWebPushMutation(operation)) {
            throw error;
        }
        logger.warn("Browser Push subscription cleanup failed during local logout wipe", error);
        try {
            assertCurrentCfsWebPushMutation(operation);
            if (!ownerFingerprint || !deviceId) throw new Error("No exact owner available for cleanup retry state");
            await writeCleanupTombstone(
                {
                    deviceId,
                    ownerFingerprint,
                    targets,
                    browserUnsubscribePending: true,
                },
                operation,
            );
        } catch (tombstoneError) {
            logger.warn("Unable to persist CFS Web Push cleanup retry state", tombstoneError);
        }
    } finally {
        if (isCurrentCfsWebPushMutation(operation)) {
            clearStoredRegistration();
            assertCurrentCfsWebPushMutation(operation);
            clearEnrollment();
            assertCurrentCfsWebPushMutation(operation);
        }
    }
}

export async function clearLocalCfsWebPushAfterSessionEnd(): Promise<void> {
    return clearLocalCfsWebPushAfterSessionEndMutation(publishCfsWebPushMutation());
}

export async function prepareCfsWebPushForAccountReplacement(client?: MatrixClient): Promise<void> {
    const operation = publishCfsWebPushMutation();
    if (client) {
        try {
            await disableCfsWebPushMutation(client, operation);
        } catch (error) {
            logger.warn("CFS Web Push cleanup was incomplete before replacing the account", error);
        }
    }
    if (isCurrentCfsWebPushMutation(operation)) {
        await clearLocalCfsWebPushAfterSessionEndMutation(operation);
    }
}

export function supersedeCfsWebPushMutationForSessionLock(): string {
    return supersedeCfsWebPushMutation();
}
