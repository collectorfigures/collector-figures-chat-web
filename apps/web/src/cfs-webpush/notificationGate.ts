/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import { cfsPushTargetPath, isCfsPushForActiveOwner, safeCfsPushPayload } from "./payload";

export type CfsShowNotification = (title: string, options: NotificationOptions) => Promise<void>;

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
