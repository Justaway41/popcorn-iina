import { expect, test } from "bun:test";
import { parseWatchHistory } from "./history";
import type { PlaybackContext } from "./messages";
import {
    buildScrobblePayload,
    mergeWatchHistory,
    parseTraktHistory,
    parseTraktState
} from "./trakt";

const movie = {
    id: "tt123",
    imdbId: "tt123",
    type: "movie" as const,
    name: "Movie",
    releaseInfo: "2026",
    poster: ""
};

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
