import { expect, test } from "bun:test";

import {
    buildCinemetaPosterUrl,
    buildCinemetaSearchUrl,
    buildStremioResourceUrl,
    buildOpenSubtitlesUrl,
    buildStremioStreamUrl,
    findNextEpisode,
    getSearchableCatalogs,
    isEpisodeAvailable,
    isCompatibleSubtitleId,
    parseEnglishSubtitleAvailability,
    parseMediaResponse,
    parseMediaMetadata,
    parseEpisodeOrder,
    parseMediaTypePreference,
    parsePlayableStreams,
    parseSeriesEpisodes,
    sortEpisodes,
    sortStreamsBySize,
    findClosestQualityStream,
    mergeMediaResults
} from "./stremio";
import { parseAddonManifest } from "./addons";

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

test("queries subtitles only for IMDb-compatible video IDs", () => {
    expect(isCompatibleSubtitleId("tt1234567")).toBe(true);
    expect(isCompatibleSubtitleId("tt1234567:1:2")).toBe(true);
    expect(isCompatibleSubtitleId("kitsu:46474")).toBe(false);
    expect(isCompatibleSubtitleId("tmdb:438631")).toBe(false);
});

test("builds catalog and metadata endpoints from configured manifests", () => {
    expect(buildStremioResourceUrl(
        "https://addon.example/config/manifest.json?token=x",
        "catalog",
        "anime",
        "kitsu-anime-list",
        { search: "Frieren & Fern" }
    )).toBe(
        "https://addon.example/config/catalog/anime/kitsu-anime-list/search=Frieren%20%26%20Fern.json?token=x"
    );
    expect(buildStremioResourceUrl(
        "https://addon.example/manifest.json",
        "meta",
        "series",
        "tmdb:123"
    )).toBe("https://addon.example/meta/series/tmdb%3A123.json");
});

test("selects movie catalogs or TV and anime catalogs that support search", () => {
    const manifest = parseAddonManifest({
        name: "Catalogs",
        resources: ["catalog"],
        catalogs: [
            { id: "movies", type: "movie", extra: [{ name: "search" }] },
            { id: "shows", type: "series", extra: [{ name: "search" }] },
            { id: "anime", type: "anime", extra: [{ name: "search" }] },
            { id: "top", type: "series" }
        ]
    });
    expect(getSearchableCatalogs(manifest, "movie").map(({ id }) => id)).toEqual(["movies"]);
    expect(getSearchableCatalogs(manifest, "series").map(({ id }) => id)).toEqual(["shows", "anime"]);
});

test("normalizes provider previews without treating provider IDs as IMDb IDs", () => {
    expect(parseMediaResponse({
        metas: [{ id: "kitsu:46474", type: "anime", name: "Frieren", releaseInfo: "2023" }]
    }, { manifestUrl: "https://anime.example/manifest.json" })).toEqual([{
        id: "kitsu:46474",
        imdbId: "",
        type: "series",
        name: "Frieren",
        releaseInfo: "2023",
        poster: "",
        sourceManifestUrl: "https://anime.example/manifest.json",
        providerId: "kitsu:46474",
        providerType: "anime",
        malId: ""
    }]);
});

test("merges providers in source order by IMDb or normalized title and year", () => {
    const cinemeta = media("tt1234567", "movie", "Dune", "2021", "tt1234567");
    const tmdbDuplicate = media("tmdb:438631", "movie", "Dune", "2021", "tt1234567");
    const kitsuDuplicate = media("kitsu:1", "series", "Frieren: Beyond Journey's End", "2023");
    const sameKitsuTitle = media("kitsu:2", "series", " frieren beyond journey’s end ", "2023");
    expect(mergeMediaResults([[cinemeta], [tmdbDuplicate, kitsuDuplicate], [sameKitsuTitle]]))
        .toEqual([cinemeta, kitsuDuplicate]);
});

test("normalizes Kitsu metadata and canonical IMDb episode IDs", () => {
    const preview = media("kitsu:46474", "series", "Frieren", "2023");
    const result = parseMediaMetadata({
        meta: {
            id: "kitsu:46474",
            type: "anime",
            name: "Frieren",
            imdb_id: "tt22248376",
            mal_id: 52991,
            videos: [{
                id: "kitsu:46474:1",
                title: "The Journey's End",
                season: 1,
                number: 1,
                imdb_id: "tt22248376",
                imdbSeason: 1,
                imdbEpisode: 1
            }]
        }
    }, { manifestUrl: "https://anime.example/manifest.json" }, preview);
    expect(result.media).toMatchObject({
        imdbId: "tt22248376",
        providerId: "kitsu:46474",
        providerType: "anime",
        malId: "52991"
    });
    expect(result.episodes[0]).toMatchObject({ id: "tt22248376:1:1", season: 1, episode: 1 });
});

