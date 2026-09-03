import { expect, test } from "bun:test";

import type { PlaybackContext } from "./messages";
import type { TraktResponse } from "./trakt";

import {
    isSimklConnected,
    parseSimklExternalLinkRequest,
    parseSimklState,
    parseSimklHistory,
    parseSimklWatchedCours,
    parseSimklWatchedPatches,
    pollSimklPin,
    requestSimklPin,
    simklScrobble,
    syncSimklHistory
} from "./simkl";

const movie = {
    id: "tt0145487",
    imdbId: "tt0145487",
    type: "movie" as const,
    name: "Spider-Man",
    releaseInfo: "2002",
    poster: "poster.jpg"
};

const series = {
    id: "tt5753856",
    imdbId: "tt5753856",
    type: "series" as const,
    name: "Dark",
    releaseInfo: "2017-2020",
    poster: "poster.jpg"
};

const episode = {
    id: "tt5753856:3:4",
    name: "The Travellers",
    season: 3,
    episode: 4,
    aired: "2020-06-27",
    description: "",
    thumbnail: ""
};

const connected = {
    clientId: "client-id",
    accessToken: "access-token",
    lastError: "",
    retryAt: 0,
    lastActivityAt: "",
    lastSyncAt: ""
};

interface Call {
    method: "GET" | "POST";
    url: string;
    body: unknown;
    headers: Record<string, string>;
}

function recorder(responses: TraktResponse[]) {
    const calls: Call[] = [];
    let index = 0;
    const transport = async (
        method: "GET" | "POST",
        url: string,
        body: unknown,
        headers: Record<string, string>
    ) => {
        calls.push({ method, url, body, headers });
        return responses[Math.min(index++, responses.length - 1)];
    };
    return { calls, transport };
}

function ok(data: unknown): TraktResponse {
    return { status: 200, data, headers: {} };
}

test("parses stored state defensively", () => {
    const empty = {
        clientId: "", accessToken: "", lastError: "", retryAt: 0, lastActivityAt: "", lastSyncAt: ""
    };
    expect(parseSimklState(null)).toEqual(empty);
    expect(parseSimklState("nonsense")).toEqual(empty);
    expect(parseSimklState({ clientId: 5, accessToken: [], retryAt: -3 })).toEqual(empty);
    expect(parseSimklState({
        clientId: "abc",
        accessToken: "tok",
        lastError: "boom",
        retryAt: 42,
        lastActivityAt: "2026-08-13T10:00:00Z",
        lastSyncAt: "2026-08-13T10:05:00Z"
    })).toEqual({
        clientId: "abc",
        accessToken: "tok",
        lastError: "boom",
        retryAt: 42,
        lastActivityAt: "2026-08-13T10:00:00Z",
        lastSyncAt: "2026-08-13T10:05:00Z"
    });
});

test("needs a client id and a token to count as connected", () => {
    expect(isSimklConnected({ ...connected, clientId: "" })).toBe(false);
    expect(isSimklConnected({ ...connected, accessToken: "" })).toBe(false);
    expect(isSimklConnected(connected)).toBe(true);
});

test("allows only the documented simkl links", () => {
    expect(parseSimklExternalLinkRequest({ url: "https://simkl.com/pin" }))
        .toBe("https://simkl.com/pin");
    expect(parseSimklExternalLinkRequest({ url: "https://simkl.com/settings/developer" }))
        .toBe("https://simkl.com/settings/developer");
    expect(parseSimklExternalLinkRequest({ url: "https://evil.example/pin" })).toBe("");
    expect(parseSimklExternalLinkRequest(null)).toBe("");
});

test("requests a pin and reports where to enter it", async () => {
    const { calls, transport } = recorder([ok({
        result: "OK",
        user_code: "ABC123",
        verification_url: "https://simkl.com/pin",
        expires_in: 900,
        interval: 5
    })]);

    const pin = await requestSimklPin(transport, { ...connected, accessToken: "" }, 1000);

    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.simkl.com/oauth/pin?client_id=client-id");
    expect(calls[0].headers["simkl-api-key"]).toBe("client-id");
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(pin).toEqual({
        userCode: "ABC123",
        verificationUrl: "https://simkl.com/pin",
        expiresAt: 1000 + 900_000,
        intervalMs: 5000
    });
});

