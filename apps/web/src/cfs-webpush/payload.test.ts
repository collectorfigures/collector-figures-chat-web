/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import { describe, expect, it } from "vitest";

import { cfsPushTargetPath, isCfsPushForActiveOwner, safeCfsPushPayload } from "./payload";

describe("CFS Web Push payload", () => {
    it("retains only the approved opaque routing fields", () => {
        const payload = safeCfsPushPayload({
            cfs_schema: 1,
            cfs_account_fingerprint: "ABCDEFGHIJKLMNOPQRSTUV",
            room_id: "!room:chat.collectorfigures.com",
            event_id: "$event",
            unread: 3,
            body: "private message",
            content: { body: "private message" },
            sender: "@user:chat.collectorfigures.com",
            email: "private@example.invalid",
        });
        expect(payload).toEqual({
            cfs_schema: 1,
            cfs_account_fingerprint: "ABCDEFGHIJKLMNOPQRSTUV",
            room_id: "!room:chat.collectorfigures.com",
            event_id: "$event",
            unread: 3,
        });
        expect(JSON.stringify(payload)).not.toMatch(/body|content|sender|email|mxid|matrix_id/i);
    });

    it("accepts only schema 1 and an exact 22-character Base64URL owner", () => {
        for (const fingerprint of [undefined, "A".repeat(21), "A".repeat(23), `${"A".repeat(21)}+`]) {
            expect(
                safeCfsPushPayload({ cfs_schema: 1, cfs_account_fingerprint: fingerprint })
                    .cfs_account_fingerprint,
            ).toBeUndefined();
        }
        expect(safeCfsPushPayload({ cfs_schema: 2, cfs_account_fingerprint: "ABCDEFGHIJKLMNOPQRSTUV" })).toEqual({
            cfs_schema: undefined,
            cfs_account_fingerprint: "ABCDEFGHIJKLMNOPQRSTUV",
            room_id: undefined,
            event_id: undefined,
            unread: undefined,
        });
    });

    it("drops stale-account Push and Push with no active owner", () => {
        const payload = safeCfsPushPayload({
            cfs_schema: 1,
            cfs_account_fingerprint: "ABCDEFGHIJKLMNOPQRSTUV",
        });
        expect(isCfsPushForActiveOwner(payload, undefined)).toBe(false);
        expect(isCfsPushForActiveOwner(payload, "ZYXWVUTSRQPONMLKJIHGFE")).toBe(false);
        expect(isCfsPushForActiveOwner(payload, "ABCDEFGHIJKLMNOPQRSTUV")).toBe(true);
    });

    it("builds an encoded in-app route without external navigation", () => {
        expect(cfsPushTargetPath({ room_id: "!room:example", event_id: "$event/1" })).toBe(
            "/#/room/!room%3Aexample/%24event%2F1",
        );
        expect(cfsPushTargetPath({})).toBe("/");
    });
});
