/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import type * as CfsWebPushManagerModule from "./CfsWebPushManager";
import { type CfsWebPushCommitPhase } from "./CfsWebPushManager";
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
    let pauseNextActiveOwnerWrite = false;
    let releaseActiveOwnerWrite: (() => void) | undefined;
    let stateLockTail: Promise<void> = Promise.resolve();
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
        put: vi.fn(async (key: string, value: Response) => {
            cacheEntries.set(key, value.clone());
            if (pauseNextActiveOwnerWrite && key.includes("/cfs-push/active-owner.json")) {
                pauseNextActiveOwnerWrite = false;
                await new Promise<void>((resolve) => {
                    releaseActiveOwnerWrite = resolve;
                });
            }
        }),
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
        pauseNextActiveOwnerWrite = false;
        releaseActiveOwnerWrite = undefined;
        stateLockTail = Promise.resolve();
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
                request: vi.fn(async (_name: string, _options: LockOptions, callback: () => Promise<unknown>) => {
                    const previous = stateLockTail;
                    let release!: () => void;
                    stateLockTail = new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    await previous;
                    try {
                        return await callback();
                    } finally {
                        release();
                    }
                }),
            },
        } as unknown as Navigator);
    });

    afterEach(() => vi.restoreAllMocks());

    it("records the exact cross-Realm evidence boundary", () => {
        const evidence = {
            cross_realm_shared_storage_simulation: true,
            real_two_page_browser_acceptance: false,
        };
        expect(evidence).toEqual({
            cross_realm_shared_storage_simulation: true,
            real_two_page_browser_acceptance: false,
        });
        console.info(
            "CFS_CROSS_REALM_EVIDENCE cross_realm_shared_storage_simulation=true real_two_page_browser_acceptance=false",
        );
    });

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

        await expect(pendingEnsure).rejects.toThrow("superseded");
        expect(localStorage.getItem("cfs_webpush_enrollment_v1")).toBeNull();
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

        await expect(pendingA).rejects.toThrow("superseded");
        expect(accountBOwner).toMatch(/^[A-Za-z0-9_-]{22}$/);
        await expect(activeOwner()).resolves.toBe(accountBOwner);
        const stored = JSON.parse(localStorage.getItem("cfs_webpush_registration_v1")!);
        const enrollment = JSON.parse(localStorage.getItem("cfs_webpush_enrollment_v1")!);
        expect(stored).toMatchObject({ pushKey: "tab-b-p256dh", ownerFingerprint: accountBOwner });
        expect(enrollment).toMatchObject({ state: "enabled", ownerFingerprint: accountBOwner });
        expect(stored.ownerFingerprint).not.toBe(oldOwner);
        expect(removePusherA).toHaveBeenCalledWith("tab-a-p256dh", "com.collectorfigures.chat.web");
    });

    const commitPhases: CfsWebPushCommitPhase[] = [
        "after-lock-assert-before-registration",
        "after-registration-write-before-assert",
        "after-enrollment-write-before-assert",
        "active-owner-cache-write-pending",
    ];
    const interleavings = commitPhases.flatMap((phase) => [
        { phase, destination: "disable" as const },
        { phase, destination: "account-b" as const },
    ]);

    it.each(interleavings)(
        "cleans only Tab A state when $phase is superseded by $destination",
        async ({ phase, destination }) => {
            const setPusherA = vi.fn().mockResolvedValue(undefined);
            const removePusherA = vi.fn().mockResolvedValue(undefined);
            const accountA = makeClient({
                userId: "@account-a:chat.collectorfigures.com",
                deviceId: "DEVICE-A",
                setPusher: setPusherA,
                removePusher: removePusherA,
            });
            const tabA = await loadPageRealm();
            await tabA.enableCfsWebPush(accountA, true);
            const originalRegistration = JSON.parse(localStorage.getItem("cfs_webpush_registration_v1")!);
            const accountAOwner = originalRegistration.ownerFingerprint as string;

            const tabB = await loadPageRealm();
            const removePusherB = vi.fn().mockResolvedValue(undefined);
            const accountB = makeClient({
                userId: "@account-b:chat.collectorfigures.com",
                deviceId: "DEVICE-B",
                setPusher: vi.fn().mockResolvedValue(undefined),
                removePusher: removePusherB,
            });
            let competingOperation: Promise<void> | undefined;
            let hookRuns = 0;
            tabA.setCfsWebPushCommitTestHook(async (observedPhase) => {
                if (observedPhase !== phase || hookRuns > 0) return;
                hookRuns += 1;
                if (destination === "disable") {
                    competingOperation = tabB.disableCfsWebPush(accountA);
                } else {
                    competingOperation = (async () => {
                        await tabB.prepareCfsWebPushForAccountReplacement(accountA);
                        pushKey = "tab-b-p256dh";
                        await tabB.enableCfsWebPush(accountB, true);
                    })();
                }
                if (phase === "active-owner-cache-write-pending") releaseActiveOwnerWrite?.();
            });
            if (phase === "active-owner-cache-write-pending") pauseNextActiveOwnerWrite = true;

            const pendingA = tabA.ensureCfsWebPushForGrantedPermission(accountA);
            await expect(pendingA).rejects.toThrow("superseded");
            if (destination === "disable") {
                await competingOperation?.catch(() => undefined);
            } else {
                await expect(competingOperation).resolves.toBeUndefined();
            }
            expect(hookRuns).toBe(1);

            const finalRegistrationText = localStorage.getItem("cfs_webpush_registration_v1");
            const finalEnrollmentText = localStorage.getItem("cfs_webpush_enrollment_v1");
            const finalMarkerOwner = await activeOwner();
            expect(finalRegistrationText ?? "").not.toContain(accountAOwner);
            expect(finalEnrollmentText ?? "").not.toContain(accountAOwner);
            expect(finalMarkerOwner).not.toBe(accountAOwner);
            expect(removePusherA).toHaveBeenCalledWith("tab-a-p256dh", "com.collectorfigures.chat.web");
            expect(removePusherA).not.toHaveBeenCalledWith("tab-b-p256dh", "com.collectorfigures.chat.web");
            expect(removePusherB).not.toHaveBeenCalledWith("tab-b-p256dh", "com.collectorfigures.chat.web");

            if (destination === "disable") {
                expect(finalRegistrationText).toBeNull();
                expect(finalEnrollmentText).toBeNull();
                expect(finalMarkerOwner).toBeUndefined();
            } else {
                const finalRegistration = JSON.parse(finalRegistrationText!);
                const finalEnrollment = JSON.parse(finalEnrollmentText!);
                const markerResponse = cacheEntries.get(
                    new URL("/cfs-push/active-owner.json", window.location.origin).href,
                );
                const finalMarker = (await markerResponse!.clone().json()) as {
                    ownerFingerprint: string;
                    operationId: string;
                };
                expect(finalRegistration).toMatchObject({
                    pushKey: "tab-b-p256dh",
                    ownerFingerprint: finalMarker.ownerFingerprint,
                    operationId: finalMarker.operationId,
                });
                expect(finalEnrollment).toMatchObject({
                    state: "enabled",
                    ownerFingerprint: finalMarker.ownerFingerprint,
                    operationId: finalMarker.operationId,
                });
                expect(finalMarker.ownerFingerprint).not.toBe(accountAOwner);
            }
        },
    );
});
