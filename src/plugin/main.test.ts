import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

import { MESSAGE_NAMES, type PlayItemPayload } from "../shared/messages";

// Exercise the actual player entry without sharing a global IINA instance with other tests.
const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./main.ts", import.meta.url))],
    target: "browser",
    format: "iife",
    write: false
});
if (!build.success) throw new Error(String(build.logs));
const entry = await build.outputs[0].text();
const noop = () => {};

function player(chapters: Array<{ title: string; start: number }> = [], label = "popcorn") {
    const events = new Map<string, (data?: unknown) => void>();
    const keys = new Map<string, () => boolean>();
    const messages = new Map<string, (data: unknown) => void>();
    const overlayMessages = new Map<string, (data: unknown) => void>();
    const preferences = new Map<string, unknown>();
    const properties = new Map<string, unknown>([
        ["path", "assets/Popcorn.png"], ["duration", 1500], ["time-pos", 10],
        ["percent-pos", 1], ["pause", false], ["filename", "Example.S01E01.1080p.mkv"]
    ]);
    const requests: Array<{ url: string; answer: (data: unknown) => void }> = [];
    const clipboardReads: Array<(result: unknown) => void> = [];
    const calls: Array<{ method: string; context: string }> = [];
    const sidebarPosts: Array<{ name: string; data: unknown }> = [];
    const uiVisibility: boolean[] = [];
    const view = { modes: 0, visible: false, content: "", clickable: false };
    // IINA 1.4.4 reports only built-in settings sidebars; plugin sidebars return null.
    const window = { sidebar: null as string | null };
    let context = "network";
    const record = (method: string) => calls.push({ method, context });
    const onPlayer = (callback: () => void) => {
        context = "player";
        try { callback(); } finally { context = "network"; }
    };
    const request = (url: string) => new Promise((resolve) => {
        requests.push({ url, answer: (data) => resolve({ statusCode: 200, data }) });
    });
    runInNewContext(entry, {
        setTimeout, clearTimeout,
        iina: {
            console: { log: noop, warn: noop, error: noop },
            preferences: {
                get: (key: string) => preferences.get(key),
                set: (key: string, value: unknown) => preferences.set(key, value), sync: noop
            },
            event: { on: (name: string, callback: (data?: unknown) => void) => events.set(name, callback) },
            input: { PRIORITY_HIGH: 100, onKeyDown: (key: string, callback: () => boolean) => keys.set(key, callback) },
            global: { getLabel: () => label, onMessage: noop },
            core: { getChapters: () => chapters, osd: noop, setUIVisibility: (hidden: boolean) => uiVisibility.push(hidden), window },
            mpv: {
                getNumber: (key: string) => Number(properties.get(key) ?? 0),
                getString: (key: string) => String(properties.get(key) ?? ""),
                getFlag: (key: string) => Boolean(properties.get(key)),
                set: (key: string, value: unknown) => properties.set(key, value),
                command: (command: string, args: string[]) => {
                    if (command === "loadfile") properties.set("path", args[0]);
                }
            },
            sidebar: {
                loadFile: noop, show: noop, hide: noop,
                postMessage: (name: string, data: unknown) => sidebarPosts.push({ name, data }),
                onMessage: (name: string, callback: (data: unknown) => void) => messages.set(name, callback)
            },
            overlay: {
                // Native mode changes clear the message bridge, so registration order matters.
                simpleMode: () => { record("simpleMode"); view.modes++; overlayMessages.clear(); },
                setStyle: () => record("setStyle"),
                setContent: (html: string) => { record("setContent"); view.content = html; },
                setClickable: (value: boolean) => { record("setClickable"); view.clickable = value; },
                show: () => { record("show"); view.visible = true; },
                hide: () => { record("hide"); view.visible = false; },
                onMessage: (name: string, callback: (data: unknown) => void) => {
                    record("onMessage"); overlayMessages.set(name, callback);
                }
            },
            http: { get: request, post: request },
            utils: {
                exec: (file: string, args: string[]) => file === "/usr/bin/pbpaste"
                    ? new Promise((resolve) => { expect(args).toEqual([]); clipboardReads.push(resolve); })
                    : Promise.resolve({ status: 0 }),
                ask: noop
            }
        }
    });
    return {
        view, window, calls, preferences, properties, events, messages, sidebarPosts, clipboardReads, uiVisibility,
        emit: (name: string, data?: unknown) => onPlayer(() => events.get(name)!(data)),
        play: (payload: PlayItemPayload) => onPlayer(() => messages.get(MESSAGE_NAMES.PlayItem)!(payload)),
        click: (action: string) => onPlayer(() => overlayMessages.get("overlayAction")!({ action })),
        send: (name: string, data: unknown) => onPlayer(() => messages.get(name)!(data)),
        key: (name: string) => keys.get(name)!(),
        async answer(host: string, data: unknown) {
            const index = requests.findIndex((request) => request.url.includes(host));
            expect(index).toBeGreaterThanOrEqual(0);
            requests.splice(index, 1)[0].answer(data);
            // Let the real HTTP parsing, merging and prefetch promise chains settle.
            await Bun.sleep(0);
        }
    };
}

