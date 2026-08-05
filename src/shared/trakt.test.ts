import { expect, test } from "bun:test";
import { parseWatchHistory } from "./history";
import type { PlaybackContext } from "./messages";
import {
    buildScrobblePayload,
    mergeWatchHistory,
    parseTraktExternalLinkRequest,
    parseTraktHistory,
    parseTraktState,
    pollDeviceToken,
    requestDeviceCode,
    scrobble,
    syncTraktHistory,
    type TraktResponse,
    type TraktTransport
} from "./trakt";

test("allows only Popcorn's Trakt browser destinations", () => {
    expect(parseTraktExternalLinkRequest({ url: "https://trakt.tv/join" }))
        .toBe("https://trakt.tv/join");
    expect(parseTraktExternalLinkRequest({ url: "https://app.trakt.tv/settings/apps/api" }))
        .toBe("https://app.trakt.tv/settings/apps/api");
    expect(parseTraktExternalLinkRequest({ url: "https://trakt.tv/activate/ABCD1234" }))
        .toBe("https://trakt.tv/activate/ABCD1234");
    expect(parseTraktExternalLinkRequest({ url: "https://example.com" })).toBe("");
});

const movie = {
    id: "tt123",
    imdbId: "tt123",
    type: "movie" as const,
    name: "Movie",
    releaseInfo: "2026",
    poster: ""
};

function queueTransport(responses: TraktResponse[]): TraktTransport {
    return async () => {
        const response = responses.shift();
        if (!response) throw new Error("Unexpected request");
        return response;
    };
}

interface RecordedRequest {
    method: "GET" | "POST";
    url: string;
    body: unknown;
    headers: Record<string, string>;
}

function recordingTransport(
    responses: TraktResponse[],
    calls: RecordedRequest[]
): TraktTransport {
    return async (method, url, body, headers) => {
        calls.push({ method, url, body, headers });
        const response = responses.shift();
        if (!response) throw new Error("Unexpected request");
        return response;
    };
}

test("parses Trakt state defensively without retaining invalid tokens", () => {
    expect(parseTraktState("bad")).toMatchObject({
        clientId: "",
        clientSecret: "",
        tokens: null,
        initialHistoryUploaded: false
    });
    expect(parseTraktState(JSON.stringify({
        clientId: "id",
        clientSecret: "secret",
        tokens: { accessToken: 1 }
    })).tokens).toBeNull();
});

test("builds movie and episode scrobble payloads from existing IDs", () => {
    const movieContext: PlaybackContext = { media: movie, episodes: [] };
    expect(buildScrobblePayload(movieContext, 42)).toEqual({
        movie: { ids: { imdb: "tt123" } },
        progress: 42
    });

    const episode = {
        id: "tt456:2:3",
        name: "Episode",
        season: 2,
        episode: 3,
        aired: "",
        description: "",
        thumbnail: ""
    };
    expect(buildScrobblePayload({
        media: { ...movie, imdbId: "tt456", type: "series", name: "Show" },
        episode,
        episodes: [episode]
    }, 75)).toEqual({
        show: { ids: { imdb: "tt456" } },
        episode: { season: 2, number: 3 },
        progress: 75
    });
});

test("parses Trakt playback and watched items into local history", () => {
    const entries = parseTraktHistory(
        [{
            progress: 37.5,
            paused_at: "2026-07-27T10:00:00.000Z",
            type: "episode",
            episode: { season: 1, number: 2, title: "Second" },
            show: { title: "Show", year: 2026, ids: { imdb: "tt456" } }
        }],
        [{
            watched_at: "2026-07-26T10:00:00.000Z",
            type: "movie",
            movie: { title: "Movie", year: 2026, ids: { imdb: "tt123" } }
        }]
    );

    expect(entries).toEqual([
        expect.objectContaining({ id: "tt456:1:2", progress: 37.5, watched: false }),
        expect.objectContaining({ id: "tt123", progress: 100, watched: true })
    ]);
});

test("keeps remote episodes without a Trakt title after history persistence", () => {
    const entries = parseTraktHistory([{
        progress: 37.5,
        paused_at: "2026-07-27T10:00:00.000Z",
        type: "episode",
        episode: { season: 1, number: 2 },
        show: { title: "Show", year: 2026, ids: { imdb: "tt456" } }
    }], []);

    expect(parseWatchHistory(JSON.stringify(entries))).toHaveLength(1);
});

