import { expect, test } from "bun:test";

import "./iina-test-env";

import type { WatchedCour } from "../shared/history";
import type { Media } from "../shared/stremio";
import { createAnimeChainClient } from "./anime";

/**
 * Cinemeta for one series, and an AniList that knows nothing. A chain the relations did not
 * supply is exactly the state a fresh device is in during an AniList outage, which is when the
 * placement used to start guessing.
 */
/** Cinemeta for several shows at once, keyed by IMDb id. */
function multiStubs(
    shows: Record<string, { name: string; seasons: Array<{ season: number; count: number }> }>,
    storedChains: Record<string, Array<{ anilistId: number; malId: string; episodes: number | null }>> = {}
) {
    const http = {
        async get(url: string) {
            const imdbId = url.match(/series\/(tt\d+)\.json/)?.[1] ?? "";
            const show = shows[imdbId];
            if (!show) return { statusCode: 404, text: "", data: null };
            const videos = show.seasons.flatMap(({ season, count }) =>
                Array.from({ length: count }, (_unused, index) => ({
                    id: `${imdbId}:${season}:${index + 1}`,
                    name: `Episode ${index + 1}`,
                    season,
                    number: index + 1,
                    released: "2022-10-11T00:00:00.000Z"
                })));
            return {
                statusCode: 200,
                text: "",
                data: { meta: { id: imdbId, type: "series", name: show.name, videos } }
            };
        },
        // AniList is unreachable, which is the state that made this placement matter.
        async post() { return { statusCode: 429, text: "", data: null }; }
    };
    const store = new Map<string, unknown>([["animeChains", storedChains]]);
    const preferences = {
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => store.set(key, value),
        sync: () => {}
    };
    return createAnimeChainClient(http as never, preferences as never);
}

function stubs(seasons: Array<{ season: number; count: number }>, name = "Bleach") {
    const requests: string[] = [];
    const videos = seasons.flatMap(({ season, count }) =>
        Array.from({ length: count }, (_unused, index) => ({
            id: `tt14986406:${season}:${index + 1}`,
            name: `Episode ${index + 1}`,
            season,
            number: index + 1,
            released: "2022-10-11T00:00:00.000Z"
        })));
    const http = {
        async get(url: string) {
            requests.push(url);
            return {
                statusCode: 200,
                text: "",
                data: { meta: { id: "tt14986406", type: "series", name, videos } }
            };
        },
        async post(url: string) {
            requests.push(url);
            // AniList answering nothing is the outage this module has to survive.
            return { statusCode: 200, text: "", data: { data: { Page: { media: [] } } } };
        }
    };
    const store = new Map<string, unknown>();
    const preferences = {
        get(key: string) { return store.get(key); },
        set(key: string, value: unknown) { store.set(key, value); },
        sync() {}
    };
    return {
        requests,
        client: createAnimeChainClient(http as never, preferences as never)
    };
}

function cour(overrides: Partial<WatchedCour> & { malId: string }): WatchedCour {
    return {
        imdbId: "tt14986406",
        name: "Bleach",
        year: "2022",
        ownership: "other",
        simklId: "",
        episodes: [],
        lastWatchedAt: "",
        ...overrides
    };
}

test("the newest paused checkpoint wins, whichever cour it sits in", async () => {
    // Comparing coordinates let a session abandoned in a later cour outrank the one actually
    // paused last, which is the opposite of the cross-device rule.
    const { client } = stubs([{ season: 1, count: 13 }, { season: 2, count: 13 }]);
    const chain = {
        imdbId: "tt14986406",
        entries: [{ malId: "41467", episodes: 13 }, { malId: "56784", episodes: 13 }]
    };

    const placed = await client.placeWatchedCours(
        [
            cour({
                malId: "56784",
                ownership: "other",
                paused: { episode: 1, at: "2026-01-05T00:00:00Z", progress: 10 }
            }),
            cour({
                malId: "41467",
                ownership: "owner",
                paused: { episode: 2, at: "2026-02-05T00:00:00Z", progress: 30 }
            })
        ],
        [],
        [chain]
    );

    const unfinished = placed.entries.filter((entry) => !entry.watched);
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0].episode?.season).toBe(1);
    expect(unfinished[0].episode?.episode).toBe(2);
    expect(unfinished[0].progress).toBe(30);
});

