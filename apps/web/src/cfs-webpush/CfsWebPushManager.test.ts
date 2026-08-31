/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import SdkConfig from "../SdkConfig";
import { disableCfsWebPush, enableCfsWebPush } from "./CfsWebPushManager";

describe("CFS Web Push", () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const subscription = {
        toJSON: () => ({
            endpoint: "https://fcm.googleapis.com/wp/test-endpoint",
            keys: {
                p256dh: "test-p256dh",
                auth: "test-auth",
            },
        }),
        unsubscribe,
    };
    const pushManager = {
        getSubscription: vi.fn().mockResolvedValue(subscription),
        subscribe: vi.fn().mockResolvedValue(subscription),
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

    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
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
        vi.spyOn(globalThis.crypto.subtle, "digest").mockResolvedValue(new Uint8Array(32).buffer);
    });

    afterEach(() => vi.restoreAllMocks());

    it("registers the exact privacy-minimised Matrix pusher", async () => {
        const setPusher = vi.fn().mockResolvedValue(undefined);
        const client = {
            getDeviceId: () => "DEVICE-1",
            setPusher,
        } as unknown as MatrixClient;

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
                endpoint: "https://fcm.googleapis.com/wp/test-endpoint",
                auth: "test-auth",
                events_only: true,
                only_last_per_room: true,
                format: "event_id_only",
                device_id: "DEVICE-1",
                default_payload: {
                    cfs_schema: 1,
                    cfs_account_fingerprint: "AAAAAAAAAAAAAAAAAAAAAA",
                },
            },
        });
        expect(JSON.stringify(pusher)).not.toMatch(/content|body|email|sender|matrix_id|mxid|access_token/i);
        expect(requestPermission).not.toHaveBeenCalled();
    });

    it("removes the exact Matrix pusher and browser subscription", async () => {
        const setPusher = vi.fn().mockResolvedValue(undefined);
        const removePusher = vi.fn().mockResolvedValue(undefined);
        const client = {
            getDeviceId: () => "DEVICE-1",
            setPusher,
            getPushers: vi.fn().mockResolvedValue({
                pushers: [
                    {
                        kind: "http",
                        app_id: "com.collectorfigures.chat.web",
                        pushkey: "test-p256dh",
                        data: { device_id: "DEVICE-1" },
                    },
                ],
            }),
            removePusher,
        } as unknown as MatrixClient;

        await enableCfsWebPush(client, true);
        await disableCfsWebPush(client);

        expect(removePusher).toHaveBeenCalledTimes(1);
        expect(removePusher).toHaveBeenCalledWith("test-p256dh", "com.collectorfigures.chat.web");
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem("cfs_webpush_registration_v1")).toBeNull();
    });

    it("does not prompt without an explicit user action", async () => {
        Object.defineProperty(window, "Notification", {
            configurable: true,
            value: { permission: "default", requestPermission },
        });
        const client = { getDeviceId: () => "DEVICE-1" } as unknown as MatrixClient;

        await expect(enableCfsWebPush(client, false)).rejects.toThrow("Notification permission is required");
        expect(requestPermission).not.toHaveBeenCalled();
        expect(serviceWorker.register).not.toHaveBeenCalled();
    });
});
