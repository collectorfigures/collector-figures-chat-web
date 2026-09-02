/*
Copyright 2026 Collector Figures

SPDX-License-Identifier: AGPL-3.0-only
*/

const MUTATION_KEY = "cfs_webpush_mutation_v1";

interface StoredMutation {
    cfs_schema: 1;
    operationId: string;
}

export interface CfsWebPushMutation {
    operationId: string;
}

export class SupersededCfsWebPushMutationError extends Error {}

function isStoredMutation(value: unknown): value is StoredMutation {
    if (!value || typeof value !== "object") return false;
    const record = value as Partial<StoredMutation>;
    return record.cfs_schema === 1 && typeof record.operationId === "string" && record.operationId.length > 0;
}

export function readCfsWebPushMutation(): CfsWebPushMutation | undefined {
    try {
        const raw = window.localStorage.getItem(MUTATION_KEY);
        if (!raw) return undefined;
        const value: unknown = JSON.parse(raw);
        return isStoredMutation(value) ? { operationId: value.operationId } : undefined;
    } catch {
        return undefined;
    }
}

export function publishCfsWebPushMutation(): CfsWebPushMutation {
    const operation: CfsWebPushMutation = { operationId: window.crypto.randomUUID() };
    const stored: StoredMutation = { cfs_schema: 1, operationId: operation.operationId };
    window.localStorage.setItem(MUTATION_KEY, JSON.stringify(stored));
    assertCurrentCfsWebPushMutation(operation);
    return operation;
}

export function isCurrentCfsWebPushMutation(operation: CfsWebPushMutation): boolean {
    return readCfsWebPushMutation()?.operationId === operation.operationId;
}

export function assertCurrentCfsWebPushMutation(operation: CfsWebPushMutation): void {
    if (!isCurrentCfsWebPushMutation(operation)) {
        throw new SupersededCfsWebPushMutationError("CFS Web Push mutation was superseded by another page");
    }
}

export async function waitForCurrentCfsWebPushMutation<T>(
    operation: CfsWebPushMutation,
    action: () => Promise<T>,
): Promise<T> {
    assertCurrentCfsWebPushMutation(operation);
    const result = await action();
    assertCurrentCfsWebPushMutation(operation);
    return result;
}

export function supersedeCfsWebPushMutation(): string {
    return publishCfsWebPushMutation().operationId;
}
