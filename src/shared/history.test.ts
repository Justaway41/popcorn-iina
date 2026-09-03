import { expect, test } from "bun:test";

import type { PlaybackContext } from "./messages";

import {
    applySimklWatchedPatches,
    clearSimklWatched,
    getHistoryEntry,
    getResumePercent,
    isEpisodeWatched,
    latestPerTitle,
    markEpisodeWatched,
    parseEpisodeWatchState,
    parseWatchHistory,
    recordPlayback,
    removeHistoryEntry
} from "./history";

const movie = {
    id: "tt1",
    imdbId: "tt1",
    type: "movie" as const,
    name: "Movie",
    releaseInfo: "2026",
    poster: "poster.jpg"
};

test("parses stored history defensively", () => {
    expect(parseWatchHistory("not json")).toEqual([]);
    expect(parseWatchHistory(JSON.stringify([null, { id: "bad" }]))).toEqual([]);

    const entry = {
        id: "tt1",
        media: movie,
        lastPlayedAt: "2026-07-06T12:00:00.000Z",
        watched: false,
        progress: 5
    };
    expect(parseWatchHistory(JSON.stringify([entry]))).toEqual([entry]);
});

test("records at 5 percent and marks watched at 90 percent", () => {
    const context: PlaybackContext = { media: movie, episodes: [] };
    expect(recordPlayback([], context, 4.9, "early")).toEqual([]);

    const recent = recordPlayback([], context, 5, "first");
    expect(recent).toEqual([{
        id: "tt1",
        media: movie,
        lastPlayedAt: "first",
        watched: false,
        progress: 5
    }]);

    expect(recordPlayback(recent, context, 90, "finished")).toEqual([{
        id: "tt1",
        media: movie,
        lastPlayedAt: "finished",
        watched: true,
        progress: 90
    }]);
});

test("deduplicates, reorders, preserves watched state, and caps at 100", () => {
    const oldMovie = { ...movie, imdbId: "old", id: "old", name: "Old" };
    const watched = recordPlayback([], { media: movie, episodes: [] }, 100, "old-time");
    const withOlderItem = recordPlayback(watched, { media: oldMovie, episodes: [] }, 5, "newer-time");
    const replayed = recordPlayback(withOlderItem, { media: movie, episodes: [] }, 5, "latest-time");

    expect(replayed.map((item) => item.id)).toEqual(["tt1", "old"]);
    expect(replayed[0].watched).toBe(true);
    expect(replayed[0].lastPlayedAt).toBe("latest-time");

    let history = replayed;
    for (let index = 0; index < 105; index += 1) {
        const media = { ...movie, id: `tt${index + 10}`, imdbId: `tt${index + 10}` };
        history = recordPlayback(history, { media, episodes: [] }, 5, String(index));
    }
    expect(history).toHaveLength(100);
});

test("uses episode id and metadata for series history", () => {
    const media = { ...movie, id: "series", imdbId: "series", type: "series" as const, name: "Series" };
    const episode = {
        id: "series:1:2",
        name: "Episode",
        season: 1,
        episode: 2,
        aired: "2026-01-01",
        description: "",
        thumbnail: ""
    };
    const result = recordPlayback([], { media, episode, episodes: [episode] }, 5, "now");
    expect(result[0]).toMatchObject({ id: episode.id, media, episode, watched: false });
});

test("starting a newer local episode retires the older unfinished episode", () => {
    const first = episode(1, 1);
    const second = episode(1, 2);
    const older = recordPlayback([], { media: show, episode: first, episodes: [first, second] }, 40, "old");
    const watched = recordPlayback(older, { media: show, episode: first, episodes: [first, second] }, 90, "done");
    const withOldPause = [
        ...watched,
        { ...watched[0], id: "tt9:1:0", episode: episode(1, 0), watched: false, progress: 40 }
    ];

    expect(recordPlayback(
        withOldPause,
        { media: show, episode: second, episodes: [first, second] },
        10,
        "new"
    ).map(({ id }) => id)).toEqual([second.id, first.id]);
});

test("stores exact progress and keeps watched state sticky", () => {
    const context: PlaybackContext = { media: movie, episodes: [] };
    const partial = recordPlayback([], context, 42.25, "partial");
    expect(partial[0]).toMatchObject({ progress: 42.25, watched: false });

    const watched = recordPlayback(partial, context, 95, "watched");
    const replayed = recordPlayback(watched, context, 12, "replayed");
    expect(replayed[0]).toMatchObject({
        progress: 12,
        watched: true,
        lastPlayedAt: "replayed"
    });
});

test("migrates legacy history without inventing unfinished progress", () => {
    const partial = {
        id: "tt1",
        media: movie,
        lastPlayedAt: "partial",
        watched: false
    };
    const watched = { ...partial, lastPlayedAt: "watched", watched: true };

    expect(parseWatchHistory([partial])[0].progress).toBeNull();
    expect(parseWatchHistory([watched])[0].progress).toBe(100);
});

test("finds movie and episode history by playback context", () => {
    const context: PlaybackContext = { media: movie, episodes: [] };
    const entries = recordPlayback([], context, 35, "now");
    expect(getHistoryEntry(entries, context)?.progress).toBe(35);
});

test("tracks provider-only movies locally by provider ID", () => {
    const providerMovie = {
        ...movie,
        id: "kitsu:123",
        providerId: "kitsu:123",
        imdbId: "",
        name: "Provider Movie"
    };
    const context: PlaybackContext = { media: providerMovie, episodes: [] };
    const entries = recordPlayback([], context, 25, "now");
    expect(entries[0].id).toBe("kitsu:123");
    expect(parseWatchHistory(entries)).toEqual(entries);
    expect(getHistoryEntry(entries, context)).toEqual(entries[0]);
});

