import { expect, test } from "bun:test";

import {
    buildCinemetaPosterUrl,
    buildCinemetaSearchUrl,
    buildOpenSubtitlesUrl,
    buildStremioStreamUrl,
    findNextEpisode,
    isEpisodeAvailable,
    parseEnglishSubtitleAvailability,
    parseMediaResponse,
    parseEpisodeOrder,
    parseMediaTypePreference,
    parsePlayableStreams,
    parseSeriesEpisodes,
    sortEpisodes
} from "./stremio";

test("builds a lazy poster fallback for an IMDb item", () => {
    expect(buildCinemetaPosterUrl("tt123")).toBe(
        "https://images.metahub.space/poster/medium/tt123/img"
    );
});

test("builds encoded Cinemeta and addon endpoints", () => {
    expect(buildCinemetaSearchUrl("movie", "Alien & Aliens")).toBe(
        "https://v3-cinemeta.strem.io/catalog/movie/all/search=Alien%20%26%20Aliens.json"
    );
    expect(buildStremioStreamUrl("https://addon.example", "series", "tt123:1:2")).toBe(
        "https://addon.example/stream/series/tt123%3A1%3A2.json"
    );
    expect(buildOpenSubtitlesUrl("series", "tt123:1:2")).toBe(
        "https://opensubtitles-v3.strem.io/subtitles/series/tt123%3A1%3A2.json"
    );
});

test("parses media and episode responses defensively", () => {
    expect(parseMediaResponse({ metas: [{ id: "tt1", type: "movie", name: "One" }, null] })).toEqual([
        { id: "tt1", imdbId: "tt1", type: "movie", name: "One", releaseInfo: "", poster: "" }
    ]);
    expect(parseSeriesEpisodes({
        meta: {
            videos: [
                { id: "tt2:1:2", name: "Two", season: 1, number: 2, firstAired: "2025-01-02" },
                { id: "bad", name: "Bad" }
            ]
        }
    })).toEqual([
        {
            id: "tt2:1:2",
            name: "Two",
            season: 1,
            episode: 2,
            aired: "2025-01-02",
            description: "",
            thumbnail: ""
        }
    ]);
});

test("keeps only playable HTTP streams", () => {
    expect(parsePlayableStreams({
        streams: [
            { title: "4K WEB English\n💾 12 GB", url: "https://cdn.example/movie.mkv" },
            { name: "1080p MULTI", title: "Release.Group", url: "https://cdn.example/multi.mkv" },
            { name: "LAN", url: "http://192.168.1.2/movie.mp4" },
            { title: "Torrent", infoHash: "abc" },
            { title: "Unsafe", url: "file:///tmp/movie.mkv" }
        ]
    })).toEqual([
        {
            title: "4K WEB English\n💾 12 GB",
            url: "https://cdn.example/movie.mkv",
            quality: "4K",
            size: "12 GB",
            audioLanguages: ["English"],
            subtitleLanguages: null
        },
        {
            title: "Release.Group",
            url: "https://cdn.example/multi.mkv",
            quality: "1080p",
            size: "",
            audioLanguages: ["Multi"],
            subtitleLanguages: null
        },
        {
            title: "LAN",
            url: "http://192.168.1.2/movie.mp4",
            quality: "",
            size: "",
            audioLanguages: [],
            subtitleLanguages: null
        }
    ]);
});

test("parses multiple audio languages without treating subtitle labels as audio", () => {
    expect(parsePlayableStreams({
        streams: [
            {
                name: "1080p Dual Audio English Hindi",
                url: "https://cdn.example/dual.mkv",
                subtitles: [{ lang: "eng", url: "https://subs.example/en.srt" }, { lang: "spa" }]
            },
            {
                title: "ENG Subs Japanese Audio",
                url: "https://cdn.example/japanese.mkv",
                subtitles: []
            }
        ]
    })).toMatchObject([
        {
            audioLanguages: ["English", "Hindi"],
            subtitleLanguages: ["English", "Spanish"]
        },
        {
            audioLanguages: ["Japanese"],
            subtitleLanguages: []
        }
    ]);
});