test("rejects a pin response that is missing a code", async () => {
    const { transport } = recorder([ok({ result: "OK", expires_in: 900, interval: 5 })]);
    await expect(requestSimklPin(transport, connected, 0)).rejects.toThrow();
});

test("polls until the pin is approved", async () => {
    const { calls, transport } = recorder([
        ok({ result: "KO" }),
        ok({ result: "OK", access_token: "fresh-token" })
    ]);
    const waits: number[] = [];
    const state = { ...connected, accessToken: "", lastError: "old" };
    const pin = {
        userCode: "ABC123",
        verificationUrl: "https://simkl.com/pin",
        expiresAt: Date.now() + 60_000,
        intervalMs: 10
    };

    const result = await pollSimklPin(transport, state, pin, async (ms) => {
        waits.push(ms);
    });

    expect(calls[0].url).toBe("https://api.simkl.com/oauth/pin/ABC123?client_id=client-id");
    expect(waits).toEqual([10]);
    expect(result.accessToken).toBe("fresh-token");
    expect(result.lastError).toBe("");
});

test("keeps polling through a transient server error", async () => {
    const { calls, transport } = recorder([
        { status: 502, data: null, headers: {} },
        ok({ result: "OK", access_token: "fresh-token" })
    ]);
    const pin = {
        userCode: "ABC123",
        verificationUrl: "https://simkl.com/pin",
        expiresAt: Date.now() + 60_000,
        intervalMs: 10
    };

    const result = await pollSimklPin(transport, connected, pin, async () => {});

    expect(calls).toHaveLength(2);
    expect(result.accessToken).toBe("fresh-token");
});

test("gives up once the pin has expired", async () => {
    const { transport } = recorder([ok({ result: "KO" })]);
    const pin = {
        userCode: "ABC123",
        verificationUrl: "https://simkl.com/pin",
        expiresAt: Date.now() - 1,
        intervalMs: 10
    };

    await expect(
        pollSimklPin(transport, connected, pin, async () => {})
    ).rejects.toThrow();
});

test("scrobbles a movie to the action's path with the shared payload", async () => {
    const { calls, transport } = recorder([ok(null)]);
    const context: PlaybackContext = { media: movie, episodes: [] };

    const state = await simklScrobble(transport, connected, "start", context, 12.5);

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.simkl.com/scrobble/start");
    expect(calls[0].body).toEqual({ movie: { ids: { imdb: "tt0145487" } }, progress: 12.5 });
    expect(calls[0].headers.Authorization).toBe("Bearer access-token");
    expect(calls[0].headers["simkl-api-key"]).toBe("client-id");
    expect(state.lastError).toBe("");
});

test("scrobbles an episode with show ids and season and number", async () => {
    const { calls, transport } = recorder([ok(null)]);
    const context: PlaybackContext = { media: series, episode, episodes: [episode] };

    await simklScrobble(transport, connected, "stop", context, 96);

    expect(calls[0].url).toBe("https://api.simkl.com/scrobble/stop");
    expect(calls[0].body).toEqual({
        show: { ids: { imdb: "tt5753856" } },
        episode: { season: 3, number: 4 },
        progress: 96
    });
});

test("sends nothing when disconnected, non-imdb, or inside a retry window", async () => {
    const { calls, transport } = recorder([ok(null)]);
    const context: PlaybackContext = { media: movie, episodes: [] };

    await simklScrobble(transport, { ...connected, accessToken: "" }, "start", context, 5);
    await simklScrobble(
        transport,
        connected,
        "start",
        { media: { ...movie, imdbId: "kitsu:1" }, episodes: [] },
        5
    );
    await simklScrobble(
        transport,
        { ...connected, retryAt: 5000 },
        "start",
        context,
        5,
        null,
        1000
    );

    expect(calls).toHaveLength(0);
});

