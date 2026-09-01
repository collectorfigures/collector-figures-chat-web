/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import type * as CfsWebPushManagerModule from "./CfsWebPushManager";
import { showCfsNotificationForActiveOwner } from "./notificationGate";

const config = {
    cfs_webpush_enabled: true,
    cfs_webpush_gateway_url: "https://chat-push.collectorfigures.com",
    cfs_webpush_application_server_key: "AQID",
    cfs_webpush_app_id: "com.collectorfigures.chat.web",
};

describe("CFS Web Push two-page mutation campaign", () => {
    let pushKey = "tab-a-p256dh";
    let activeSubscription: PushSubscription | null;
    const cacheEntries = new Map<string, Response>();
    const unsubscribe = vi.fn(async () => {
        activeSubscription = null;
        return true;
    });
    const subscription = {
        toJSON: () => ({
            endpoint: "https://fcm.googleapis.com/wp/cross-page-endpoint-opaque-123456",
            keys: { p256dh: pushKey, auth: "cross-page-auth" },
        }),
        unsubscribe,
    } as unknown as PushSubscription;
    const pushManager = {
        getSubscription: vi.fn(async () => activeSubscription),
        subscribe: vi.fn(async () => {
            activeSubscription = subscription;
            return subscription;
        }),
    };
    const registration = {
        pushManager,
        update: vi.fn().mockResolvedValue(undefined),
    };
    const serviceWorker = {
        register: vi.fn().mockResolvedValue(registration),
        getRegistration: vi.fn().mockResolvedValue(registration),
    };
    const cleanupCache = {
        match: vi.fn(async (key: string) => cacheEntries.get(key)?.clone()),
        put: vi.fn(async (key: string, value: Response) => cacheEntries.set(key, value.clone())),
        delete: vi.fn(async (key: string) => cacheEntries.delete(key)),
    };
    const cacheStorage = { open: vi.fn().mockResolvedValue(cleanupCache) };

    function makeClient({
        userId,
        deviceId,
        setPusher,
        removePusher,
    }: {
        userId: string;
        deviceId: string;
        setPusher: ReturnType<typeof vi.fn>;
        removePusher: ReturnType<typeof vi.fn>;
    }): MatrixClient {
        return {
            getUserId: () => userId,
            getDeviceId: () => deviceId,
            setPusher,
            removePusher,
        } as unknown as MatrixClient;
    }

    async function loadPageRealm(): Promise<typeof CfsWebPushManagerModule> {
        vi.resetModules();
        const sdkConfig = (await import("../SdkConfig")).default;
        sdkConfig.put(config);
        return import("./CfsWebPushManager");
    }

    async function activeOwner(): Promise<string | undefined> {
        const key = new URL("/cfs-push/active-owner.json", window.location.origin).href;
        const response = cacheEntries.get(key);
        if (!response) return undefined;
        const marker = (await response.clone().json()) as { ownerFingerprint?: string };
        return marker.ownerFingerprint;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        cacheEntries.clear();
        pushKey = "tab-a-p256dh";
        activeSubscription = null;
        unsubscribe.mockReset().mockImplementation(async () => {
            activeSubscription = null;
            return true;
        });
        pushManager.getSubscription.mockReset().mockImplementation(async () => activeSubscription);
        pushManager.subscribe.mockReset().mockImplementation(async () => {
            activeSubscription = subscription;
            return subscription;
        });
        Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
        Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
        Object.defineProperty(window, "Notification", {
            configurable: true,
            value: { permission: "granted", requestPermission: vi.fn().mockResolvedValue("granted") },
        });
        Object.defineProperty(window, "caches", { configurable: true, value: cacheStorage });
        vi.spyOn(global, "navigator", "get").mockReturnValue({
            ...navigator,
            serviceWorker,
            language: "en-US",
            locks: {
                request: vi.fn(async (_name: string, _options: LockOptions, callback: () => Promise<unknown>) =>
                    callback(),
                ),
            },
        } as unknown as Navigator);
    });

    afterEach(() => vi.restoreAllMocks());

    it("Tab B SessionLock theft and Disable supersede Tab A pending Ensure", async () => {
        let resolvePending!: () => void;
        const setPusherA = vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        resolvePending = resolve;
                    }),
            );
        const removePusherA = vi.fn().mockResolvedValue(undefined);
        const accountA = makeClient({
            userId: "@account-a:chat.collectorfigures.com",
            deviceId: "DEVICE-A",
            setPusher: setPusherA,
            removePusher: removePusherA,
        });
        const tabA = await loadPageRealm();
        await tabA.enableCfsWebPush(accountA, true);
        const oldOwner = await activeOwner();

        const pendingEnsure = tabA.ensureCfsWebPushForGrantedPermission(accountA);
        await vi.waitFor(() => expect(setPusherA).toHaveBeenCalledTimes(2));

        const tabB = await loadPageRealm();
        tabB.supersedeCfsWebPushMutationForSessionLock();
        await tabB.disableCfsWebPush(accountA);
        resolvePending();

        await expect(pendingEnsure).rejects.toThrow("superseded by another page");
        expect(localStorage.getItem("cfs_webpush_enrollment_v1")).toContain('"state":"disabled"');
        expect(localStorage.getItem("cfs_webpush_registration_v1")).toBeNull();
        await expect(activeOwner()).resolves.toBeUndefined();
        expect(removePusherA).toHaveBeenCalledWith("tab-a-p256dh", "com.collectorfigures.chat.web");
        const show = vi.fn().mockResolvedValue(undefined);
        await expect(
            showCfsNotificationForActiveOwner(
                { cfs_schema: 1, cfs_account_fingerprint: oldOwner },
                await activeOwner(),
                show,
            ),
        ).resolves.toBe(false);
        expect(show).not.toHaveBeenCalled();
    });

    it("Tab A pending account A operation cannot overwrite Tab B account replacement", async () => {
        let resolvePending!: () => void;
        const setPusherA = vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        resolvePending = resolve;
                    }),
            );
        const removePusherA = vi.fn().mockResolvedValue(undefined);
        const accountA = makeClient({
            userId: "@account-a:chat.collectorfigures.com",
            deviceId: "DEVICE-A",
            setPusher: setPusherA,
            removePusher: removePusherA,
        });
        const tabA = await loadPageRealm();
        await tabA.enableCfsWebPush(accountA, true);
        const oldOwner = await activeOwner();
        const pendingA = tabA.ensureCfsWebPushForGrantedPermission(accountA);
        await vi.waitFor(() => expect(setPusherA).toHaveBeenCalledTimes(2));

        const tabB = await loadPageRealm();
        await tabB.prepareCfsWebPushForAccountReplacement(accountA);
        pushKey = "tab-b-p256dh";
        const setPusherB = vi.fn().mockResolvedValue(undefined);
        const accountB = makeClient({
            userId: "@account-b:chat.collectorfigures.com",
            deviceId: "DEVICE-B",
            setPusher: setPusherB,
            removePusher: vi.fn().mockResolvedValue(undefined),
        });
        await tabB.enableCfsWebPush(accountB, true);
        const accountBOwner = await activeOwner();
        resolvePending();

        await expect(pendingA).rejects.toThrow("superseded by another page");
        expect(accountBOwner).toMatch(/^[A-Za-z0-9_-]{22}$/);
        await expect(activeOwner()).resolves.toBe(accountBOwner);
        const stored = JSON.parse(localStorage.getItem("cfs_webpush_registration_v1")!);
        const enrollment = JSON.parse(localStorage.getItem("cfs_webpush_enrollment_v1")!);
        expect(stored).toMatchObject({ pushKey: "tab-b-p256dh", ownerFingerprint: accountBOwner });
        expect(enrollment).toMatchObject({ state: "enabled", ownerFingerprint: accountBOwner });
        expect(stored.ownerFingerprint).not.toBe(oldOwner);
        expect(removePusherA).toHaveBeenCalledWith("tab-a-p256dh", "com.collectorfigures.chat.web");
    });
});