test("detects English subtitles in subtitle addon responses", () => {
    expect(parseEnglishSubtitleAvailability({ subtitles: [{ lang: "spa" }, { lang: "eng" }] })).toBe(true);
    expect(parseEnglishSubtitleAvailability({ subtitles: [{ lang: "English" }] })).toBe(true);
    expect(parseEnglishSubtitleAvailability({ subtitles: [{ lang: "jpn" }] })).toBe(false);
    expect(parseEnglishSubtitleAvailability({ subtitles: "invalid" })).toBe(false);
});

test("marks only valid future episode dates unavailable", () => {
    const now = new Date("2026-07-06T12:00:00Z");
    expect(isEpisodeAvailable({ ...episode("past", 1, 1), aired: "2026-07-05T12:00:00Z" }, now)).toBe(true);
    expect(isEpisodeAvailable({ ...episode("now", 1, 2), aired: now.toISOString() }, now)).toBe(true);
    expect(isEpisodeAvailable({ ...episode("future", 1, 3), aired: "2026-07-07T12:00:00Z" }, now)).toBe(false);
    expect(isEpisodeAvailable({ ...episode("missing", 1, 4), aired: "" }, now)).toBe(true);
    expect(isEpisodeAvailable({ ...episode("invalid", 1, 5), aired: "unknown" }, now)).toBe(true);
});

test("finds the next episode across seasons", () => {
    const episodes = [
        episode("tt1:2:1", 2, 1),
        episode("tt1:1:2", 1, 2),
        episode("tt1:1:1", 1, 1)
    ];

    expect(findNextEpisode(episodes, episode("tt1:1:1", 1, 1))?.id).toBe("tt1:1:2");
    expect(findNextEpisode(episodes, episode("tt1:1:2", 1, 2))?.id).toBe("tt1:2:1");
    expect(findNextEpisode(episodes, episode("tt1:2:1", 2, 1))).toBeNull();
});

test("skips unreleased episodes when finding the next episode", () => {
    const now = new Date("2026-07-06T12:00:00Z");
    const episodes = [
        { ...episode("tt1:1:1", 1, 1), aired: "2026-07-01T12:00:00Z" },
        { ...episode("tt1:1:2", 1, 2), aired: "2026-07-10T12:00:00Z" }
    ];

    expect(findNextEpisode(episodes, episodes[0], now)).toBeNull();
});

test("restores only supported media type preferences", () => {
    expect(parseMediaTypePreference("series")).toBe("series");
    expect(parseMediaTypePreference("movie")).toBe("movie");
    expect(parseMediaTypePreference("invalid")).toBe("movie");
    expect(parseMediaTypePreference(null)).toBe("movie");
});

test("restores only supported episode order preferences", () => {
    expect(parseEpisodeOrder("newest")).toBe("newest");
    expect(parseEpisodeOrder("oldest")).toBe("oldest");
    expect(parseEpisodeOrder("unwatched")).toBe("oldest");
    expect(parseEpisodeOrder(null)).toBe("oldest");
});

test("sorts episodes serially in either direction", () => {
    const values = [
        episode("s2e1", 2, 1),
        episode("s1e2", 1, 2),
        episode("s1e1", 1, 1)
    ];
    expect(sortEpisodes(values, "oldest").map((item) => item.id))
        .toEqual(["s1e1", "s1e2", "s2e1"]);
    expect(sortEpisodes(values, "newest").map((item) => item.id))
        .toEqual(["s2e1", "s1e2", "s1e1"]);
    expect(values.map((item) => item.id)).toEqual(["s2e1", "s1e2", "s1e1"]);
});

function episode(id: string, season: number, episodeNumber: number) {
    return {
        id,
        name: id,
        season,
        episode: episodeNumber,
        aired: "",
        description: "",
        thumbnail: ""
    };
}