test("parses media and episode responses defensively", () => {
    expect(parseMediaResponse({ metas: [{ id: "tt12345", type: "movie", name: "One" }, null] })).toEqual([
        {
            id: "tt12345",
            imdbId: "tt12345",
            type: "movie",
            name: "One",
            releaseInfo: "",
            poster: "",
            sourceManifestUrl: "https://v3-cinemeta.strem.io/manifest.json",
            providerId: "tt12345",
            providerType: "movie",
            malId: ""
        }
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

test("parses current Cinemeta episode field names", () => {
    expect(parseSeriesEpisodes({
        meta: {
            videos: [{
                id: "tt40856520:1:1",
                title: "Illiterate Goldy",
                season: 1,
                number: 1,
                released: "2026-07-24T00:00:00.000Z",
                overview: "The students do not attend school.",
                thumbnail: "https://episodes.metahub.space/episode.jpg"
            }]
        }
    })).toEqual([{
        id: "tt40856520:1:1",
        name: "Illiterate Goldy",
        season: 1,
        episode: 1,
        aired: "2026-07-24T00:00:00.000Z",
        description: "The students do not attend school.",
        thumbnail: "https://episodes.metahub.space/episode.jpg"
    }]);
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
            title: "WEB English",
            rawTitle: "4K WEB English\n💾 12 GB",
            url: "https://cdn.example/movie.mkv",
            quality: "4K",
            size: "12 GB",
            audioLanguages: ["English"],
            subtitleLanguages: null,
            cached: null,
            seeders: null
        },
        {
            title: "Release Group",
            rawTitle: "Release.Group",
            url: "https://cdn.example/multi.mkv",
            quality: "1080p",
            size: "",
            audioLanguages: ["Multi"],
            subtitleLanguages: null,
            cached: null,
            seeders: null
        },
        {
            title: "LAN",
            rawTitle: "LAN",
            url: "http://192.168.1.2/movie.mp4",
            quality: "",
            size: "",
            audioLanguages: [],
            subtitleLanguages: null,
            cached: null,
            seeders: null
        }
    ]);
});

test("normalizes AIOStreams and Comet display metadata conservatively", () => {
    expect(parsePlayableStreams({
        streams: [
            {
                name: "[TB+] AIOStreams 2160p",
                description: "🎬 Dark 🐒 S03 🎞 E03 🎥 WEBRip",
                url: "https://cdn.example/dark.mkv",
                behaviorHints: {
                    filename: "Dark.S03E03.2160p.WEBRip.H.265.mkv",
                    videoSize: 65_928_328_806
                },
                streamData: { service: { cached: true }, torrent: { seeders: 42 } }
            },
            {
                name: "[torbox⬇️] Comet 1080p",
                description: "📄 Dark.S03E03.1080p.WEB-DL\n👤 0",
                url: "https://cdn.example/comet.mkv",
                behaviorHints: { filename: "Dark.S03E03.1080p.WEB-DL.x264.mkv" }
            },
            {
                name: "[TB+] AIOStreams",
                description: "⏳ Dark.S03E03",
                url: "https://cdn.example/conflict.mkv"
            },
            {
                description: "🎬 Dark 🐒 S03 🎞 E03 🎥 WEBRip",
                url: "https://cdn.example/unknown.mkv"
            }
        ]
    })).toMatchObject([
        {
            title: "Dark · S03E03 · WEBRip · H.265",
            rawTitle: "Dark.S03E03.2160p.WEBRip.H.265.mkv",
            size: "61.4 GB",
            cached: true,
            seeders: 42
        },
        {
            title: "Dark · S03E03 · WEB-DL · x264",
            rawTitle: "Dark.S03E03.1080p.WEB-DL.x264.mkv",
            cached: false,
            seeders: 0
        },
        {
            title: "Dark · S03E03",
            rawTitle: "⏳ Dark.S03E03",
            cached: null,
            seeders: null
        },
        {
            title: "Dark · S03E03 · WEBRip",
            rawTitle: "🎬 Dark 🐒 S03 🎞 E03 🎥 WEBRip",
            cached: null,
            seeders: null
        }
    ]);
});

test("extracts numeric quality from an addon stream title", () => {
    expect(parsePlayableStreams({
        streams: [{ title: "Release.Name.1440p.WEB", url: "https://cdn.example/1440.mkv" }]
    })[0]?.quality).toBe("1440p");
});

test("sorts by parsed file size only and keeps unknown sizes last", () => {
    const streams = [
        { title: "900 MB", size: "900 MB", quality: "4K" },
        { title: "Unknown", size: "", quality: "1080p" },
        { title: "12 GB first", size: "12 GB", quality: "720p" },
        { title: "12 GB second", size: "12.0 GB", quality: "4K" }
    ];

    expect(sortStreamsBySize(streams, "largest").map(({ title }) => title)).toEqual([
        "12 GB first", "12 GB second", "900 MB", "Unknown"
    ]);
    expect(sortStreamsBySize(streams, "smallest").map(({ title }) => title)).toEqual([
        "900 MB", "12 GB first", "12 GB second", "Unknown"
    ]);
    expect(streams.map(({ title }) => title)).toEqual([
        "900 MB", "Unknown", "12 GB first", "12 GB second"
    ]);
});

test("recommends the closest resolution with higher quality winning ties", () => {
    const streams = [
        { title: "720", quality: "720p" },
        { title: "1080 first", quality: "1080p" },
        { title: "1080 second", quality: "1080p" },
        { title: "4K", quality: "4K" },
        { title: "Unknown", quality: "" }
    ];
    expect(findClosestQualityStream(streams, "1440p")?.title).toBe("1080 first");
    expect(findClosestQualityStream(streams, "900p")?.title).toBe("1080 first");
    expect(findClosestQualityStream(streams, "")?.title).toBe("4K");
    expect(findClosestQualityStream([{ title: "Unknown", quality: "" }], "1080p")).toBeNull();
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

function media(id: string, type: "movie" | "series", name: string, releaseInfo: string, imdbId = "") {
    return {
        id,
        imdbId,
        type,
        name,
        releaseInfo,
        poster: "",
        sourceManifestUrl: "https://source.example/manifest.json",
        providerId: id,
        providerType: type,
        malId: ""
    };
}