test("removes a single history entry by id", () => {
    const entries = [
        { id: "tt1", media: movie, lastPlayedAt: "a", watched: false, progress: 5 },
        { id: "tt2", media: { ...movie, id: "tt2", imdbId: "tt2" }, lastPlayedAt: "b", watched: true, progress: 100 }
    ];
    expect(removeHistoryEntry(entries, "tt1")).toEqual([entries[1]]);
    // an unknown id must not silently clear the list
    expect(removeHistoryEntry(entries, "nope")).toEqual(entries);
    // nor must a missing one, which is what an empty payload arrives as
    expect(removeHistoryEntry(entries, "")).toEqual(entries);
    expect(removeHistoryEntry([], "tt1")).toEqual([]);
});

test("resumes only unfinished meaningful progress", () => {
    expect(getResumePercent(null, false)).toBeNull();
    expect(getResumePercent(4.9, false)).toBeNull();
    expect(getResumePercent(42.5, false)).toBe(42.5);
    expect(getResumePercent(90, false)).toBeNull();
    expect(getResumePercent(42.5, true)).toBeNull();
});

const show = {
    id: "tt9",
    imdbId: "tt9",
    type: "series" as const,
    name: "Show",
    releaseInfo: "1999-",
    poster: "poster.jpg"
};

const episode = (season: number, number: number) => ({
    id: `tt9:${season}:${number}`,
    name: `Episode ${number}`,
    season,
    episode: number,
    aired: "",
    description: "",
    thumbnail: ""
});

const seriesEntries = [
    { id: "tt9:1:3", media: show, episode: episode(1, 3), lastPlayedAt: "c", watched: true, progress: 100 },
    { id: "tt9:1:2", media: show, episode: episode(1, 2), lastPlayedAt: "b", watched: true, progress: 100 },
    { id: "tt1", media: movie, lastPlayedAt: "b", watched: false, progress: 40 },
    { id: "tt9:1:1", media: show, episode: episode(1, 1), lastPlayedAt: "a", watched: true, progress: 100 }
];

test("collapses a show to the episode watched most recently", () => {
    expect(latestPerTitle(seriesEntries).map((entry) => entry.id)).toEqual(["tt9:1:3", "tt1"]);
    expect(latestPerTitle([])).toEqual([]);
});

test("removing an episode removes the whole show", () => {
    expect(removeHistoryEntry(seriesEntries, "tt9:1:3").map((entry) => entry.id)).toEqual(["tt1"]);
    // removing the collapsed card must not leave the earlier episodes behind
    expect(removeHistoryEntry(seriesEntries, "tt9:1:1").map((entry) => entry.id)).toEqual(["tt1"]);
});

test("normalizes compact episode watch state", () => {
    expect(parseEpisodeWatchState({
        local: [{ id: "tt9", episodes: ["2:3", "2:3", "bad", "-1:2"] }],
        simkl: [{ id: "tt9", episodes: ["1:2"] }, null]
    })).toEqual({
        local: [{ id: "tt9", episodes: ["2:3"] }],
        simkl: [{ id: "tt9", episodes: ["1:2"] }]
    });
    expect(parseEpisodeWatchState("not json")).toEqual({ local: [], simkl: [] });
});

test("marks local episodes once and migrates watched legacy entries", () => {
    const context: PlaybackContext = { media: show, episode: episode(2, 3), episodes: [] };
    const migrated = parseEpisodeWatchState({}, seriesEntries);
    const marked = markEpisodeWatched(migrated, context);
    expect(markEpisodeWatched(marked, context).local).toEqual([
        { id: "tt9", episodes: ["1:1", "1:2", "1:3", "2:3"] }
    ]);
});

test("replaces only the changed Simkl show and clears only Simkl state", () => {
    const state = parseEpisodeWatchState({
        local: [{ id: "tt9", episodes: ["1:1"] }],
        simkl: [
            { id: "tt9", episodes: ["1:1"] },
            { id: "tt8", episodes: ["2:2"] }
        ]
    });
    const patched = applySimklWatchedPatches(state, [{ id: "tt9", episodes: ["1:2"] }]);
    expect(patched).toEqual({
        local: [{ id: "tt9", episodes: ["1:1"] }],
        simkl: [
            { id: "tt8", episodes: ["2:2"] },
            { id: "tt9", episodes: ["1:2"] }
        ]
    });
    expect(applySimklWatchedPatches(patched, [{ id: "tt9", episodes: [] }])).toEqual({
        local: [{ id: "tt9", episodes: ["1:1"] }],
        simkl: [{ id: "tt8", episodes: ["2:2"] }]
    });
    expect(clearSimklWatched(patched)).toEqual({
        local: [{ id: "tt9", episodes: ["1:1"] }],
        simkl: []
    });
});

test("checks exact local, Simkl, and legacy episode marks", () => {
    const state = parseEpisodeWatchState({
        local: [{ id: "tt9", episodes: ["1:1"] }],
        simkl: [{ id: "tt9", episodes: ["1:3"] }]
    });
    expect(isEpisodeWatched(state, show, episode(1, 1))).toBe(true);
    expect(isEpisodeWatched(state, show, episode(1, 2), seriesEntries)).toBe(true);
    expect(isEpisodeWatched(state, show, episode(1, 3))).toBe(true);
    expect(isEpisodeWatched(state, show, episode(1, 4))).toBe(false);
});
