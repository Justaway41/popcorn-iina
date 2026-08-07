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
    parseSkipSegments,
    parsePlayableStreams,
    parseSeriesEpisodes,
    sortEpisodes,
    sortStreamsBySize,
    sortStreamsForPlayback,
    groupStreamsByResolution,
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
            resolution: "2160p",
            source: "",
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
            resolution: "1080p",
            source: "",
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
            resolution: "",
            source: "",
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

test("extracts numeric resolution from an addon stream title", () => {
    expect(parsePlayableStreams({
        streams: [{ title: "Release.Name.1440p.WEB", url: "https://cdn.example/1440.mkv" }]
    })[0]?.resolution).toBe("1440p");
});

test("sorts by parsed file size only and keeps unknown sizes last", () => {
    const streams = [
        { title: "900 MB", size: "900 MB", resolution: "2160p" },
        { title: "Unknown", size: "", resolution: "1080p" },
        { title: "12 GB first", size: "12 GB", resolution: "720p" },
        { title: "12 GB second", size: "12.0 GB", resolution: "2160p" }
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
        { title: "720", resolution: "720p" },
        { title: "1080 first", resolution: "1080p" },
        { title: "1080 second", resolution: "1080p" },
        { title: "4K", resolution: "2160p" },
        { title: "Unknown", resolution: "" }
    ];
    expect(findClosestQualityStream(streams, "1440p")?.title).toBe("1080 first");
    expect(findClosestQualityStream(streams, "900p")?.title).toBe("1080 first");
    expect(findClosestQualityStream(streams, "")?.title).toBe("4K");
    expect(findClosestQualityStream([{ title: "Unknown", resolution: "" }], "1080p")).toBeNull();
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

test("keeps segment lookups on unless they were explicitly turned off", () => {
    expect(parseSkipSegments(false)).toBe(false);
    expect(parseSkipSegments(true)).toBe(true);
    // an install predating the setting stores nothing and must still get the feature
    expect(parseSkipSegments(undefined)).toBe(true);
    expect(parseSkipSegments(null)).toBe(true);
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

test("keeps a decorative emoji from inverting an explicit cache statement", () => {
    // A resolution label such as "🚀 FHD" used to match the cached marker set while the
    // cache line said "❌ Not Ready", leaving the stream permanently unknown.
    expect(parsePlayableStreams({
        streams: [{
            name: "🚀 FHD",
            description: "🎬 Dark 🍂 S03 🎞️ E04\n❌ Not Ready (TB) 🔍Comet",
            url: "https://cdn.example/fhd.mkv",
            behaviorHints: { filename: "Dark.S03E04.1080p.WEB-DL.x265.mkv" }
        }]
    })[0]?.cached).toBe(false);

    expect(parsePlayableStreams({
        streams: [{
            name: "🔥4K UHD",
            description: "⚡Ready (TB) 🔍Comet",
            url: "https://cdn.example/uhd.mkv",
            behaviorHints: { filename: "Dark.S03E04.2160p.WEB-DL.x265.mkv" }
        }]
    })[0]?.cached).toBe(true);
});

test("separates resolution from release source", () => {
    const [sourceOnly, both, labelled] = parsePlayableStreams({
        streams: [
            {
                name: "💩 Unknown",
                url: "https://cdn.example/a.mkv",
                behaviorHints: { filename: "Dark.S03E04.WEBRip.KvK.CasStudio.avi" }
            },
            {
                name: "🔥4K UHD",
                url: "https://cdn.example/b.mkv",
                behaviorHints: { filename: "Dark.S03E04.2160p.NF.WEB-DL.DDP5.1.H.265-XEBEC.mkv" }
            },
            { name: "🚀 FHD", title: "Dark S03E04", url: "https://cdn.example/c.mkv" }
        ]
    });

    // A source token must never occupy the resolution slot.
    expect(sourceOnly).toMatchObject({ resolution: "", source: "WEBRip" });
    expect(both).toMatchObject({ resolution: "2160p", source: "WEB-DL" });
    // No literal token anywhere, so the standard abbreviation is the last resort.
    expect(labelled).toMatchObject({ resolution: "1080p" });
});

test("normalizes 4K to 2160p so one tier is not split across two spellings", () => {
    expect(parsePlayableStreams({
        streams: [{ title: "Release.4K.WEB-DL", url: "https://cdn.example/4k.mkv" }]
    })[0]?.resolution).toBe("2160p");
});

test("keeps streams visible to next-episode matching when only the title names a source", () => {
    // Previously `quality` held "WEBRip" for these, qualityHeight() returned null, and
    // findClosestQualityStream dropped every one of them - so no next episode was offered.
    const streams = parsePlayableStreams({
        streams: [
            {
                url: "https://cdn.example/a.mkv",
                behaviorHints: { filename: "Dark.S03E04.1080p.WEBRip.x264-ION10.mkv" }
            },
            {
                url: "https://cdn.example/b.mkv",
                behaviorHints: { filename: "Dark.S03E04.2160p.WEBRip.DV.HDR10.mkv" }
            }
        ]
    });
    expect(findClosestQualityStream(streams, "1080p")?.resolution).toBe("1080p");
});

test("strips release-site tags but keeps plain group tags", () => {
    const [cjkBracket, domain, group] = parsePlayableStreams({
        streams: [
            { title: "【高清剧集网 www BTHDTV com】Dark S03E04", url: "https://cdn.example/a.mkv" },
            { title: "[47BT][暗黑 第三季]Dark S03E04 1080p", url: "https://cdn.example/b.mkv" },
            { title: "[SubsPlease] Anime Title - 13", url: "https://cdn.example/c.mkv" }
        ]
    });
    expect(cjkBracket.title).toBe("Dark · S03E04");
    // Only the bracket carrying a site marker is removed. A bare tag like [47BT] is
    // indistinguishable from a group tag, so it is left alone rather than guessed at.
    expect(domain.title).not.toContain("暗黑");
    expect(domain.title).toContain("[47BT]");
    expect(group.title).toContain("[SubsPlease]");
});

test("orders cached streams first while keeping the size preference inside each group", () => {
    const streams = [
        { title: "uncached big", size: "40 GB", cached: false },
        { title: "cached small", size: "2 GB", cached: true },
        { title: "unknown mid", size: "10 GB", cached: null },
        { title: "cached big", size: "20 GB", cached: true }
    ];

    expect(sortStreamsForPlayback(streams, "largest").map(({ title }) => title)).toEqual([
        "cached big", "cached small", "unknown mid", "uncached big"
    ]);
    expect(sortStreamsForPlayback(streams, "smallest").map(({ title }) => title)).toEqual([
        "cached small", "cached big", "unknown mid", "uncached big"
    ]);
    expect(streams.map(({ title }) => title)).toEqual([
        "uncached big", "cached small", "unknown mid", "cached big"
    ]);
});

test("groups streams into resolution tiers with unknown resolutions last", () => {
    expect(groupStreamsByResolution([
        { title: "a", resolution: "1080p" },
        { title: "b", resolution: "" },
        { title: "c", resolution: "2160p" },
        { title: "d", resolution: "1080p" },
        { title: "e", resolution: "720p" }
    ]).map(({ resolution, streams }) => [resolution, streams.length])).toEqual([
        ["2160p", 1], ["1080p", 2], ["720p", 1], ["other", 1]
    ]);
});
