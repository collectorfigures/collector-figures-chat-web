/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import { CFS_OWNER_FINGERPRINT_PATTERN } from "./payload";
import { showCfsNotificationForActiveOwner } from "./notificationGate";

interface CfsNotificationData {
    cfsSchema: 1;
    accountFingerprint: string;
    targetPath: string;
}

interface CfsWorkerClient {
    url: string;
    postMessage(message: unknown): void;
}

interface CfsWindowClient extends CfsWorkerClient {
    navigate(url: string): Promise<CfsWindowClient | null>;
    focus(): Promise<CfsWindowClient>;
}

interface CfsExtendableEvent {
    waitUntil(promise: Promise<unknown>): void;
}

interface CfsPushEvent extends CfsExtendableEvent {
    data?: { json(): unknown };
}

interface CfsNotificationEvent extends CfsExtendableEvent {
    notification: { data?: unknown; close(): void };
}

interface CfsWorkerScope {
    location: Location;
    registration: {
        showNotification(title: string, options?: NotificationOptions): Promise<void>;
    };
    clients: {
        claim(): Promise<void>;
        matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<CfsWorkerClient[]>;
        openWindow(url: string): Promise<CfsWindowClient | null>;
    };
    skipWaiting(): Promise<void>;
    addEventListener(
        type: "install" | "activate" | "pushsubscriptionchange",
        listener: (event: CfsExtendableEvent) => void,
    ): void;
    addEventListener(type: "push", listener: (event: CfsPushEvent) => void): void;
    addEventListener(type: "notificationclick", listener: (event: CfsNotificationEvent) => void): void;
}

const worker = globalThis as unknown as CfsWorkerScope;
const DEFAULT_TARGET = "/";
const STATE_CACHE = "cfs-webpush-cleanup-v1";
const SUBSCRIPTION_CHANGE_PATH = "/cfs-push/subscription-change";
const ACTIVE_OWNER_PATH = "/cfs-push/active-owner.json";

async function readActiveOwner(): Promise<string | undefined> {
    try {
        const cache = await caches.open(STATE_CACHE);
        const response = await cache.match(new URL(ACTIVE_OWNER_PATH, worker.location.origin).href);
        if (!response) return undefined;
        const marker = (await response.json()) as Record<string, unknown>;
        return marker.cfs_schema === 1 &&
            typeof marker.ownerFingerprint === "string" &&
            CFS_OWNER_FINGERPRINT_PATTERN.test(marker.ownerFingerprint)
            ? marker.ownerFingerprint
            : undefined;
    } catch {
        return undefined;
    }
}

worker.addEventListener("install", (event) => event.waitUntil(worker.skipWaiting()));
worker.addEventListener("activate", (event) => event.waitUntil(worker.clients.claim()));

worker.addEventListener("push", (event) => {
    event.waitUntil(
        (async () => {
            let payload: unknown;
            try {
                payload = event.data?.json();
            } catch {
                return;
            }
            const activeOwner = await readActiveOwner();
            await showCfsNotificationForActiveOwner(payload, activeOwner, (title, options) =>
                worker.registration.showNotification(title, options),
            );
        })(),
    );
});

worker.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data as Partial<CfsNotificationData> | undefined;
    const path = data?.cfsSchema === 1 && typeof data.targetPath === "string" ? data.targetPath : DEFAULT_TARGET;
    const target = new URL(path, worker.location.origin).href;

    event.waitUntil(
        (async () => {
            const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
            const existing = windows.find((client) => new URL(client.url).origin === worker.location.origin) as
                | CfsWindowClient
                | undefined;
            if (existing) {
                await existing.navigate(target);
                await existing.focus();
                return;
            }
            await worker.clients.openWindow(target);
        })(),
    );
});

worker.addEventListener("pushsubscriptionchange", (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(STATE_CACHE);
            await cache.put(
                new URL(SUBSCRIPTION_CHANGE_PATH, worker.location.origin).href,
                new Response("1", { headers: { "Cache-Control": "no-store" } }),
            );
            const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
            for (const client of windows) client.postMessage({ type: "cfs-webpush-subscription-changed" });
        })(),
    );
});
