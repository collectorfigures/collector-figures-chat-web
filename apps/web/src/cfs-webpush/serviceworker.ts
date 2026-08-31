/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

interface CfsPushPayload {
    cfs_schema?: number;
    cfs_account_fingerprint?: string;
    room_id?: string;
    event_id?: string;
    unread?: number;
}

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

function safePayload(raw: unknown): CfsPushPayload {
    if (!raw || typeof raw !== "object") return {};
    const value = raw as Record<string, unknown>;
    return {
        cfs_schema: value.cfs_schema === 1 ? 1 : undefined,
        cfs_account_fingerprint:
            typeof value.cfs_account_fingerprint === "string" ? value.cfs_account_fingerprint.slice(0, 64) : undefined,
        room_id: typeof value.room_id === "string" ? value.room_id.slice(0, 512) : undefined,
        event_id: typeof value.event_id === "string" ? value.event_id.slice(0, 512) : undefined,
        unread: Number.isSafeInteger(value.unread) ? (value.unread as number) : undefined,
    };
}

function targetPath(payload: CfsPushPayload): string {
    if (!payload.room_id) return DEFAULT_TARGET;
    const room = encodeURIComponent(payload.room_id);
    const event = payload.event_id ? `/${encodeURIComponent(payload.event_id)}` : "";
    return `/#/room/${room}${event}`;
}

worker.addEventListener("install", (event) => event.waitUntil(worker.skipWaiting()));
worker.addEventListener("activate", (event) => event.waitUntil(worker.clients.claim()));

worker.addEventListener("push", (event) => {
    let payload: CfsPushPayload = {};
    try {
        payload = safePayload(event.data?.json());
    } catch {
        payload = {};
    }

    const data: CfsNotificationData = {
        cfsSchema: 1,
        accountFingerprint: payload.cfs_account_fingerprint,
        targetPath: targetPath(payload),
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
