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
const DEFAULT_APP_ID = "com.collectorfigures.chat.web";

interface StoredRegistration {
    appId: string;
    pushKey: string;
    endpoint: string;
    deviceId: string;
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
    if (parsedGateway.protocol !== "https:") {
        throw new Error("CFS Web Push gateway must use HTTPS");
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
    await client.setPusher(pusher);

    writeStoredRegistration({ appId: config.appId, pushKey, endpoint, deviceId });
}

export async function ensureCfsWebPushForGrantedPermission(client: MatrixClient): Promise<void> {
    if (!supportsWebPush() || Notification.permission !== "granted") return;
    if (!getConfig()) return;
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
        if (!stored) throw error;
        logger.warn("Unable to enumerate CFS Web Push pushers; removing the locally tracked pusher", error);
    }

    const failures: unknown[] = [];
    for (const pushKey of targets.values()) {
        try {
            await client.removePusher(pushKey, appId);
        } catch (error) {
            failures.push(error);
        }
    }

    try {
        await unsubscribeBrowser();
    } catch (error) {
        failures.push(error);
    }
    clearStoredRegistration();

    if (failures.length > 0) {
        throw new AggregateError(failures, "CFS Web Push cleanup was incomplete");
    }
}

export async function clearLocalCfsWebPushAfterSessionEnd(): Promise<void> {
    try {
        await unsubscribeBrowser();
    } finally {
        clearStoredRegistration();
    }
}
