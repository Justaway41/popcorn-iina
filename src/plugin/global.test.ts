import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("global entry avoids the missing undefined identifier", () => {
    const source = readFileSync(new URL("./global.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bundefined\b/);
});

test("release workflow runs tests before packaging", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(workflow).toContain("run: bun test");
});