const episodes = [1, 2].map((episode) => ({
    id: `tt9999999:1:${episode}`, season: 1, episode, name: `Episode ${episode}`,
    aired: "2020-01-01", description: "", thumbnail: ""
}));
const payload: PlayItemPayload = {
    url: "https://media.example/episode.mkv", title: "Example",
    playbackContext: {
        media: {
            id: "tt9999999", imdbId: "tt9999999", type: "series", name: "Example",
            releaseInfo: "2020", poster: "", malId: "1"
        },
        episode: episodes[0], episodes, resolution: "1080p"
    }
};

test("hides splash controls and restores them for video without overriding another plugin's window", () => {
    const p = player();
    p.emit("iina.window-loaded");
    p.emit("mpv.file-loaded");
    expect(p.uiVisibility).toEqual([true]);
    p.properties.set("path", "https://media.example/video.mkv");
    p.emit("mpv.file-loaded");
    expect(p.uiVisibility).toEqual([true, false]);

    const foreign = player([], "jellyfin");
    foreign.properties.set("path", "assets/Jellyfin");
    foreign.emit("iina.window-loaded");
    foreign.emit("mpv.file-loaded");
    expect(foreign.uiVisibility).toEqual([]);

    const ordinary = player([], "");
    ordinary.properties.set("path", "https://media.example/video.mkv");
    ordinary.emit("iina.window-loaded");
    ordinary.emit("mpv.file-loaded");
    expect(ordinary.uiVisibility).toEqual([false]);
});

test("initializes the overlay once during window startup and preserves its click handler", async () => {
    const p = player();
    expect(p.view.modes).toBe(0);
    p.emit("iina.window-loaded");
    expect(p.view.modes).toBe(1);
    expect(p.view.visible).toBe(false);
    p.play(payload);
    p.emit("mpv.file-loaded");
    await p.answer("introdb.app", { intro: { start_sec: 0, end_sec: 100 } });
    p.emit("mpv.time-pos.changed");
    expect(p.view.content).toContain("Skip Intro");
    expect(p.view.clickable).toBe(true);
    p.click("intro");
    expect(p.properties.get("time-pos")).toBe(100.5);
    expect(p.view.visible).toBe(false);
    p.play(payload);
    p.properties.set("time-pos", 10);
    p.emit("mpv.file-loaded");
    await p.answer("introdb.app", { intro: { start_sec: 0, end_sec: 90 } });
    p.emit("mpv.time-pos.changed");
    p.click("intro");
    expect(p.properties.get("time-pos")).toBe(90.5);
    expect(p.view.modes).toBe(1);
    expect(p.calls.every((call) => call.context === "player")).toBe(true);
});

test("recovers a paste delivered to the player window only for a focused, visible search", async () => {
    const p = player();
    p.emit("iina.window-loaded");
    p.emit("mpv.file-loaded");
    expect(p.messages.has("searchFocusChanged")).toBe(true);
    expect(p.key("Meta+v")).toBe(false);
    expect(p.clipboardReads).toHaveLength(0);
    p.send("searchFocusChanged", { focused: true });
    expect(p.key("Meta+v")).toBe(true);
    expect(p.clipboardReads).toHaveLength(1);
    p.clipboardReads[0]({ status: 0, stdout: "Synthetic paste", stderr: "" });
    await Bun.sleep(0);
    expect(p.sidebarPosts.filter((post) => post.name === "pasteSearchText")).toEqual([
        { name: "pasteSearchText", data: { text: "Synthetic paste" } }
    ]);
    p.send("searchFocusChanged", { focused: false });
    expect(p.key("Meta+v")).toBe(false);
    p.send("searchFocusChanged", { focused: "true" }); // Untrusted bridge input is not a boolean.
    expect(p.key("Meta+v")).toBe(false);
    p.send("searchFocusChanged", { focused: true });
    p.window.sidebar = "video";
    expect(p.key("Meta+v")).toBe(false);
    p.window.sidebar = null;
    p.play(payload);
    p.emit("mpv.file-loaded");
    expect(p.key("Meta+v")).toBe(false);
    expect(p.clipboardReads).toHaveLength(1);
});

