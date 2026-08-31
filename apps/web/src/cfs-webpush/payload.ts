/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

export interface CfsPushPayload {
    cfs_schema?: number;
    cfs_account_fingerprint?: string;
    room_id?: string;
    event_id?: string;
    unread?: number;
}

export function safeCfsPushPayload(raw: unknown): CfsPushPayload {
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

export function cfsPushTargetPath(payload: CfsPushPayload): string {
    if (!payload.room_id) return "/";
    const room = encodeURIComponent(payload.room_id);
    const event = payload.event_id ? `/${encodeURIComponent(payload.event_id)}` : "";
    return `/#/room/${room}${event}`;
}
