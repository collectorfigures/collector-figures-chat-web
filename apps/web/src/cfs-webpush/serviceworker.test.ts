/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import { describe, expect, it, vi } from "vitest";

import { showCfsNotificationForActiveOwner } from "./notificationGate";

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
});
