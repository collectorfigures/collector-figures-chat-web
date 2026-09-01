/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import SdkConfig from "../SdkConfig";
import endpointFixturesJson from "./fixtures/cfs-webpush-endpoints.json";
import {
    clearLocalCfsWebPushAfterSessionEnd,
    disableCfsWebPush,
    enableCfsWebPush,
    ensureCfsWebPushForGrantedPermission,
    getCfsWebPushStatus,
    prepareCfsWebPushForAccountReplacement,
} from "./CfsWebPushManager";

interface EndpointFixture {
    provider?: string;
    reason?: string;
    endpoint: string;
}

const endpointFixtures = endpointFixturesJson as {
    schema: string;
    fixture_values: string;
    real_browser_acceptance: boolean;
    safari_status: string;
    provenance: Record<string, unknown>;
    valid: EndpointFixture[];
    invalid: EndpointFixture[];
};

describe("CFS Web Push", () => {
    let endpoint = "https://fcm.googleapis.com/wp/test-endpoint-opaque-123456";
    let pushKey = "test-p256dh";
    let activeSubscription: PushSubscription | null;
    const unsubscribe = vi.fn(async () => {
        activeSubscription = null;
        return true;
    });
    const subscription = {
        toJSON: () => ({
            endpoint,
            keys: { p256dh: pushKey, auth: "test-auth" },
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
    const requestPermission = vi.fn().mockResolvedValue("granted");
    const cacheEntries = new Map<string, Response>();
    const cleanupCache = {
        match: vi.fn(async (key: string) => cacheEntries.get(key)?.clone()),
        put: vi.fn(async (key: string, value: Response) => {
            cacheEntries.set(key, value.clone());
        }),
        delete: vi.fn(async (key: string) => cacheEntries.delete(key)),
    };
    const cacheStorage = { open: vi.fn().mockResolvedValue(cleanupCache) };

    function makeClient({
        userId = "@account-a:chat.collectorfigures.com",
        deviceId = "DEVICE-A",
        setPusher = vi.fn().mockResolvedValue(undefined),
        removePusher = vi.fn().mockResolvedValue(undefined),
    }: {
        userId?: string | null;
        deviceId?: string | null;
        setPusher?: ReturnType<typeof vi.fn>;
        removePusher?: ReturnType<typeof vi.fn>;
    } = {}): MatrixClient {
        return {
            getUserId: () => userId,
            getDeviceId: () => deviceId,
            setPusher,
            removePusher,
        } as unknown as MatrixClient;
    }

    async function readTombstones(): Promise<Array<Record<string, unknown>>> {
        const values: Array<Record<string, unknown>> = [];
        for (const [key, response] of cacheEntries) {
            if (key.includes("/cfs-push/cleanup-retry.json?owner=")) {
                values.push((await response.clone().json()) as Record<string, unknown>);
            }
        }
        return values;
    }

    async function readActiveOwnerMarker(): Promise<Record<string, unknown> | undefined> {
        const response = cacheEntries.get(new URL("/cfs-push/active-owner.json", window.location.origin).href);
        return response ? ((await response.clone().json()) as Record<string, unknown>) : undefined;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        endpoint = "https://fcm.googleapis.com/wp/test-endpoint-opaque-123456";
        pushKey = "test-p256dh";
        activeSubscription = subscription;
        unsubscribe.mockReset().mockImplementation(async () => {
            activeSubscription = null;
            return true;
        });
        pushManager.getSubscription.mockReset().mockImplementation(async () => activeSubscription);
        pushManager.subscribe.mockReset().mockImplementation(async () => {
            activeSubscription = subscription;
            return subscription;
        });
        localStorage.clear();
        cacheEntries.clear();
        SdkConfig.put({
            cfs_webpush_enabled: true,
            cfs_webpush_gateway_url: "https://chat-push.collectorfigures.com",
            cfs_webpush_application_server_key: "AQID",
            cfs_webpush_app_id: "com.collectorfigures.chat.web",
        });
        Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
        Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
        Object.defineProperty(window, "Notification", {
            configurable: true,
            value: { permission: "granted", requestPermission },
        });
        vi.spyOn(global, "navigator", "get").mockReturnValue({
            ...navigator,
            serviceWorker,
            language: "en-US",
        } as unknown as Navigator);
        Object.defineProperty(window, "caches", { configurable: true, value: cacheStorage });
    });

    afterEach(() => vi.restoreAllMocks());

    it("enables only after the exact privacy-minimised Matrix pusher is registered", async () => {
        const setPusher = vi.fn().mockResolvedValue(undefined);
        const client = makeClient({ setPusher });

        await enableCfsWebPush(client, true);

        expect(serviceWorker.register).toHaveBeenCalledWith("/cfs-push/sw.js", { scope: "/cfs-push/" });
        expect(setPusher).toHaveBeenCalledTimes(1);
        const pusher = setPusher.mock.calls[0][0];
        expect(pusher).toMatchObject({
            kind: "http",
            app_id: "com.collectorfigures.chat.web",
            pushkey: "test-p256dh",
            append: true,
            data: {
                url: "https://chat-push.collectorfigures.com/_matrix/push/v1/notify",
                endpoint: "https://fcm.googleapis.com/wp/test-endpoint-opaque-123456",
                auth: "test-auth",
                events_only: true,
                only_last_per_room: true,
                format: "event_id_only",
                device_id: "DEVICE-A",
                default_payload: {
                    cfs_schema: 1,
                    cfs_account_fingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
                },
            },
        });
        expect(JSON.stringify(pusher)).not.toMatch(/content|body|email|sender|matrix_id|mxid|access_token/i);
        expect(JSON.parse(localStorage.getItem("cfs_webpush_enrollment_v1")!)).toMatchObject({
            state: "enabled",
            deviceId: "DEVICE-A",
            ownerFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        });
        expect(requestPermission).not.toHaveBeenCalled();
        await expect(readActiveOwnerMarker()).resolves.toMatchObject({
            cfs_schema: 1,
            ownerFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        });
    });

    it("writes the active owner marker only after setPusher succeeds", async () => {
        let resolveSetPusher!: () => void;
        const setPusher = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveSetPusher = resolve;
                }),
        );
        const pending = enableCfsWebPush(makeClient({ setPusher }), true);
        await vi.waitFor(() => expect(setPusher).toHaveBeenCalledTimes(1));

        await expect(readActiveOwnerMarker()).resolves.toBeUndefined();
        expect(localStorage.getItem("cfs_webpush_enrollment_v1")).toBeNull();

        resolveSetPusher();
        await pending;
        await expect(readActiveOwnerMarker()).resolves.toMatchObject({ cfs_schema: 1 });
        expect(localStorage.getItem("cfs_webpush_enrollment_v1")).toContain('"state":"enabled"');
    });

    it("clears the active owner marker before Disable network cleanup", async () => {
        const client = makeClient();
        await enableCfsWebPush(client, true);
        unsubscribe.mockClear();
        let resolveUnsubscribe!: () => void;
        unsubscribe.mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    resolveUnsubscribe = () => {
                        activeSubscription = null;
                        resolve(true);
                    };
                }),
        );

        const pending = disableCfsWebPush(client);
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalled());
        await expect(readActiveOwnerMarker()).resolves.toBeUndefined();
        expect(localStorage.getItem("cfs_webpush_enrollment_v1")).toContain('"state":"disabled"');

        resolveUnsubscribe();
        await pending;
    });

    it("does not mark enrollment enabled when setPusher fails", async () => {
        pushManager.getSubscription.mockResolvedValueOnce(null);
        const client = makeClient({ setPusher: vi.fn().mockRejectedValue(new Error("setPusher failed")) });

        await expect(enableCfsWebPush(client, true)).rejects.toThrow("queued for cleanup");

        expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem("cfs_webpush_registration_v1")).toBeNull();
        expect(localStorage.getItem("cfs_webpush_enrollment_v1")).toBeNull();
        await expect(readActiveOwnerMarker()).resolves.toBeUndefined();
        expect((await readTombstones()).length).toBe(1);
    });

    it("sets enrollment disabled before cleanup and never restores it after failure", async () => {
        const removePusher = vi.fn().mockRejectedValue(new Error("removePusher failed"));
        const client = makeClient({ removePusher });
        await enableCfsWebPush(client, true);
        unsubscribe.mockRejectedValueOnce(new Error("unsubscribe failed"));

        await expect(disableCfsWebPush(client)).rejects.toThrow("cleanup was incomplete");

        expect(JSON.parse(localStorage.getItem("cfs_webpush_enrollment_v1")!)).toMatchObject({ state: "disabled" });
        expect(localStorage.getItem("cfs_webpush_registration_v1")).toBeNull();
        expect(await readTombstones()).toEqual([
            expect.objectContaining({
                deviceId: "DEVICE-A",
                ownerFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
                targets: [{ appId: "com.collectorfigures.chat.web", pushKey: "test-p256dh" }],
                browserUnsubscribePending: true,
            }),
        ]);
    });

    it("enable then disable then ClientStarted ensure never registers again", async () => {
        const setPusher = vi.fn().mockResolvedValue(undefined);
        const client = makeClient({ setPusher });
        await enableCfsWebPush(client, true);
        unsubscribe.mockClear();
        await disableCfsWebPush(client);

        await ensureCfsWebPushForGrantedPermission(client);

        expect(setPusher).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem("cfs_webpush_enrollment_v1")).toContain('"state":"disabled"');
    });

    it("granted browser permission alone never enables Web Push", async () => {
        const setPusher = vi.fn().mockResolvedValue(undefined);
        const client = makeClient({ setPusher });

        await ensureCfsWebPushForGrantedPermission(client);

        expect(setPusher).not.toHaveBeenCalled();
        expect(serviceWorker.register).not.toHaveBeenCalled();
    });

    it("account A logout then account B ClientStarted does not inherit enrollment", async () => {
        const accountA = makeClient();
        await enableCfsWebPush(accountA, true);
        await clearLocalCfsWebPushAfterSessionEnd();
        const setPusherB = vi.fn().mockResolvedValue(undefined);
        const accountB = makeClient({
            userId: "@account-b:chat.collectorfigures.com",
            deviceId: "DEVICE-B",
            setPusher: setPusherB,
        });

        await ensureCfsWebPushForGrantedPermission(accountB);

        expect(setPusherB).not.toHaveBeenCalled();
        expect(localStorage.getItem("cfs_webpush_enrollment_v1")).toBeNull();
        expect(localStorage.getItem("cfs_webpush_registration_v1")).toBeNull();
    });

    it("OverwriteLogin A to B clears owner state without blocking mandatory account replacement", async () => {
        const accountA = makeClient({ removePusher: vi.fn().mockRejectedValue(new Error("remove failed")) });
        await enableCfsWebPush(accountA, true);
        unsubscribe.mockRejectedValue(new Error("unsubscribe failed"));

        await expect(prepareCfsWebPushForAccountReplacement(accountA)).resolves.toBeUndefined();

        expect(localStorage.getItem("cfs_webpush_enrollment_v1")).toBeNull();
        expect(localStorage.getItem("cfs_webpush_registration_v1")).toBeNull();
        await expect(readActiveOwnerMarker()).resolves.toBeUndefined();
        const setPusherB = vi.fn().mockResolvedValue(undefined);
        await ensureCfsWebPushForGrantedPermission(
            makeClient({
                userId: "@account-b:chat.collectorfigures.com",
                deviceId: "DEVICE-B",
                setPusher: setPusherB,
            }),
        );
        expect(setPusherB).not.toHaveBeenCalled();
    });

    it("logout always clears enrollment even when browser unsubscribe fails", async () => {
        await enableCfsWebPush(makeClient(), true);
        unsubscribe.mockRejectedValueOnce(new Error("unsubscribe failed"));

        await expect(clearLocalCfsWebPushAfterSessionEnd()).resolves.toBeUndefined();

        expect(localStorage.getItem("cfs_webpush_enrollment_v1")).toBeNull();
        expect(localStorage.getItem("cfs_webpush_registration_v1")).toBeNull();
        await expect(readActiveOwnerMarker()).resolves.toBeUndefined();
        expect(await readTombstones()).toEqual([
            expect.objectContaining({
                browserUnsubscribePending: true,
                ownerFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
            }),
        ]);
    });

    it("uses the exact stored device when the client device ID is temporarily missing", async () => {
        const removePusher = vi.fn().mockResolvedValue(undefined);
        await enableCfsWebPush(makeClient(), true);
        const clientWithoutDevice = makeClient({ deviceId: null, removePusher });

        await disableCfsWebPush(clientWithoutDevice);

        expect(removePusher).toHaveBeenCalledExactlyOnceWith("test-p256dh", "com.collectorfigures.chat.web");
    });

    it("missing metadata still removes the browser subscription without enumerating or deleting pushers", async () => {
        const removePusher = vi.fn().mockResolvedValue(undefined);
        const getPushers = vi.fn().mockResolvedValue({
            pushers: [{ app_id: "com.collectorfigures.chat.web", pushkey: "unrelated" }],
        });
        const client = {
            ...makeClient({ deviceId: null, removePusher }),
            getPushers,
        } as unknown as MatrixClient;

        await expect(disableCfsWebPush(client)).rejects.toThrow("cleanup was incomplete");

        expect(getPushers).not.toHaveBeenCalled();
        expect(removePusher).not.toHaveBeenCalled();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(activeSubscription).toBeNull();
    });

    it("blocks account B enable when account A removal and browser unsubscribe both fail", async () => {
        const accountA = makeClient({ removePusher: vi.fn().mockRejectedValue(new Error("remove failed")) });
        await enableCfsWebPush(accountA, true);
        unsubscribe.mockRejectedValue(new Error("unsubscribe failed"));
        await expect(disableCfsWebPush(accountA)).rejects.toThrow("cleanup was incomplete");

        const setPusherB = vi.fn().mockResolvedValue(undefined);
        const accountB = makeClient({
            userId: "@account-b:chat.collectorfigures.com",
            deviceId: "DEVICE-B",
            setPusher: setPusherB,
        });
        await expect(enableCfsWebPush(accountB, true)).rejects.toThrow("unsubscribe failed");

        expect(setPusherB).not.toHaveBeenCalled();
        expect(activeSubscription).toBe(subscription);
        await expect(readActiveOwnerMarker()).resolves.toBeUndefined();
    });

    it("blocks setPusher when an unowned browser subscription survives unsubscribe read-back", async () => {
        unsubscribe.mockResolvedValueOnce(true);
        const setPusher = vi.fn().mockResolvedValue(undefined);

        await expect(enableCfsWebPush(makeClient({ setPusher }), true)).rejects.toThrow(
            "still exists after unsubscribe",
        );

        expect(setPusher).not.toHaveBeenCalled();
        expect(activeSubscription).toBe(subscription);
        await expect(readActiveOwnerMarker()).resolves.toBeUndefined();
    });

    it("concurrent Ensure cannot re-enable after Disable wins the generation guard", async () => {
        const setPusher = vi.fn().mockResolvedValue(undefined);
        const removePusher = vi.fn().mockResolvedValue(undefined);
        const client = makeClient({ setPusher, removePusher });
        await enableCfsWebPush(client, true);
        let resolveEnsure!: () => void;
        setPusher.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveEnsure = resolve;
                }),
        );

        const pendingEnsure = ensureCfsWebPushForGrantedPermission(client);
        await vi.waitFor(() => expect(setPusher).toHaveBeenCalledTimes(2));
        await disableCfsWebPush(client);
        resolveEnsure();

        await expect(pendingEnsure).rejects.toThrow("superseded or could not persist owner state");
        expect(localStorage.getItem("cfs_webpush_enrollment_v1")).toContain('"state":"disabled"');
        expect(localStorage.getItem("cfs_webpush_registration_v1")).toBeNull();
        await expect(readActiveOwnerMarker()).resolves.toBeUndefined();
    });

    it("account B cannot process or complete account A cleanup tombstone", async () => {
        const removePusherA = vi.fn().mockRejectedValue(new Error("offline"));
        const accountA = makeClient({ removePusher: removePusherA });
        await enableCfsWebPush(accountA, true);
        await expect(disableCfsWebPush(accountA)).rejects.toThrow("cleanup was incomplete");
        const [accountATombstone] = await readTombstones();

        const removePusherB = vi.fn().mockResolvedValue(undefined);
        const setPusherB = vi.fn().mockResolvedValue(undefined);
        const accountB = makeClient({
            userId: "@account-b:chat.collectorfigures.com",
            deviceId: "DEVICE-B",
            removePusher: removePusherB,
            setPusher: setPusherB,
        });
        await enableCfsWebPush(accountB, true);

        expect(removePusherB).not.toHaveBeenCalled();
        expect(setPusherB).toHaveBeenCalledTimes(1);
        expect(await readTombstones()).toContainEqual(accountATombstone);
        const tombstoneText = JSON.stringify(accountATombstone);
        expect(tombstoneText).not.toContain("@account-a");
        expect(tombstoneText).not.toContain(endpoint);
        expect(tombstoneText).not.toContain("test-auth");
        expect(tombstoneText).not.toMatch(/email|mxid|access[_-]?token/i);
    });

    it("removes only the exact owner-bound Matrix pusher and browser subscription", async () => {
        const removePusher = vi.fn().mockResolvedValue(undefined);
        const client = makeClient({ removePusher });

        await enableCfsWebPush(client, true);
        await disableCfsWebPush(client);

        expect(removePusher).toHaveBeenCalledExactlyOnceWith("test-p256dh", "com.collectorfigures.chat.web");
        expect(unsubscribe).toHaveBeenCalled();
        expect(activeSubscription).toBeNull();
        expect(localStorage.getItem("cfs_webpush_registration_v1")).toBeNull();
    });

    it("removes an exact stale owner-bound pusher before refreshing the subscription", async () => {
        const removePusher = vi.fn().mockResolvedValue(undefined);
        const client = makeClient({ removePusher });
        await enableCfsWebPush(client, true);
        const stored = JSON.parse(localStorage.getItem("cfs_webpush_registration_v1")!);
        localStorage.setItem("cfs_webpush_registration_v1", JSON.stringify({ ...stored, pushKey: "stale-p256dh" }));

        await enableCfsWebPush(client, true);

        expect(removePusher).toHaveBeenCalledExactlyOnceWith("stale-p256dh", "com.collectorfigures.chat.web");
    });

    it("does not prompt without an explicit user action", async () => {
        Object.defineProperty(window, "Notification", {
            configurable: true,
            value: { permission: "default", requestPermission },
        });

        await expect(enableCfsWebPush(makeClient(), false)).rejects.toThrow("Notification permission is required");
        expect(requestPermission).not.toHaveBeenCalled();
        expect(serviceWorker.register).not.toHaveBeenCalled();
    });

    it.each(endpointFixtures.valid)("accepts the $provider browser endpoint fixture", async ({ endpoint: value }) => {
        endpoint = value;
        const setPusher = vi.fn().mockResolvedValue(undefined);

        await enableCfsWebPush(makeClient({ setPusher }), true);

        expect(setPusher).toHaveBeenCalledTimes(1);
        expect(setPusher.mock.calls[0][0].data.endpoint).toBe(value);
    });

    it.each(endpointFixtures.invalid)("rejects endpoint fixture: $reason", async ({ endpoint: value }) => {
        endpoint = value;

        await expect(enableCfsWebPush(makeClient(), true)).rejects.toThrow("disallowed Web Push endpoint");

        expect(unsubscribe).toHaveBeenCalledTimes(2);
        expect(activeSubscription).toBeNull();
    });

    it("uses the shared provider-aware endpoint fixture contract", () => {
        expect(endpointFixtures).toMatchObject({
            schema: "cfs-webpush-endpoint-fixtures/v2",
            fixture_values: "synthetic_redactions",
            real_browser_acceptance: false,
            safari_status: "fail_closed_pending_real_acceptance",
        });
        expect(endpointFixtures.valid).toHaveLength(3);
        expect(endpointFixtures.invalid).toHaveLength(12);
        expect(endpointFixtures.provenance).toHaveProperty("chrome");
        expect(endpointFixtures.provenance).toHaveProperty("edge");
        expect(endpointFixtures.provenance).toHaveProperty("firefox");
    });

    it("rejects an overlong provider endpoint", async () => {
        endpoint = `https://db3.notify.windows.com/${"x".repeat(2048)}`;
        await expect(enableCfsWebPush(makeClient(), true)).rejects.toThrow("disallowed Web Push endpoint");
    });

    it.each([
        "http://chat-push.collectorfigures.com",
        "https://user@chat-push.collectorfigures.com",
        "https://chat-push.collectorfigures.com:444",
        "https://chat-push.collectorfigures.com/unexpected",
        "https://other.collectorfigures.com",
    ])("rejects a non-canonical gateway URL: %s", async (gatewayUrl) => {
        SdkConfig.put({
            cfs_webpush_enabled: true,
            cfs_webpush_gateway_url: gatewayUrl,
            cfs_webpush_application_server_key: "AQID",
            cfs_webpush_app_id: "com.collectorfigures.chat.web",
        });

        await expect(enableCfsWebPush(makeClient(), true)).rejects.toThrow("must be exactly");
        expect(serviceWorker.register).not.toHaveBeenCalled();
    });

    it("reports enabled only for the exact enrolled account and device", async () => {
        await enableCfsWebPush(makeClient(), true);

        await expect(getCfsWebPushStatus(makeClient())).resolves.toMatchObject({ enabled: true });
        await expect(
            getCfsWebPushStatus(
                makeClient({ userId: "@account-b:chat.collectorfigures.com", deviceId: "DEVICE-B" }),
            ),
        ).resolves.toMatchObject({ enabled: false });
    });
});
