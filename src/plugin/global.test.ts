import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

test("loading the global entry does not execute external processes", async () => {
    const executed: string[] = [];

    (globalThis as { iina?: unknown }).iina = {
        console,
        file: {
            exists() {
                return true;
            }
        },
        global: {
            createPlayerInstance() {
                return 1;
            },
            postMessage() {}
        },
        menu: {
            addItem() {},
            item() {
                return {};
            }
        },
        preferences: {
            get() {},
            set() {},
            sync() {}
        },
        utils: {
            exec(path: string) {
                executed.push(path);
                return Promise.resolve({ status: 0, stdout: "", stderr: "" });
            }
        }
    };

    await import("./global");

    expect(executed).toEqual([]);
});

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

test("the global entry registers no message listeners", () => {
    // On IINA 1.4.4 under macOS 27 such a callback runs outside the context it was written in,
    // and declaring the sender-id parameter crashes IINA about eleven seconds after launch.
    const source = readFileSync(new URL("./global.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/global\.onMessage\(/);
});

test("player-side listeners never ask IINA for the sender's player id", () => {
    const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const listener = /global\.onMessage\(\s*"[^"]+"\s*,\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))/g;
    for (const match of mainSource.matchAll(listener)) {
        const params = (match[1] ?? "").split(",").map((param) => param.trim()).filter(Boolean);
        expect({ listener: match[0], params: params.length }).toEqual({ listener: match[0], params: Math.min(params.length, 1) });
    }
});

test("the Popcorn window is addressed by the id it was created with", () => {
    const source = readFileSync(new URL("./global.ts", import.meta.url), "utf8");
    const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(source).toContain("popcornPlayerId = global.createPlayerInstance(");
    expect(source).toContain('global.postMessage(popcornPlayerId, "showPopcornSidebar"');
    // Posting by label is never delivered on IINA 1.4.4.
    expect(source).not.toMatch(/global\.postMessage\(POPCORN_PLAYER_LABEL/);
    // And the window says whether it is open through a preference, not a message.
    expect(mainSource).not.toMatch(/global\.postMessage\("player(?:Ready|Closed)"/);
    expect(mainSource).toContain("preferences.set(POPCORN_WINDOW_OPEN, open)");
});
