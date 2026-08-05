import { expect, test } from "bun:test";
import { migrateStructuredPreferences } from "./preferences";

const info = await Bun.file(
    new URL("../../Info.json", import.meta.url)
).json() as { preferenceDefaults: Record<string, unknown> };
const preferenceWriters = await Promise.all([
    "../ui/preferences.ts",
    "./main.ts",
    "./trakt.ts"
].map((path) => Bun.file(new URL(path, import.meta.url)).text()));

test("stores composite preferences as structured values for IINA's webview bridge", () => {
    expect(info.preferenceDefaults.addons).toEqual([]);
    expect(info.preferenceDefaults.watchHistory).toEqual([]);
    expect(info.preferenceDefaults.trakt).toEqual({});
    expect(preferenceWriters.join("\n")).not.toMatch(
        /preferences\.set\("(?:addons|watchHistory|trakt)", JSON\.stringify/
    );
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
