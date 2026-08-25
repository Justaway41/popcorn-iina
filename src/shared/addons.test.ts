import { expect, test } from "bun:test";

import {
    canonicalizeManifestUrl,
    getAddonHostname,
    loadEnabledAddonStreams,
    loadAddonStreams,
    parseAddonManifest,
    parseAddons
} from "./addons";
import { buildStremioStreamUrl, type PlayableStream } from "./stremio";

function stream(overrides: Partial<PlayableStream> = {}): PlayableStream {
    return {
        title: "Title",
        rawTitle: "Title",
        url: "https://example.example/video",
        resolution: "",
        source: "",
        size: "",
        audioLanguages: [],
        subtitleLanguages: null,
        cached: null,
        seeders: null,
        ...overrides
    };
}

test("canonicalizes manifest URLs and preserves configuration queries", () => {
    expect(canonicalizeManifestUrl("stremio://addon.example/config?token=x")).toBe(
        "https://addon.example/config/manifest.json?token=x"
    );
    expect(canonicalizeManifestUrl(" https://addon.example/manifest.json/ ")).toBe(
        "https://addon.example/manifest.json"
    );
    expect(getAddonHostname("https://secret@addon.example:7000/config/manifest.json?token=x")).toBe(
        "addon.example"
    );
    expect(buildStremioStreamUrl(
        "https://addon.example/config/manifest.json?token=x",
        "series",
        "tt1:1:2"
    )).toBe("https://addon.example/config/stream/series/tt1%3A1%3A2.json?token=x");
});

test("rejects unsupported manifest URLs", () => {
    expect(() => canonicalizeManifestUrl("file:///tmp/manifest.json")).toThrow(
        "Addon URL must start with http://, https://, or stremio://"
    );
});

test("parses, deduplicates, and migrates addon preferences", () => {
    const stored = JSON.stringify([
        { name: "One", manifestUrl: "https://one.example/manifest.json", enabled: true },
        { name: "Duplicate", manifestUrl: "https://one.example/manifest.json", enabled: false },
        { name: "Disabled", manifestUrl: "https://two.example/manifest.json", enabled: false },
        { name: "", manifestUrl: "bad", enabled: true }
    ]);
    expect(parseAddons(stored)).toEqual([
        { name: "One", manifestUrl: "https://one.example/manifest.json", enabled: true },
        { name: "Disabled", manifestUrl: "https://two.example/manifest.json", enabled: false }
    ]);
    expect(parseAddons("[]", "https://legacy.example/manifest.json")).toEqual([
        { name: "legacy.example", manifestUrl: "https://legacy.example/manifest.json", enabled: true }
    ]);
});

test("accepts named manifests with any supported resource", () => {
    expect(parseAddonManifest({ name: "Catalog", resources: ["catalog"] })).toEqual({
        name: "Catalog",
        resources: ["catalog"],
        types: [],
        catalogs: []
    });
    expect(parseAddonManifest({
        name: "Mixed",
        resources: [{ name: "meta", types: ["movie"] }, "stream", "stream"],
        types: ["movie", "series"],
        catalogs: [{ id: "search", type: "movie", extra: [{ name: "search" }] }]
    })).toEqual({
        name: "Mixed",
        resources: ["meta", "stream"],
        types: ["movie", "series"],
        catalogs: [{ id: "search", type: "movie", extra: [{ name: "search" }] }]
    });
    expect(() => parseAddonManifest({ name: "Unsupported", resources: ["addon_catalog"] })).toThrow(
        "Manifest does not provide a supported resource."
    );
    expect(() => parseAddonManifest({ name: "", resources: ["stream"] })).toThrow(
        "Manifest is missing a name."
    );
});

test("merges successful addons in order and reports failures", async () => {
    const addons = [
        { name: "One", manifestUrl: "https://one.example/manifest.json", enabled: true },
        { name: "Broken", manifestUrl: "https://broken.example/manifest.json", enabled: true },
        { name: "Two", manifestUrl: "https://two.example/manifest.json", enabled: true }
    ];
    const result = await loadAddonStreams(addons, async (addon) => {
        if (addon.name === "Broken") throw new Error("offline");
        return [
            stream({
                title: addon.name,
                rawTitle: addon.name,
                url: addon.name === "Two" ? "https://same.example/video" : "https://one.example/video"
            }),
            stream({ title: "Duplicate", url: "https://same.example/video" })
        ];
    });

    expect(result.streams.map((stream) => [stream.title, stream.addonName])).toEqual([
        ["One", "One"],
        ["Duplicate", "One"]
    ]);
    expect(result).toMatchObject({ failedAddons: 1, successfulAddons: 2 });
});

test("loads streams only from enabled addons that declare stream capability", async () => {
    const addons = [
        { name: "Catalog", manifestUrl: "https://catalog.example/manifest.json", enabled: true },
        { name: "Playable", manifestUrl: "https://play.example/manifest.json", enabled: true },
        { name: "Broken", manifestUrl: "https://broken.example/manifest.json", enabled: true },
        { name: "Disabled", manifestUrl: "https://disabled.example/manifest.json", enabled: false }
    ];
    const streamCalls: string[] = [];
    const result = await loadEnabledAddonStreams(
        addons,
        async (addon) => {
            if (addon.name === "Broken") throw new Error("offline");
            return parseAddonManifest({
                name: addon.name,
                resources: addon.name === "Catalog" ? ["catalog"] : ["stream"]
            });
        },
        async (addon) => {
            streamCalls.push(addon.name);
            return [stream({
                title: addon.name,
                rawTitle: addon.name,
                url: `https://${addon.name}.example/video`,
                resolution: "1080p",
                size: "1 GB"
            })];
        }
    );

    expect(streamCalls).toEqual(["Playable"]);
    expect(result.streams.map(({ title }) => title)).toEqual(["Playable"]);
    expect(result).toMatchObject({ failedAddons: 1, successfulAddons: 1 });
});

test("a hung addon times out without blocking the others", async () => {
    const addons = [
        { name: "Slow", manifestUrl: "https://slow.example/manifest.json", enabled: true },
        { name: "Fast", manifestUrl: "https://fast.example/manifest.json", enabled: true }
    ];
    const result = await loadAddonStreams(addons, (addon) =>
        addon.name === "Slow"
            ? new Promise(() => {})
            : Promise.resolve([stream({ title: "Fast", url: "https://fast.example/video" })]),
        20
    );

    expect(result.streams.map(({ title }) => title)).toEqual(["Fast"]);
    expect(result).toMatchObject({ failedAddons: 1, successfulAddons: 1 });
});

test("a hung manifest times out like any other addon call", async () => {
    const addons = [
        { name: "Slow", manifestUrl: "https://slow.example/manifest.json", enabled: true },
        { name: "Playable", manifestUrl: "https://play.example/manifest.json", enabled: true }
    ];
    const result = await loadEnabledAddonStreams(
        addons,
        (addon) => addon.name === "Slow"
            ? new Promise(() => {})
            : Promise.resolve(parseAddonManifest({ name: addon.name, resources: ["stream"] })),
        (addon) => Promise.resolve([stream({ title: addon.name })]),
        20
    );

    expect(result.successfulAddons).toBe(1);
    expect(result.failedAddons).toBe(1);
});