test("records a rate limit as a retry window rather than throwing", async () => {
    const { transport } = recorder([
        { status: 429, data: null, headers: { "retry-after": "30" } }
    ]);
    const context: PlaybackContext = { media: movie, episodes: [] };

    const state = await simklScrobble(transport, connected, "start", context, 5, null, 1000);

    expect(state.retryAt).toBe(1000 + 30_000);
    expect(state.lastError).not.toBe("");
    expect(state.accessToken).toBe("access-token");
});

test("clears the token when simkl rejects the credentials", async () => {
    const { transport } = recorder([{ status: 401, data: null, headers: {} }]);
    const context: PlaybackContext = { media: movie, episodes: [] };

    const state = await simklScrobble(transport, connected, "start", context, 5);

    expect(state.accessToken).toBe("");
    expect(state.clientId).toBe("client-id");
    expect(state.lastError).not.toBe("");
});

test("never lets a transport rejection carry the url into the error", async () => {
    const transport = async (_method: "GET" | "POST", url: string) => {
        throw new Error(`connect ECONNREFUSED ${url}?client_id=client-id`);
    };
    const context: PlaybackContext = { media: movie, episodes: [] };

    const state = await simklScrobble(transport, connected, "start", context, 5);

    // The reason survives so a failure can be diagnosed; the url it was quoted with does not.
    expect(state.lastError).toBe("Simkl request failed: connect ECONNREFUSED");
    expect(state.lastError).not.toContain("client-id");
});

const activities = ok({ all: "2026-08-13T10:00:00Z" });

