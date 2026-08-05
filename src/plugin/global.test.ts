import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("global entry avoids the missing undefined identifier", () => {
    const source = readFileSync(new URL("./global.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bundefined\b/);
});

test("global entry opens validated external-link requests natively", () => {
    const source = readFileSync(new URL("./global.ts", import.meta.url), "utf8");
    const info = JSON.parse(readFileSync(
        new URL("../../xyz.brbc.popcorn.iinaplugin/Info.json", import.meta.url),
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
