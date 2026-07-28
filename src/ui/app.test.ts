import { expect, test } from "bun:test";

import {
    getAudioBadge,
    getEpisodeOrderLabel,
    getProgressDisplay,
    getSubtitleBadge,
    replaceRequest
} from "./app";

test("labels both serial episode orders", () => {
    expect(getEpisodeOrderLabel("oldest")).toBe("Oldest First");
    expect(getEpisodeOrderLabel("newest")).toBe("Newest First");
});

test("replacing a request aborts the previous request only", () => {
    const previous = new AbortController();
    const current = replaceRequest(previous);

    expect(previous.signal.aborted).toBe(true);
    expect(current.signal.aborted).toBe(false);
});

test("formats single, multiple, and unknown audio languages", () => {
    expect(getAudioBadge(["English"])).toEqual({ label: "English", title: "Audio: English" });
    expect(getAudioBadge(["English", "Hindi"])).toEqual({
        label: "Multi (2)",
        title: "Audio: English, Hindi"
    });
    expect(getAudioBadge([])).toEqual({
        label: "Audio ?",
        title: "Audio language not provided"
    });
});

test("combines embedded and external English subtitle availability", () => {
    expect(getSubtitleBadge(["English"], false)).toEqual({
        label: "EN Subs",
        title: "English subtitles available",
        state: "yes"
    });
    expect(getSubtitleBadge(null, true).state).toBe("yes");
    expect(getSubtitleBadge(["Spanish"], null).state).toBe("no");
    expect(getSubtitleBadge(null, false).state).toBe("no");
    expect(getSubtitleBadge(null, null)).toEqual({
        label: "Subs ?",
        title: "Subtitle availability unknown",
        state: "unknown"
    });
});

test("shows progress only for unfinished entries with an exact position", () => {
    expect(getProgressDisplay(null, false)).toBeNull();
    expect(getProgressDisplay(42.25, false)).toEqual({ percent: 42, label: "42% watched" });
    expect(getProgressDisplay(95, true)).toBeNull();
});
