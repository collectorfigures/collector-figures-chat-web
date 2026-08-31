/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

const CFS_SHELL_CACHE = "cfs-shell-v1";
const CFS_SHELL_PRECACHE = ["/", "/index.html", "/manifest.json", "/cfs-icons/icon-192.png"];
const CFS_STATIC_PREFIXES = ["/bundles/", "/fonts/", "/themes/", "/cfs-icons/"];
const cfsWorkerRuntime = global as unknown as {
    skipWaiting(): Promise<void>;
    clients: { claim(): Promise<void> };
};

global.addEventListener("install", (event) => {
    // We skipWaiting() to update the service worker more frequently, particularly in development environments.
    // @ts-expect-error - service worker types are not available. See 'fetch' event handler.
    event.waitUntil(
        Promise.all([
            cfsWorkerRuntime.skipWaiting(),
            caches.open(CFS_SHELL_CACHE).then((cache) => cache.addAll(CFS_SHELL_PRECACHE)),
        ]),
    );
});

global.addEventListener("activate", (event) => {
    // We force all clients to be under our control, immediately. This could be old tabs.
    // @ts-expect-error - service worker types are not available. See 'fetch' event handler.
    event.waitUntil(
        Promise.all([
            cfsWorkerRuntime.clients.claim(),
            caches
                .keys()
                .then((keys) =>
                    Promise.all(
                        keys
                            .filter((key) => key.startsWith("cfs-shell-") && key !== CFS_SHELL_CACHE)
                            .map((key) => caches.delete(key)),
                    ),
                ),
        ]),
    );
});

// @ts-expect-error - the service worker types conflict with the DOM types available through TypeScript. Many hours
// have been spent trying to convince the type system that there's no actual conflict, but it has yet to work. Instead
// of trying to make it do the thing, we force-cast to something close enough where we can (and ignore errors otherwise).
global.addEventListener("fetch", (event: FetchEvent) => {
    if (event.request.method !== "GET") {
        return;
    }

    const url = new URL(event.request.url);

    // The CFS root worker is deliberately shell-only. Authenticated Matrix API and media requests stay in the
    // Window/SDK request path: no service worker reads, decrypts, forwards or stores a Matrix access token.
    if (isCfsShellRequest(event.request, url)) {
        event.respondWith(fetchCfsShell(event.request));
    }
});

function isCfsShellRequest(request: Request, url: URL): boolean {
    if (url.origin !== global.location.origin || url.pathname.startsWith("/_matrix/")) return false;
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/manifest.json") return true;
    return CFS_STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

async function fetchCfsShell(request: Request): Promise<Response> {
    const cache = await caches.open(CFS_SHELL_CACHE);
    if (request.mode === "navigate" || new URL(request.url).pathname === "/index.html") {
        try {
            const response = await fetch(request);
            if (response.ok) await cache.put("/index.html", response.clone());
            return response;
        } catch {
            const fallback = await cache.match("/index.html");
            if (fallback) return fallback;
            throw new Error("Collector Figures application shell is unavailable offline");
        }
    }

    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
}
