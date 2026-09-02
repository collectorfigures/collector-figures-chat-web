/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import { describe, expect, it, vi } from "vitest";

import { cfsNotificationClickTarget, showCfsNotificationForActiveOwner } from "./notificationGate";

describe("CFS Push Service Worker owner gate", () => {
    const activeOwner = "ABCDEFGHIJKLMNOPQRSTUV";

    it.each([
        ["no active owner", { cfs_schema: 1, cfs_account_fingerprint: activeOwner }, undefined],
        ["stale account", { cfs_schema: 1, cfs_account_fingerprint: "ZYXWVUTSRQPONMLKJIHGFE" }, activeOwner],
        ["missing schema", { cfs_account_fingerprint: activeOwner }, activeOwner],
        ["wrong schema", { cfs_schema: 2, cfs_account_fingerprint: activeOwner }, activeOwner],
        ["missing fingerprint", { cfs_schema: 1 }, activeOwner],
        ["short fingerprint", { cfs_schema: 1, cfs_account_fingerprint: "short" }, activeOwner],
        ["non-Base64URL fingerprint", { cfs_schema: 1, cfs_account_fingerprint: `${"A".repeat(21)}+` }, activeOwner],
    ])("drops %s Push without showNotification", async (_name, payload, owner) => {
        const showNotification = vi.fn().mockResolvedValue(undefined);

        await expect(showCfsNotificationForActiveOwner(payload, owner, showNotification)).resolves.toBe(false);

        expect(showNotification).not.toHaveBeenCalled();
    });

    it("shows only a schema-1 Push for the exact active owner", async () => {
        const showNotification = vi.fn().mockResolvedValue(undefined);

        await expect(
            showCfsNotificationForActiveOwner(
                {
                    cfs_schema: 1,
                    cfs_account_fingerprint: activeOwner,
                    room_id: "!room:chat.collectorfigures.com",
                    event_id: "$event",
                },
                activeOwner,
                showNotification,
            ),
        ).resolves.toBe(true);

        expect(showNotification).toHaveBeenCalledExactlyOnceWith(
            "Collector Figures",
            expect.objectContaining({
                body: "You have a new message",
                tag: `cfs-new-message-${activeOwner}`,
                data: expect.objectContaining({ accountFingerprint: activeOwner, cfsSchema: 1 }),
            }),
        );
    });

    it("drops a notification click after logout removes the active owner", () => {
        expect(
            cfsNotificationClickTarget(
                { cfsSchema: 1, accountFingerprint: activeOwner, targetPath: "/#/room/%21room" },
                undefined,
                "https://chat.collectorfigures.com",
            ),
        ).toBeUndefined();
    });

    it("drops a stale notification click after an account switch", () => {
        expect(
            cfsNotificationClickTarget(
                { cfsSchema: 1, accountFingerprint: "ZYXWVUTSRQPONMLKJIHGFE", targetPath: "/#/room/%21room" },
                activeOwner,
                "https://chat.collectorfigures.com",
            ),
        ).toBeUndefined();
    });

    it.each([
        { cfsSchema: 2, accountFingerprint: activeOwner, targetPath: "/#/room/%21room" },
        { cfsSchema: 1, accountFingerprint: "short", targetPath: "/#/room/%21room" },
        { cfsSchema: 1, accountFingerprint: activeOwner, targetPath: "https://evil.example/" },
        { cfsSchema: 1, accountFingerprint: activeOwner, targetPath: "/account" },
        { cfsSchema: 1, accountFingerprint: activeOwner, targetPath: "/#/settings" },
        { cfsSchema: 1, accountFingerprint: activeOwner, targetPath: "/#/room/%21room?unexpected" },
    ])("drops malformed or external notification click data: $targetPath", (data) => {
        expect(cfsNotificationClickTarget(data, activeOwner, "https://chat.collectorfigures.com")).toBeUndefined();
    });

    it("returns only an exact same-origin CFS room target for the active owner", () => {
        expect(
            cfsNotificationClickTarget(
                {
                    cfsSchema: 1,
                    accountFingerprint: activeOwner,
                    targetPath: "/#/room/%21room%3Achat.collectorfigures.com/%24event",
                },
                activeOwner,
                "https://chat.collectorfigures.com",
            ),
        ).toBe("https://chat.collectorfigures.com/#/room/%21room%3Achat.collectorfigures.com/%24event");
    });
});
