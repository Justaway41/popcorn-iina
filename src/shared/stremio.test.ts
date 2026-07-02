import { describe, expect, test } from "bun:test";

import {
    buildCinemetaSearchUrl,
    buildStremioStreamUrl,
    findNextEpisode,
    normalizeAddonManifestUrl,
    parseMediaResponse,
    parsePlayableStreams,
    parseSeriesEpisodes
} from "./stremio";

describe("normalizeAddonManifestUrl", () => {
    test("normalizes web and Stremio manifest URLs", () => {
        expect(normalizeAddonManifestUrl(" https://addon.example/config/manifest.json ")).toBe(
            "https://addon.example/config"
        );
        expect(normalizeAddonManifestUrl("stremio://addon.example/config/manifest.json")).toBe(
            "https://addon.example/config"
        );
        expect(normalizeAddonManifestUrl("http://localhost:7000/manifest.json")).toBe(
            "http://localhost:7000"
        );
    });

    test("rejects unsupported schemes", () => {
        expect(() => normalizeAddonManifestUrl("file:///tmp/manifest.json")).toThrow(
            "Addon URL must start with http://, https://, or stremio://"
        );
    });
});

test("builds encoded Cinemeta and addon endpoints", () => {
    expect(buildCinemetaSearchUrl("movie", "Alien & Aliens")).toBe(
        "https://v3-cinemeta.strem.io/catalog/movie/all/search=Alien%20%26%20Aliens.json"
    );
    expect(buildStremioStreamUrl("https://addon.example", "series", "tt123:1:2")).toBe(
        "https://addon.example/stream/series/tt123%3A1%3A2.json"
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
            { title: "4K WEB\n💾 12 GB", url: "https://cdn.example/movie.mkv" },
            { name: "LAN", url: "http://192.168.1.2/movie.mp4" },
            { title: "Torrent", infoHash: "abc" },
            { title: "Unsafe", url: "file:///tmp/movie.mkv" }
        ]
    })).toEqual([
        { title: "4K WEB\n💾 12 GB", url: "https://cdn.example/movie.mkv", quality: "4K", size: "12 GB" },
        { title: "LAN", url: "http://192.168.1.2/movie.mp4", quality: "", size: "" }
    ]);
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
