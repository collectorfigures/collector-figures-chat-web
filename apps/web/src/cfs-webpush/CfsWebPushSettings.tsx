/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

import React, { type JSX, useCallback, useEffect, useState } from "react";

import { useMatrixClientContext } from "../contexts/MatrixClientContext";
import LabelledCheckbox from "../components/views/elements/LabelledCheckbox";
import { SettingsSubsection, SettingsSubsectionText } from "../components/views/settings/shared/SettingsSubsection";
import { disableCfsWebPush, enableCfsWebPush, getCfsWebPushStatus, type CfsWebPushStatus } from "./CfsWebPushManager";

export function CfsWebPushSettings(): JSX.Element | null {
    const client = useMatrixClientContext();
    const [status, setStatus] = useState<CfsWebPushStatus>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();

    const refresh = useCallback(async () => setStatus(await getCfsWebPushStatus(client)), [client]);
    useEffect(() => {
        void refresh();
    }, [refresh]);

    const setEnabled = useCallback(
        async (enabled: boolean) => {
            setBusy(true);
            setError(undefined);
            try {
                if (enabled) {
                    await enableCfsWebPush(client, true);
                } else {
                    await disableCfsWebPush(client);
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : "Web Push update failed");
            } finally {
                await refresh();
                setBusy(false);
            }
        },
        [client, refresh],
    );

    if (!status?.configured) return null;

    return (
        <SettingsSubsection heading="Collector Figures Web Push" legacy={false}>
            <SettingsSubsectionText>
                Receive generic new-message notifications after the browser tab or installed PWA is closed. Message
                text, email addresses and Matrix user IDs are never included in the system notification.
            </SettingsSubsectionText>
            <LabelledCheckbox
                label="Allow background notifications on this browser"
                value={status.enabled}
                disabled={!status.available || busy}
                onChange={(enabled) => void setEnabled(enabled)}
            />
            {!status.available && <p role="status">Web Push is not supported by this browser.</p>}
            {status.permission === "denied" && (
                <p role="status">
                    Notifications are blocked in browser settings. Allow them there before trying again.
                </p>
            )}
            {error && <p role="alert">{error}</p>}
        </SettingsSubsection>
    );
}
