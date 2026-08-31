/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import { cfsPushTargetPath, safeCfsPushPayload, type CfsPushPayload } from "./payload";

interface CfsNotificationData {
    cfsSchema: 1;
    accountFingerprint?: string;
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
const DEFAULT_TITLE = "Collector Figures";
const DEFAULT_BODY = "You have a new message";

worker.addEventListener("install", (event) => event.waitUntil(worker.skipWaiting()));
worker.addEventListener("activate", (event) => event.waitUntil(worker.clients.claim()));

worker.addEventListener("push", (event) => {
    let payload: CfsPushPayload = {};
    try {
        payload = safeCfsPushPayload(event.data?.json());
    } catch {
        payload = {};
    }

    const data: CfsNotificationData = {
        cfsSchema: 1,
        accountFingerprint: payload.cfs_account_fingerprint,
        targetPath: cfsPushTargetPath(payload),
    };
    event.waitUntil(
        worker.registration.showNotification(DEFAULT_TITLE, {
            body: DEFAULT_BODY,
            icon: "/cfs-icons/icon-1080.jpg",
            badge: "/cfs-icons/icon-1080.jpg",
            tag: "cfs-new-message",
            data,
        }),
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
            const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
            for (const client of windows) client.postMessage({ type: "cfs-webpush-subscription-changed" });
        })(),
    );
});