test("merges by newest timestamp while keeping watched and rich metadata", () => {
    const local = [{
        id: "tt123",
        media: { ...movie, poster: "poster.jpg" },
        lastPlayedAt: "2026-07-25T10:00:00.000Z",
        watched: true,
        progress: 100
    }];
    const remote = [{
        id: "tt123",
        media: movie,
        lastPlayedAt: "2026-07-27T10:00:00.000Z",
        watched: false,
        progress: 20
    }];

    expect(mergeWatchHistory(local, remote)[0]).toMatchObject({
        watched: true,
        progress: 20,
        lastPlayedAt: "2026-07-27T10:00:00.000Z",
        media: { poster: "poster.jpg" }
    });
});

test("requests a device code and polls at the supplied interval", async () => {
    const state = parseTraktState({ clientId: "id", clientSecret: "secret" });
    const code = await requestDeviceCode(queueTransport([{
        status: 200,
        data: {
            device_code: "device",
            user_code: "USERCODE",
            verification_url: "https://trakt.tv/activate",
            expires_in: 600,
            interval: 1
        },
        headers: {}
    }]), state);
    expect(code.userCode).toBe("USERCODE");

    const delays: number[] = [];
    const connected = await pollDeviceToken(queueTransport([
        { status: 400, data: {}, headers: {} },
        {
            status: 200,
            data: {
                access_token: "access",
                refresh_token: "refresh",
                created_at: 100,
                expires_in: 604800
            },
            headers: {}
        }
    ]), state, code, async (ms) => { delays.push(ms); });

    expect(delays).toEqual([1000]);
    expect(connected.tokens).toEqual({
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 604900000
    });
});

test("refreshes an expiring access token before an authenticated request", async () => {
    const now = 1_000_000;
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: {
            accessToken: "old-access",
            refreshToken: "refresh",
            expiresAt: now + 1
        }
    });
    const calls: RecordedRequest[] = [];
    await scrobble(recordingTransport([
        {
            status: 200,
            data: {
                access_token: "new-access",
                refresh_token: "new-refresh",
                created_at: 1000,
                expires_in: 604800
            },
            headers: {}
        },
        { status: 200, data: {}, headers: {} }
    ], calls), state, "pause", { media: movie, episodes: [] }, 42, now);

    expect(calls.map((call) => call.url)).toEqual([
        "https://api.trakt.tv/oauth/token",
        "https://api.trakt.tv/scrobble/pause"
    ]);
    expect(calls[1].headers.Authorization).toBe("Bearer new-access");
});

test("requires reconnect when Trakt rejects an expiring refresh token", async () => {
    const now = 1_000_000;
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: {
            accessToken: "expired-access",
            refreshToken: "rejected-refresh",
            expiresAt: now + 1
        }
    });

    const result = await scrobble(queueTransport([{
        status: 400,
        data: { error: "invalid_grant" },
        headers: {}
    }]), state, "pause", { media: movie, episodes: [] }, 42, now);

    expect(result.tokens).toBeNull();
    expect(result.reconnectRequired).toBe(true);
    expect(result.lastError).toBe("Trakt connection expired. Reconnect required.");
    expect(result.retryAt).toBe(0);
});

test("uses pause below 90 percent and stop at the watched threshold", async () => {
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 2_000_000
        }
    });
    const calls: RecordedRequest[] = [];
    const transport = recordingTransport([
        { status: 200, data: {}, headers: {} },
        { status: 200, data: {}, headers: {} }
    ], calls);

    await scrobble(transport, state, "pause", { media: movie, episodes: [] }, 89.9, 1_000_000);
    await scrobble(transport, state, "stop", { media: movie, episodes: [] }, 90, 1_000_000);

    expect(calls.map((call) => call.url)).toEqual([
        "https://api.trakt.tv/scrobble/pause",
        "https://api.trakt.tv/scrobble/stop"
    ]);
});

test("skips scrobbling provider-only media without an IMDb ID", async () => {
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: { accessToken: "access", refreshToken: "refresh", expiresAt: 2_000_000 }
    });
    const calls: RecordedRequest[] = [];
    const result = await scrobble(
        recordingTransport([], calls),
        state,
        "pause",
        { media: { ...movie, id: "kitsu:1", imdbId: "" }, episodes: [] },
        42,
        1_000_000
    );
    expect(calls).toEqual([]);
    expect(result).toBe(state);
});

