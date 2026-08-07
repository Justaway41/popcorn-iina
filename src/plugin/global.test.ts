import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

test("global entry avoids the missing undefined identifier", () => {
    const source = readFileSync(new URL("./global.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bundefined\b/);
});

test("global entry does not poll preferences while the plugin can unload", () => {
    const source = readFileSync(new URL("./global.ts", import.meta.url), "utf8");
    const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const info = JSON.parse(readFileSync(
        new URL("../../Info.json", import.meta.url),
        "utf8"
    ));
    expect(`${source}\n${mainSource}`).not.toContain("setInterval(");
    expect(source).not.toContain("externalLinkRequest");
    expect(info.preferenceDefaults).not.toHaveProperty("externalLinkRequest");
});

test("release workflow runs tests before packaging", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(workflow).toContain("run: bun test");
});

test("GitHub repository root is directly installable by IINA", () => {
    const root = new URL("../../", import.meta.url);
    const info = JSON.parse(readFileSync(new URL("Info.json", root), "utf8"));
    expect(info.name).toBe("Popcorn for IINA");
    expect(info.author.name).toBe("Justaway41");
    for (const path of [info.entry, info.globalEntry, info.preferencesPage]) {
        expect(existsSync(new URL(path, root))).toBe(true);
    }
});