test("drops clipboard replies after focus changes or the player closes", async () => {
    const p = player();
    p.emit("iina.window-loaded");
    p.emit("mpv.file-loaded");
    expect(p.messages.has("searchFocusChanged")).toBe(true);
    p.send("searchFocusChanged", { focused: true });
    p.key("Meta+v");
    p.send("searchFocusChanged", { focused: false });
    p.send("searchFocusChanged", { focused: true });
    p.clipboardReads[0]({ status: 0, stdout: "Stale", stderr: "" });
    await Bun.sleep(0);
    expect(p.sidebarPosts.some((post) => post.name === "pasteSearchText")).toBe(false);
    p.key("Meta+v");
    p.emit("iina.window-will-close");
    p.clipboardReads[1]({ status: 0, stdout: "Late", stderr: "" });
    await Bun.sleep(0);
    expect(p.sidebarPosts.some((post) => post.name === "pasteSearchText")).toBe(false);
    expect(p.key("Meta+v")).toBe(false);
});

test("failed or malformed clipboard output is not sent to the sidebar", async () => {
    const p = player();
    p.emit("iina.window-loaded");
    p.emit("mpv.file-loaded");
    p.send("searchFocusChanged", { focused: true });
    p.key("Meta+v");
    p.clipboardReads[0]({ status: 1, stdout: "Partial output", stderr: "Failed" });
    await Bun.sleep(0);
    p.key("Meta+v");
    p.clipboardReads[1]({ status: 0, stdout: null });
    await Bun.sleep(0);
    expect(p.sidebarPosts.some((post) => post.name === "pasteSearchText")).toBe(false);
    p.key("Meta+v");
    p.play(payload);
    p.emit("mpv.file-loaded");
    p.clipboardReads[2]({ status: 0, stdout: "Now hidden" });
    await Bun.sleep(0);
    expect(p.sidebarPosts.some((post) => post.name === "pasteSearchText")).toBe(false);
});

test("HTTP skip results wait for a player event before touching the overlay", async () => {
    const p = player();
    p.emit("iina.window-loaded");
    p.play(payload);
    p.emit("mpv.file-loaded");
    p.properties.set("pause", true);
    const callsBeforeReply = p.calls.length;
    await p.answer("introdb.app", { intro: { start_sec: 0, end_sec: 100 } });
    expect(p.calls.length).toBe(callsBeforeReply);
    expect(p.view.visible).toBe(false);
    p.emit("mpv.pause.changed");
    expect(p.view.visible).toBe(true);
    expect(p.view.content).toContain("Skip Intro");
});

test("AniSkip replies also wait for a player event", async () => {
    const p = player();
    p.emit("iina.window-loaded");
    p.play(payload);
    p.emit("mpv.file-loaded");
    await Bun.sleep(0);
    const callsBeforeReply = p.calls.length;
    await p.answer("aniskip.com", {
        found: true, results: [{ skipType: "op", interval: { startTime: 0, endTime: 100 } }]
    });
    expect(p.calls.length).toBe(callsBeforeReply);
    p.emit("mpv.time-pos.changed");
    expect(p.view.visible).toBe(true);
    expect(p.view.content).toContain("Skip Intro");
});

test("chapter intros remain available synchronously without an HTTP reply", () => {
    const p = player([{ title: "Opening", start: 0 }, { title: "Episode", start: 100 }]);
    p.emit("iina.window-loaded");
    p.play(payload);
    p.emit("mpv.file-loaded");
    expect(p.view.visible).toBe(true);
    expect(p.view.content).toContain("Skip Intro");
    p.click("intro");
    expect(p.properties.get("time-pos")).toBe(100.5);
});

test("HTTP next-episode results wait for a player event before touching the overlay", async () => {
    const p = player();
    p.preferences.set("addons", [{ name: "Example", manifestUrl: "https://addon.example/manifest.json", enabled: true }]);
    p.emit("iina.window-loaded");
    p.play(payload);
    p.properties.set("time-pos", 1490);
    p.emit("mpv.file-loaded");
    await p.answer("manifest.json", { name: "Example", resources: ["stream"], types: ["series"] });
    const callsBeforeReply = p.calls.length;
    await p.answer("/stream/", { streams: [{ url: "https://media.example/next.mkv", title: "Example.S01E02.1080p" }] });
    expect(p.calls.length).toBe(callsBeforeReply);
    p.emit("mpv.time-pos.changed");
    expect(p.view.visible).toBe(true);
    expect(p.view.content).toContain("Next Episode");
    p.click("next");
    expect(p.properties.get("path")).toBe("https://media.example/next.mkv");
    expect(p.view.visible).toBe(false);
    expect(p.view.modes).toBe(1);
    expect(p.calls.every((call) => call.context === "player")).toBe(true);
});

test("late skip replies cannot touch the overlay after the window closes", async () => {
    const p = player();
    p.emit("iina.window-loaded");
    p.play(payload);
    p.emit("mpv.file-loaded");
    p.emit("iina.window-will-close");
    const callsAfterClose = p.calls.length;
    await p.answer("introdb.app", { intro: { start_sec: 0, end_sec: 100 } });
    p.emit("mpv.time-pos.changed");
    p.emit("mpv.end-file");
    expect(p.calls.length).toBe(callsAfterClose);
    expect(p.view.visible).toBe(false);
});