test("merges fetched playback and watched history and uploads local watched once", async () => {
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 2_000_000
        }
    });
    const local = [{
        id: movie.imdbId,
        media: movie,
        lastPlayedAt: "2026-07-27T10:00:00.000Z",
        watched: true,
        progress: 100
    }];
    const calls: RecordedRequest[] = [];
    const result = await syncTraktHistory(recordingTransport([
        { status: 200, data: [], headers: {} },
        { status: 200, data: [], headers: {} },
        { status: 201, data: { added: { movies: 1 } }, headers: {} }
    ], calls), state, local, 1_000_000);

    expect(calls.map((call) => [call.method, call.url])).toEqual([
        ["GET", "https://api.trakt.tv/sync/playback"],
        ["GET", "https://api.trakt.tv/sync/history?limit=100"],
        ["POST", "https://api.trakt.tv/sync/history"]
    ]);
    expect(calls[2].body).toEqual({
        movies: [{ watched_at: "2026-07-27T10:00:00.000Z", ids: { imdb: "tt123" } }],
        episodes: []
    });
    expect(result.state.initialHistoryUploaded).toBe(true);
    expect(result.history[0].id).toBe("tt123");
});

test("uploads watched episodes using the show IMDb ID and episode numbers", async () => {
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 2_000_000
        }
    });
    const calls: RecordedRequest[] = [];
    await syncTraktHistory(recordingTransport([
        { status: 200, data: [], headers: {} },
        { status: 200, data: [], headers: {} },
        { status: 201, data: {}, headers: {} }
    ], calls), state, [{
        id: "tt456:2:3",
        media: { ...movie, id: "tt456", imdbId: "tt456", type: "series", name: "Show" },
        episode: {
            id: "tt456:2:3",
            name: "Episode",
            season: 2,
            episode: 3,
            aired: "",
            description: "",
            thumbnail: ""
        },
        lastPlayedAt: "2026-07-27T10:00:00.000Z",
        watched: true,
        progress: 100
    }], 1_000_000);

    expect(calls[2].body).toEqual({
        movies: [],
        episodes: [],
        shows: [{
            ids: { imdb: "tt456" },
            seasons: [{
                number: 2,
                episodes: [{
                    number: 3,
                    watched_at: "2026-07-27T10:00:00.000Z"
                }]
            }]
        }]
    });
});

test("records Retry-After without retrying immediately", async () => {
    const now = 1_000_000;
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 2_000_000
        }
    });
    const calls: RecordedRequest[] = [];
    const result = await scrobble(recordingTransport([{
        status: 429,
        data: {},
        headers: { "retry-after": "12" }
    }], calls), state, "pause", { media: movie, episodes: [] }, 42, now);

    expect(calls).toHaveLength(1);
    expect(result.retryAt).toBe(now + 12_000);
});

test("records sync Retry-After and returns unchanged local history", async () => {
    const now = 1_000_000;
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 2_000_000
        }
    });
    const local = [{
        id: movie.imdbId,
        media: movie,
        lastPlayedAt: "2026-07-27T10:00:00.000Z",
        watched: false,
        progress: 42
    }];
    const result = await syncTraktHistory(queueTransport([{
        status: 429,
        data: {},
        headers: { "Retry-After": "12" }
    }]), state, local, now);

    expect(result.history).toBe(local);
    expect(result.state.retryAt).toBe(now + 12_000);
});

test("dedupes remote watched episodes with noncanonical local IDs", async () => {
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 2_000_000
        }
    });
    const calls: RecordedRequest[] = [];
    const result = await syncTraktHistory(recordingTransport([
        { status: 200, data: [], headers: {} },
        {
            status: 200,
            data: [{
                type: "episode",
                watched_at: "2026-07-27T10:00:00.000Z",
                show: { title: "Show", ids: { imdb: "tt456" } },
                episode: { title: "Episode", season: 2, number: 3 }
            }],
            headers: {}
        }
    ], calls), state, [{
        id: "addon-episode-id",
        media: { ...movie, id: "tt456", imdbId: "tt456", type: "series", name: "Show" },
        episode: {
            id: "addon-episode-id",
            name: "Episode",
            season: 2,
            episode: 3,
            aired: "",
            description: "",
            thumbnail: ""
        },
        lastPlayedAt: "2026-07-26T10:00:00.000Z",
        watched: true,
        progress: 100
    }], 1_000_000);

    expect(calls).toHaveLength(2);
    expect(result.history).toHaveLength(1);
});

test("records scrobble transport failures without rejecting playback", async () => {
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 2_000_000
        }
    });
    const result = await scrobble(
        async () => { throw new Error("Network unavailable"); },
        state,
        "pause",
        { media: movie, episodes: [] },
        42,
        1_000_000
    );

    expect(result.lastError).toBe("Network unavailable");
    expect(result.tokens).toEqual(state.tokens);
});
