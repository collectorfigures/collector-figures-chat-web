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

export const CFS_OWNER_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function safeCfsPushPayload(raw: unknown): CfsPushPayload {
    if (!raw || typeof raw !== "object") return {};
    const value = raw as Record<string, unknown>;
    return {
        cfs_schema: value.cfs_schema === 1 ? 1 : undefined,
        cfs_account_fingerprint:
            typeof value.cfs_account_fingerprint === "string" &&
            CFS_OWNER_FINGERPRINT_PATTERN.test(value.cfs_account_fingerprint)
                ? value.cfs_account_fingerprint
                : undefined,
        room_id: typeof value.room_id === "string" ? value.room_id.slice(0, 512) : undefined,
        event_id: typeof value.event_id === "string" ? value.event_id.slice(0, 512) : undefined,
        unread: Number.isSafeInteger(value.unread) ? (value.unread as number) : undefined,
    };
}

export function isCfsPushForActiveOwner(payload: CfsPushPayload, activeOwner?: string): boolean {
    return (
        payload.cfs_schema === 1 &&
        typeof activeOwner === "string" &&
        CFS_OWNER_FINGERPRINT_PATTERN.test(activeOwner) &&
        payload.cfs_account_fingerprint === activeOwner
    );
}

export function cfsPushTargetPath(payload: CfsPushPayload): string {
    if (!payload.room_id) return "/";
    const room = encodeURIComponent(payload.room_id);
    const event = payload.event_id ? `/${encodeURIComponent(payload.event_id)}` : "";
    return `/#/room/${room}${event}`;
}
