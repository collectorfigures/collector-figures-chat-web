/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import {
    CFS_OWNER_FINGERPRINT_PATTERN,
    cfsPushTargetPath,
    isCfsPushForActiveOwner,
    safeCfsPushPayload,
} from "./payload";

export type CfsShowNotification = (title: string, options: NotificationOptions) => Promise<void>;

export interface CfsNotificationClickData {
    cfsSchema?: unknown;
    accountFingerprint?: unknown;
    targetPath?: unknown;
}

export function cfsNotificationClickTarget(
    rawData: unknown,
    activeOwner: string | undefined,
    origin: string,
): string | undefined {
    if (!rawData || typeof rawData !== "object") return undefined;
    const data = rawData as CfsNotificationClickData;
    if (
        data.cfsSchema !== 1 ||
        typeof data.accountFingerprint !== "string" ||
        !CFS_OWNER_FINGERPRINT_PATTERN.test(data.accountFingerprint) ||
        typeof activeOwner !== "string" ||
        !CFS_OWNER_FINGERPRINT_PATTERN.test(activeOwner) ||
        data.accountFingerprint !== activeOwner ||
        typeof data.targetPath !== "string" ||
        data.targetPath.length === 0 ||
        data.targetPath.length > 2048
    ) {
        return undefined;
    }

    let target: URL;
    try {
        target = new URL(data.targetPath, origin);
    } catch {
        return undefined;
    }
    const internalHash = target.hash === "" || /^#\/room\/[^/?#]+(?:\/[^/?#]+)?$/.test(target.hash);
    if (
        target.origin !== origin ||
        target.username !== "" ||
        target.password !== "" ||
        target.pathname !== "/" ||
        target.search !== "" ||
        !internalHash
    ) {
        return undefined;
    }
    return target.href;
}

export async function showCfsNotificationForActiveOwner(
    rawPayload: unknown,
    activeOwner: string | undefined,
    showNotification: CfsShowNotification,
): Promise<boolean> {
    const payload = safeCfsPushPayload(rawPayload);
    if (!isCfsPushForActiveOwner(payload, activeOwner)) return false;

    await showNotification("Collector Figures", {
        body: "You have a new message",
        icon: "/cfs-icons/icon-192.png",
        badge: "/cfs-icons/icon-192.png",
        tag: `cfs-new-message-${activeOwner}`,
        data: {
            cfsSchema: 1,
            accountFingerprint: activeOwner,
            targetPath: cfsPushTargetPath(payload),
        },
    });
    return true;
}
