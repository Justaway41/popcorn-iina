import { expect, test } from "bun:test";

import type { PlaybackContext } from "./messages";

import {
    getHistoryEntry,
    getResumePercent,
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
