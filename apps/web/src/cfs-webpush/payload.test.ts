/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import { describe, expect, it } from "vitest";

import { cfsPushTargetPath, safeCfsPushPayload } from "./payload";

describe("CFS Web Push payload", () => {
    it("retains only the approved opaque routing fields", () => {
        const payload = safeCfsPushPayload({
            cfs_schema: 1,
            cfs_account_fingerprint: "opaque",
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
            cfs_account_fingerprint: "opaque",
            room_id: "!room:chat.collectorfigures.com",
            event_id: "$event",
            unread: 3,
        });
        expect(JSON.stringify(payload)).not.toMatch(/body|content|sender|email|mxid|matrix_id/i);
    });

    it("builds an encoded in-app route without external navigation", () => {
        expect(cfsPushTargetPath({ room_id: "!room:example", event_id: "$event/1" })).toBe(
            "/#/room/!room%3Aexample/%24event%2F1",
        );
        expect(cfsPushTargetPath({})).toBe("/");
    });
});
