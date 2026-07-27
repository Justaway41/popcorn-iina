import { expect, test } from "bun:test";

import {
    canonicalizeManifestUrl,
    getAddonHostname,
    loadAddonStreams,
    parseAddonManifest,
    parseAddons
} from "./addons";
import { buildStremioStreamUrl } from "./stremio";

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

test("requires a named stream addon manifest", () => {
    expect(parseAddonManifest({ name: "Debrid", resources: ["stream"] })).toBe("Debrid");
    expect(parseAddonManifest({ name: "Debrid", resources: [{ name: "stream", types: ["movie"] }] })).toBe(
        "Debrid"
    );
    expect(() => parseAddonManifest({ name: "Catalog", resources: ["catalog"] })).toThrow(
        "Manifest does not provide streams."
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
        return [{
            title: addon.name,
            url: addon.name === "Two" ? "https://same.example/video" : "https://one.example/video",
            quality: "",
            size: "",
            audioLanguages: [],
            subtitleLanguages: null
        }, {
            title: "Duplicate",
            url: "https://same.example/video",
            quality: "",
            size: "",
            audioLanguages: [],
            subtitleLanguages: null
        }];
    });

    expect(result.streams.map((stream) => [stream.title, stream.addonName])).toEqual([
        ["One", "One"],
        ["Duplicate", "One"]
    ]);
    expect(result).toMatchObject({ failedAddons: 1, successfulAddons: 2 });
});