test("a device with no history does not drop a later cour into season one", async () => {
    // The relation chain opens with material Cinemeta gives no season, so it cannot be laid
    // against the seasons; without a verified chain the cour is left out rather than placed.
    const { client } = stubs([{ season: 1, count: 24 }]);
    const misaligned = {
        imdbId: "tt14986406",
        entries: [{ malId: "40001", episodes: 5 }, { malId: "56784", episodes: 12 }]
    };

    const placed = await client.placeWatchedCours(
        [cour({ malId: "56784", ownership: "other", episodes: [6], lastWatchedAt: "2026-02-01T00:00:00Z" })],
        [],
        [misaligned]
    );

    expect(placed.patches).toEqual([]);
    expect(placed.entries).toEqual([]);
});

test("an unverified cour is never read as owning the id it is filed under", async () => {
    // A failed ownership lookup used to leave the cour trusted, which authorised exactly the
    // direct placement this rejects.
    const { client } = stubs([{ season: 1, count: 13 }]);
    const unverified = cour({
        malId: "56784",
        ownership: "unknown",
        episodes: [6],
        lastWatchedAt: "2026-02-01T00:00:00Z"
    });

    expect(await client.placeWatchedCours([unverified], [], []))
        .toEqual({ patches: [], entries: [] });

    // Confirmed ownership is what makes the cour's own numbering readable as season one.
    const { client: owned } = stubs([{ season: 1, count: 13 }]);
    const placed = await owned.placeWatchedCours(
        [{ ...unverified, ownership: "owner" }],
        [],
        []
    );
    expect(placed.patches).toEqual([{ id: "tt14986406", episodes: ["1:6"] }]);
});

test("the series metadata names the show when a relation chain carries no title", async () => {
    // A candidate built from a Simkl relation alone has an empty name, and searching AniList
    // for "" answers nothing, so the title has to come from Cinemeta.
    const { requests, client } = stubs([{ season: 1, count: 24 }], "Tensei Shitara Slime Datta Ken");
    const misaligned = {
        imdbId: "tt14986406",
        entries: [{ malId: "40001", episodes: 5 }, { malId: "56784", episodes: 12 }]
    };

    await client.placeWatchedCours(
        [cour({ malId: "56784", ownership: "other", episodes: [6] })],
        [],
        [misaligned]
    );

    expect(requests.some((url) => url.includes("graphql.anilist.co"))).toBe(true);
});

test("anime carrying only a MAL id is uploaded without IMDb metadata", async () => {
    // Stremio normalization deliberately accepts provider media with a `mal_id` and no IMDb id;
    // the upload mapping rejected it before the id was ever looked at.
    const { requests, client } = stubs([{ season: 1, count: 13 }]);
    const media: Media = {
        id: "kitsu:7442",
        imdbId: "",
        type: "series",
        name: "Bleach",
        releaseInfo: "2022",
        poster: "",
        malId: "56784"
    };

    expect(await client.uploadEpisodes(media, [{ season: 1, episode: 6 }])).toEqual([
        { malId: "56784", title: "Bleach", season: 1, episode: 6 }
    ]);
    // Nothing had to be looked up to know where it goes.
    expect(requests).toEqual([]);

    // Without either id there is still nothing to address.
    expect(await client.uploadEpisodes({ ...media, malId: "" }, [{ season: 1, episode: 6 }]))
        .toEqual([]);
});

