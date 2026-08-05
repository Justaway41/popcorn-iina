import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

test("global entry avoids the missing undefined identifier", () => {
    const source = readFileSync(new URL("./global.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bundefined\b/);
});

test("global entry opens validated external-link requests natively", () => {
    const source = readFileSync(new URL("./global.ts", import.meta.url), "utf8");
    const info = JSON.parse(readFileSync(
        new URL("../../Info.json", import.meta.url),
        "utf8"
    ));
    expect(source).toContain("parseTraktExternalLinkRequest");
    expect(source).toContain("utils.open(url)");
    expect(info.preferenceDefaults.externalLinkRequest).toEqual({});
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
