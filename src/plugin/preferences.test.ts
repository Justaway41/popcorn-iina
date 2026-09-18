import { expect, test } from "bun:test";
import { createPlistSafeStore, migrateStructuredPreferences, parseLanguagePreference } from "./preferences";

const info = await Bun.file(
    new URL("../../Info.json", import.meta.url)
).json() as { preferenceDefaults: Record<string, unknown> };
const preferenceWriters = await Promise.all([
    "../ui/preferences.ts",
    "./main.ts",
    "./trakt.ts",
    "./anime.ts"
].map((path) => Bun.file(new URL(path, import.meta.url)).text()));

test("stores composite preferences as structured values for IINA's webview bridge", () => {
    expect(info.preferenceDefaults.addons).toEqual([]);
    expect(info.preferenceDefaults.watchHistory).toEqual([]);
    expect(info.preferenceDefaults.episodeWatchState).toEqual({ local: [], simkl: [], simklCours: [] });
    expect(info.preferenceDefaults.animeChains).toEqual({});
    expect(info.preferenceDefaults.trakt).toEqual({});
    expect(preferenceWriters.join("\n")).not.toMatch(
        /preferences\.set\("(?:addons|watchHistory|trakt)", JSON\.stringify/
    );
});

test("persists exact episode watched state with playback and remote history", () => {
    const mainSource = preferenceWriters[1];
    expect(mainSource).toContain("markEpisodeWatched");
    expect(mainSource).toContain("applySimklWatchedPatches");
    expect(mainSource).toContain('preferences.set("episodeWatchState"');
    expect(mainSource).toContain("episodeWatchState");
});

test("migrates JSON-string preferences to webview-safe structured values", () => {
    const values: Record<string, unknown> = {
        addonManifestUrl: "https://example.com/manifest.json",
        addons: "[]",
        watchHistory: '[{"id":"tt1"}]',
        trakt: '{"clientId":"client"}'
    };
    let syncs = 0;

    migrateStructuredPreferences({
        get: (key) => values[key],
        set: (key, value) => {
            values[key] = value;
        },
        sync: () => {
            syncs += 1;
        }
    });

    expect(values.addons).toEqual([{
        name: "example.com",
        manifestUrl: "https://example.com/manifest.json",
        enabled: true
    }]);
    expect(values.watchHistory).toEqual([]);
    expect(values.trakt).toMatchObject({ clientId: "client" });
    expect(syncs).toBe(1);
});

test("leaves structured preferences untouched", () => {
    const values = {
        addons: [],
        watchHistory: [],
        trakt: {}
    };
    let syncs = 0;

    migrateStructuredPreferences({
        get: (key) => values[key as keyof typeof values],
        set: () => {
            throw new Error("should not write");
        },
        sync: () => {
            syncs += 1;
        }
    });

    expect(syncs).toBe(0);
});

test("reads a language preference as trimmed text and nothing else", () => {
    expect(parseLanguagePreference(" English ")).toBe("English");
    expect(parseLanguagePreference("")).toBe("");
    expect(parseLanguagePreference(42)).toBe("");
    expect(parseLanguagePreference(undefined)).toBe("");
    expect(parseLanguagePreference(null)).toBe("");
});

test("keeps resolved anime chains across restarts", () => {
    // AniList is the single point of failure for every anime feature here, and it has answered
    // 403 for a whole day. A restart during an outage must still place what it placed before.
    const source = preferenceWriters[3];
    expect(source).toContain('preferences.get("animeChains")');
    expect(source).toContain('preferences.set("animeChains"');
});

test("a preference write drops what a property list cannot hold", () => {
    // IINA stores a plugin's preferences as a property list, which has no null: one null
    // anywhere failed the whole write with "the data couldn't be written because of an error in
    // the destination for the data", and every sync silently stored nothing. A movie's history
    // entry carries `episode: null`, so watched state stopped updating entirely.
    const writes: Array<[string, unknown]> = [];
    const store = createPlistSafeStore({
        get() { return undefined; },
        set(key, value) { writes.push([key, value]); },
        sync() {}
    });

    store.set("watchHistory", [
        { id: "tt1", episode: null, progress: 42 },
        { id: "tt2", episode: { season: 1, episode: 2 }, progress: null },
        { id: "tt3", progress: Number.NaN }
    ]);

    expect(writes).toEqual([["watchHistory", [
        { id: "tt1", progress: 42 },
        { id: "tt2", episode: { season: 1, episode: 2 } },
        { id: "tt3" }
    ]]]);

    // Nested nulls and unwritable array members go too.
    store.set("episodeWatchState", { local: [null, { id: "tt9", episodes: ["1:1"] }], simkl: [] });
    expect(writes[1]).toEqual(["episodeWatchState", {
        local: [{ id: "tt9", episodes: ["1:1"] }],
        simkl: []
    }]);

    // A value that is nothing but null has no property list form, so what is stored stands.
    store.set("mediaType", null);
    expect(writes).toHaveLength(2);
});
