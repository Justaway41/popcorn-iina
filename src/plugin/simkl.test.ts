import { expect, test } from "bun:test";

import { createIinaSimklClient } from "./simkl";

const connected = {
    clientId: "client-id",
    accessToken: "access-token",
    lastError: "",
    retryAt: 0,
    lastActivityAt: "",
    lastSyncAt: ""
};

function preferences(value: unknown) {
    let stored = value;
    return {
        get() {
            return stored;
        },
        set(_key: string, next: unknown) {
            stored = next;
        },
        sync() {}
    };
}

test("returns an empty watched patch list when disconnected", async () => {
    const client = createIinaSimklClient({} as never, preferences({ ...connected, accessToken: "" }) as never, () => {});

    expect(await client.sync([])).toEqual({ history: [], watchedPatches: [], watchedCours: [] });
});

test("returns exact watched patches from a connected sync", async () => {
    const http = {
        async get(url: string) {
            if (url.endsWith("/sync/activities")) {
                return { statusCode: 200, data: { all: "2026-09-03T00:00:00Z" }, text: "" };
            }
            if (url.includes("/sync/all-items/")) {
                return {
                    statusCode: 200,
                    data: {
                        shows: [{
                            show: { title: "Dark", ids: { imdb: "tt5753856" } },
                            seasons: [{
                                number: 2,
                                episodes: [{ number: 1, watched_at: "2026-09-03T00:00:00Z" }]
                            }]
                        }]
                    },
                    text: ""
                };
            }
            return { statusCode: 200, data: [], text: "" };
        }
    };
    const client = createIinaSimklClient(
        http as never,
        preferences(connected) as never,
        () => {}
    );

    expect(await client.sync([])).toEqual({
        history: [],
        watchedPatches: [{ id: "tt5753856", episodes: ["2:1"] }],
        watchedCours: []
    });
});

test("drops watched patches from an account disconnected during sync", async () => {
    let stored: unknown = connected;
    let releaseRequest = () => {};
    let markRequestStarted = () => {};
    const requestPending = new Promise<void>((resolve) => {
        releaseRequest = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve;
    });
    const store = {
        get() { return stored; },
        set(_key: string, value: unknown) { stored = value; },
        sync() {}
    };
    const http = {
        async get(url: string) {
            if (url.endsWith("/sync/activities")) {
                markRequestStarted();
                await requestPending;
                return { statusCode: 200, data: { all: "2026-09-03T00:00:00Z" }, text: "" };
            }
            if (url.includes("/sync/all-items/")) {
                return {
                    statusCode: 200,
                    data: {
                        shows: [{
                            show: { ids: { imdb: "tt5753856" } },
                            seasons: [{
                                number: 1,
                                episodes: [{ number: 1, watched_at: "2026-09-03T00:00:00Z" }]
                            }]
                        }]
                    },
                    text: ""
                };
            }
            return { statusCode: 200, data: [], text: "" };
        }
    };
    const client = createIinaSimklClient(http as never, store as never, () => {});

    const result = client.sync([]);
    await requestStarted;
    stored = { ...connected, accessToken: "" };
    releaseRequest();

    expect(await result).toEqual({ history: [], watchedPatches: [], watchedCours: [] });
});
