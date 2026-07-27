import { expect, test } from "bun:test";
import { createIinaTraktClient, createIinaTransport } from "./trakt";

test("normalizes IINA HTTP responses and request headers", async () => {
    const calls: unknown[] = [];
    const http = {
        async get(url: string, options: unknown) {
            calls.push(["GET", url, options]);
            return {
                statusCode: 200,
                data: [{ progress: 10 }],
                text: "",
                reason: "ok"
            };
        }
    };

    const response = await createIinaTransport(http as never)(
        "GET",
        "https://api.trakt.tv/sync/playback",
        null,
        { Authorization: "Bearer token" }
    );

    expect(response.status).toBe(200);
    expect(response.data).toEqual([{ progress: 10 }]);
    expect(calls[0]).toEqual([
        "GET",
        "https://api.trakt.tv/sync/playback",
        { params: {}, headers: { Authorization: "Bearer token" }, data: null }
    ]);
});

test("serializes client operations and state writes in event order", async () => {
    const events: string[] = [];
    let releaseFirst = () => {};
    let markFirstStarted = () => {};
    const firstPending = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
    });
    let traktState = JSON.stringify({
        clientId: "client",
        clientSecret: "secret",
        tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: Date.now() + 3_600_000
        }
    });
    const preferences = {
        get() {
            return traktState;
        },
        set(_key: string, value: string) {
            events.push("write");
            traktState = value;
        },
        sync() {}
    };
    const http = {
        async post(_url: string, options: { data: { progress: number } }) {
            const progress = options.data.progress;
            events.push(`request:${progress}`);
            if (progress === 10) {
                markFirstStarted();
                await firstPending;
            }
            return { statusCode: 201, data: {}, text: "", reason: "created" };
        }
    };
    const context = {
        media: {
            id: "tt123",
            imdbId: "tt123",
            type: "movie" as const,
            name: "Movie",
            releaseInfo: "2026",
            poster: ""
        },
        episodes: []
    };
    const client = createIinaTraktClient(http as never, preferences as never, () => {});

    const first = client.sendPlayback("start", context, 10);
    const second = client.sendPlayback("pause", context, 20);
    await firstStarted;
    await Promise.resolve();
    const beforeRelease = [...events];
    releaseFirst();
    await Promise.all([first, second]);

    expect(beforeRelease).toEqual(["request:10"]);
    expect(events).toEqual(["request:10", "write", "request:20", "write"]);
});