test("skips the item lists when nothing changed since the last sync", async () => {
    const { calls, transport } = recorder([activities]);

    const result = await syncSimklHistory(
        transport,
        { ...connected, lastActivityAt: "2026-08-13T10:00:00Z" },
        []
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sync/activities");
    expect(result.history).toEqual([]);
});

test("pulls the full lists on a first sync and stores the activity cursor", async () => {
    const { calls, transport } = recorder([
        activities,
        ok({
            movies: [{
                last_watched_at: "2026-08-10T20:00:00Z",
                status: "completed",
                movie: { title: "Spider-Man", year: 2002, ids: { imdb: "tt0145487" } }
            }],
            shows: [{
                last_watched_at: "2026-08-11T21:00:00Z",
                status: "watching",
                last_watched: "S03E04",
                show: { title: "Dark", year: 2017, ids: { imdb: "tt5753856" } }
            }]
        }),
        ok([])
    ]);

    const result = await syncSimklHistory(transport, connected, []);

    expect(calls.map((call) => call.url)).toEqual([
        "https://api.simkl.com/sync/activities",
        "https://api.simkl.com/sync/all-items/?extended=full_anime_seasons&episode_watched_at=yes&include_all_episodes=yes",
        "https://api.simkl.com/sync/playback"
    ]);
    expect(result.state.lastActivityAt).toBe("2026-08-13T10:00:00Z");
    expect(result.history.map((entry) => entry.id)).toEqual([
        "tt5753856:3:4",
        "tt0145487"
    ]);
    expect(result.history.every((entry) => entry.watched)).toBe(true);
    expect(result.watchedPatches).toEqual([]);
});

test("sends the stored cursor as date_from on later syncs", async () => {
    const { calls, transport } = recorder([activities, ok({}), ok([])]);

    await syncSimklHistory(
        transport,
        { ...connected, lastActivityAt: "2026-08-01T00:00:00Z" },
        []
    );

    expect(calls[1].url).toContain("date_from=2026-08-01T00%3A00%3A00Z");
    expect(calls[2].url).toContain("date_from=2026-08-01T00%3A00%3A00Z");
});

test("parses exact watched episodes into per-show patches", () => {
    expect(parseSimklWatchedPatches({
        shows: [
            {
                show: { title: "Dark", ids: { imdb: "tt5753856" } },
                seasons: [{ number: 2, episodes: [
                    { number: 1, watched_at: "2026-09-01T00:00:00Z" },
                    { number: 2 },
                    { number: 3, watched_at: "2026-09-02T00:00:00Z" }
                ] }]
            },
            {
                show: { title: "Cleared", ids: { imdb: "tt1234567" } },
                seasons: []
            },
            {
                show: { title: "Not included", ids: { tmdb: 1 } },
                seasons: [{ number: 1, episodes: [{ number: 1 }] }]
            }
        ],
        // Anime never becomes an IMDb-keyed patch: Simkl reports Bleach's later cours under
        // the 2004 series they continue, so this id would mark a different show watched.
        anime: [{
            show: { title: "Mapped", ids: { imdb: "tt0434665", mal: "56784" } },
            seasons: [{ number: 1, episodes: [{ number: 1, watched_at: "a" }] }]
        }]
    })).toEqual([
        { id: "tt5753856", episodes: ["2:1", "2:3"] },
        { id: "tt1234567", episodes: [] }
    ]);
});

test("reads anime watched episodes as cour numbers keyed by MAL id", () => {
    expect(parseSimklWatchedCours({
        // The `tvdb` mapping each anime episode carries addresses the whole franchise
        // (Bleach cour one is TVDB season 17), so only the cour's own numbering is kept.
        anime: [
            {
                show: { title: "Bleach", ids: { imdb: "tt14986406", mal: "41467" } },
                seasons: [{
                    number: 1,
                    episodes: [
                        { number: 1, watched_at: "a", tvdb: { season: 17, episode: 1 } },
                        { number: 2, watched_at: "b", tvdb: { season: 17, episode: 2 } },
                        { number: 3, tvdb: { season: 17, episode: 3 } },
                        { number: -1, watched_at: "c" },
                        { number: 2.5, watched_at: "d" },
                        null
                    ]
                }]
            },
            { show: { ids: { mal: "53998" } }, seasons: "bad" },
            { show: { ids: { imdb: "tt0434665" } }, seasons: [{ number: 1, episodes: [{ number: 1, watched_at: "a" }] }] }
        ],
        shows: [{
            show: { ids: { imdb: "tt5753856" } },
            seasons: [{ number: 1, episodes: [{ number: 1, watched_at: "a" }] }]
        }]
    })).toEqual([{ malId: "41467", episodes: [1, 2] }]);
    expect(parseSimklWatchedCours({})).toEqual([]);
});

test("does not turn missing or malformed episode lists into clearing patches", () => {
    expect(parseSimklWatchedPatches({
        shows: [
            { show: { ids: { imdb: "tt5753856" } } },
            { show: { ids: { imdb: "tt5753856" } }, seasons: "bad" },
            {
                show: { ids: { imdb: "tt5753856" } },
                seasons: [{ number: "bad", episodes: [] }]
            },
            null
        ],
        anime: [{ show: { ids: { imdb: "tt2098220" } }, seasons: [{ number: 1 }] }]
    })).toEqual([]);
});

test("treats bare anime episode numbers as season one", () => {
    const history = parseSimklHistory({
        anime: [{
            last_watched_at: "2026-08-12T09:00:00Z",
            last_watched: "E148",
            show: { title: "Hunter x Hunter", year: 2011, ids: { imdb: "tt2098220" } }
        }]
    }, []);

    expect(history).toHaveLength(1);
    expect(history[0].id).toBe("tt2098220:1:148");
    expect(history[0].episode?.season).toBe(1);
    expect(history[0].episode?.episode).toBe(148);
});

test("turns paused playback sessions into unwatched progress entries", () => {
    const history = parseSimklHistory(null, [
        {
            id: 123,
            progress: 45.5,
            paused_at: "2026-08-12T10:30:00Z",
            type: "episode",
            episode: { season: 3, episode: 4, title: "The Travellers" },
            show: { title: "Dark", year: 2017, ids: { imdb: "tt5753856" } }
        },
        {
            id: 124,
            progress: 75,
            paused_at: "2026-08-12T11:15:00Z",
            type: "movie",
            movie: { title: "Spider-Man", year: 2002, ids: { imdb: "tt0145487" } }
        }
    ]);

    expect(history.map((entry) => [entry.id, entry.watched, entry.progress])).toEqual([
        ["tt0145487", false, 75],
        ["tt5753856:3:4", false, 45.5]
    ]);
    expect(history[1].episode?.name).toBe("The Travellers");
});

test("reads anime playback sessions, which name the title and episode differently", () => {
    // Live shape: the title arrives under `anime` and the episode under `number`.
    const history = parseSimklHistory(null, [{
        id: 29485829,
        progress: 46.14,
        paused_at: "2026-08-28T16:16:32Z",
        type: "episode",
        episode: { season: 1, number: 22, title: "The Defeated", tvdb_season: 1, tvdb_number: 22 },
        anime: { title: "Attack on Titan", year: 2013, ids: { imdb: "tt2560140" } }
    }]);

    expect(history.map((entry) => [entry.id, entry.watched, entry.progress])).toEqual([
        ["tt2560140:1:22", false, 46.14]
    ]);
});

test("drops remote items that carry no usable imdb id or position", () => {
    const history = parseSimklHistory({
        movies: [
            { status: "plantowatch", movie: { title: "Ajin 2", ids: { tmdb: "1" } } },
            { last_watched_at: "2026-08-12T09:00:00Z", movie: { title: "Ajin 2", ids: {} } }
        ],
        shows: [{
            last_watched_at: "2026-08-12T09:00:00Z",
            last_watched: null,
            show: { title: "Dark", ids: { imdb: "tt5753856" } }
        }]
    }, [{ progress: 10, paused_at: "", type: "movie", movie: { ids: { imdb: "tt0145487" } } }]);

    expect(history).toEqual([]);
});

test("keeps a local watched flag when simkl only reports paused progress", async () => {
    const { transport } = recorder([
        activities,
        ok({}),
        ok([{
            progress: 12,
            paused_at: "2026-08-12T10:30:00Z",
            type: "movie",
            movie: { title: "Spider-Man", year: 2002, ids: { imdb: "tt0145487" } }
        }])
    ]);
    const local = [{
        id: "tt0145487",
        media: movie,
        lastPlayedAt: "2026-08-12T12:00:00Z",
        watched: true,
        progress: 100
    }];

    const result = await syncSimklHistory(transport, connected, local);

    expect(result.history).toHaveLength(1);
    expect(result.history[0].watched).toBe(true);
});

test("reports a sync failure without clearing local history", async () => {
    const { transport } = recorder([{ status: 429, data: null, headers: { "retry-after": "30" } }]);
    const local = [{
        id: "tt0145487",
        media: movie,
        lastPlayedAt: "2026-08-12T12:00:00Z",
        watched: true,
        progress: 100
    }];

    const result = await syncSimklHistory(transport, connected, local, 1000);

    expect(result.history).toBe(local);
    expect(result.state.retryAt).toBe(1000 + 30_000);
    expect(result.state.accessToken).toBe("access-token");
    expect(result.watchedPatches).toEqual([]);
});

test("records when a pull last succeeded, including the one that had nothing to fetch", async () => {
    const changed = recorder([activities, ok({}), ok([])]);
    const pulled = await syncSimklHistory(changed.transport, connected, [], 1_700_000_000_000);
    expect(pulled.state.lastSyncAt).toBe("2023-11-14T22:13:20.000Z");

    const unchanged = recorder([activities]);
    const skipped = await syncSimklHistory(
        unchanged.transport,
        { ...connected, lastActivityAt: "2026-08-13T10:00:00Z" },
        [],
        1_700_000_000_000
    );
    expect(skipped.state.lastSyncAt).toBe("2023-11-14T22:13:20.000Z");
});

test("keeps why a request was rejected but never its url", async () => {
    const rejecting = async () => {
        throw new Error(
            "A server with the specified hostname could not be found. " +
            "URL: https://api.simkl.com/oauth/pin?client_id=private-client-id"
        );
    };

    const result = await syncSimklHistory(rejecting, connected, []);

    expect(result.state.lastError).toContain("A server with the specified hostname");
    expect(result.state.lastError).not.toContain("private-client-id");
    expect(result.state.lastError).not.toContain("api.simkl.com");
    // A failed pull has not synced, and the cursor must not advance past what was never read.
    expect(result.state.lastSyncAt).toBe("");
    expect(result.state.lastActivityAt).toBe("");
});
