import { expect, test } from "bun:test";

import type { PlaybackContext } from "./messages";
import type { TraktResponse } from "./trakt";

import {
    isSimklConnected,
    parseSimklExternalLinkRequest,
    parseSimklState,
    pollSimklPin,
    requestSimklPin,
    simklScrobble
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
    retryAt: 0
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
    const empty = { clientId: "", accessToken: "", lastError: "", retryAt: 0 };
    expect(parseSimklState(null)).toEqual(empty);
    expect(parseSimklState("nonsense")).toEqual(empty);
    expect(parseSimklState({ clientId: 5, accessToken: [], retryAt: -3 })).toEqual(empty);
    expect(parseSimklState({
        clientId: "abc",
        accessToken: "tok",
        lastError: "boom",
        retryAt: 42
    })).toEqual({ clientId: "abc", accessToken: "tok", lastError: "boom", retryAt: 42 });
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
        1000
    );

    expect(calls).toHaveLength(0);
});

test("records a rate limit as a retry window rather than throwing", async () => {
    const { transport } = recorder([
        { status: 429, data: null, headers: { "retry-after": "30" } }
    ]);
    const context: PlaybackContext = { media: movie, episodes: [] };

    const state = await simklScrobble(transport, connected, "start", context, 5, 1000);

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

    expect(state.lastError).toBe("Simkl request failed.");
    expect(state.lastError).not.toContain("client-id");
});