test("a chain rooted at the series a cour continues does not claim the show", () => {
    // Simkl roots Bleach's Thousand-Year Blood War cours at the 2004 series they continue, so
    // the chain carries tt0434665. Reading that as the show handed every cour to a title this
    // device has never played: the cours were then left out of the candidate scan that would
    // have found the real one, failed to line up against the 2004 seasons, and stopped being
    // placed at all - the episodes watched in the newest cours never got a mark.
    const client = multiStubs({
        tt14986406: { name: "Bleach: Thousand-Year Blood War", seasons: [
            { season: 1, count: 13 }, { season: 2, count: 13 },
            { season: 3, count: 14 }, { season: 4, count: 10 }
        ] },
        tt0434665: { name: "Bleach", seasons: [{ season: 1, count: 20 }, { season: 2, count: 22 }] }
    }, {
        // What a device that has placed this franchise before already holds.
        "Bleach: Thousand-Year Blood War": [
            { anilistId: 1, malId: "41467", episodes: 13 },
            { anilistId: 2, malId: "53998", episodes: 13 },
            { anilistId: 3, malId: "56784", episodes: 14 },
            { anilistId: 4, malId: "60636", episodes: 10 }
        ]
    });
    const history = [{
        id: "tt14986406:1:1",
        media: {
            id: "tt14986406",
            imdbId: "tt14986406",
            type: "series" as const,
            name: "Bleach: Thousand-Year Blood War",
            releaseInfo: "2022",
            poster: ""
        },
        episode: {
            id: "tt14986406:1:1", name: "E1", season: 1, episode: 1,
            aired: "2022-10-11", description: "", thumbnail: ""
        },
        lastPlayedAt: "2026-09-01T00:00:00Z",
        watched: true,
        progress: 100
    }];
    const chain = {
        imdbId: "tt0434665",
        entries: [
            { malId: "41467", episodes: 13 },
            { malId: "53998", episodes: 13 },
            { malId: "56784", episodes: 14 },
            { malId: "60636", episodes: 10 }
        ]
    };

    return client.placeWatchedCours(
        [
            cour({ malId: "56784", imdbId: "tt0434665", episodes: [12, 13, 14], lastWatchedAt: "2026-09-13T00:00:00Z" }),
            cour({ malId: "60636", imdbId: "tt0434665", episodes: [1, 2], lastWatchedAt: "2026-09-14T00:00:00Z" })
        ],
        history,
        [chain]
    ).then((placed) => {
        expect(placed.patches).toEqual([
            { id: "tt14986406", episodes: ["3:12", "3:13", "3:14", "4:1", "4:2"] }
        ]);
        expect(placed.entries.map((entry) => entry.id)).toEqual(["tt14986406:4:2"]);
    });
});

test("a paused session for an episode the pass marks watched is not offered as unfinished", async () => {
    // Simkl keeps reporting a session this device left behind months ago. Once the episode is
    // watched, that checkpoint is nobody's resume point, and offering it painted a half-finished
    // progress bar across an episode that was done.
    const client = multiStubs({
        tt14986406: { name: "Bleach", seasons: [{ season: 1, count: 14 }] }
    });

    const placed = await client.placeWatchedCours(
        [cour({
            malId: "56784",
            ownership: "owner",
            episodes: [10, 11, 12],
            lastWatchedAt: "2026-09-13T00:00:00Z",
            paused: { episode: 12, at: "2026-09-05T16:10:52Z", progress: 41.18 }
        })],
        [],
        []
    );

    expect(placed.patches).toEqual([{ id: "tt14986406", episodes: ["1:10", "1:11", "1:12"] }]);
    expect(placed.entries.map((entry) => [entry.id, entry.watched])).toEqual([["tt14986406:1:12", true]]);

    // A session on an episode nothing marks watched is still the place to resume.
    const unfinished = await client.placeWatchedCours(
        [cour({
            malId: "56784",
            ownership: "owner",
            episodes: [10, 11],
            lastWatchedAt: "2026-09-13T00:00:00Z",
            paused: { episode: 12, at: "2026-09-14T00:00:00Z", progress: 41.18 }
        })],
        [],
        []
    );
    expect(unfinished.entries.map((entry) => [entry.id, entry.watched])).toContainEqual(["tt14986406:1:12", false]);
});

test("a cour whose show Cinemeta has never heard of is left unplaced", async () => {
    // Inventing a show from the cour itself produced a title with no poster and no episode list.
    // It reached the sidebar as a blank card that could name nothing to play, and no later sync
    // could take it back.
    const client = multiStubs({ tt14986406: { name: "Bleach", seasons: [{ season: 1, count: 13 }] } });

    const placed = await client.placeWatchedCours(
        [cour({
            malId: "61316",
            imdbId: "tt36501927",
            name: "Re:Zero kara Hajimeru Isekai Seikatsu",
            ownership: "owner",
            episodes: [14, 16],
            lastWatchedAt: "2026-09-16T18:55:54Z"
        })],
        [],
        []
    );

    expect(placed).toEqual({ patches: [], entries: [] });
});
