import { expect, test } from "bun:test";

import {
    getAudioBadge,
    getEpisodeOrderButtonId,
    getEpisodeOrderLabel,
    getOpenSeasonNumbers,
    getProgressDisplay,
    getQualitySortControl,
    getSubtitleBadge,
    mergeSettledCatalogResults,
    replaceRequest
} from "./app";

test("labels both serial episode orders", () => {
    expect(getEpisodeOrderLabel("oldest")).toBe("Oldest First");
    expect(getEpisodeOrderLabel("newest")).toBe("Newest First");
});

test("uses stable IDs for re-rendered episode order buttons", () => {
    expect(getEpisodeOrderButtonId("oldest")).toBe("episode-order-oldest");
    expect(getEpisodeOrderButtonId("newest")).toBe("episode-order-newest");
});

test("toggles the stream quality sort label and direction", () => {
    expect(getQualitySortControl("highest")).toEqual({
        label: "Highest First",
        next: "lowest"
    });
    expect(getQualitySortControl("lowest")).toEqual({
        label: "Lowest First",
        next: "highest"
    });
});

test("keeps expanded numeric seasons for an episode-list re-render", () => {
    const open = getOpenSeasonNumbers([
        { open: true, dataset: { season: "1" } },
        { open: false, dataset: { season: "2" } },
        { open: true, dataset: { season: "invalid" } }
    ]);

    expect([...open]).toEqual([1]);
});

test("replacing a request aborts the previous request only", () => {
    const previous = new AbortController();
    const current = replaceRequest(previous);

    expect(previous.signal.aborted).toBe(true);
    expect(current.signal.aborted).toBe(false);
});

test("keeps ordered catalog results when another provider fails", () => {
    const one = { id: "one", imdbId: "", type: "movie" as const, name: "One", releaseInfo: "", poster: "" };
    const two = { id: "two", imdbId: "", type: "movie" as const, name: "Two", releaseInfo: "", poster: "" };
    const result = mergeSettledCatalogResults([
        { status: "fulfilled", value: [one] },
        { status: "rejected", reason: new Error("offline") },
        { status: "fulfilled", value: [two] }
    ]);
    expect(result).toEqual({ items: [one, two], failedSources: 1, successfulSources: 2 });
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
