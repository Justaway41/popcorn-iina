import { expect, test } from "bun:test";
import * as app from "./app";

import {
    buildRowMeta,
    buildStreamSummary,
    createStreamCache,
    getActiveSeason,
    getAudioBadge,
    getDefaultTier,
    getTierRowCap,
    getSkeletonCells,
    getVaryingStreamFields,
    isPlayingStream,
    parseNowPlaying,
    playingStream,
    stripSeriesPrefix,
    getCacheBadge,
    getEpisodeOrderButtonId,
    getEpisodeOrderLabel,
    getProgressDisplay,
    getSizeSortControl,
    getPendingPlayback,
    isPendingStream,
    mergeSettledCatalogResults,
    PLAYBACK_START_TIMEOUT_MS,
    replaceRequest,
    resolveUpNextEpisode,
    restoreSearchFocus
} from "./app";
import { isEpisodeWatched, parseEpisodeWatchState } from "../shared/history";
import type { Episode, Media } from "../shared/stremio";

const appSource = await Bun.file(new URL("./app.ts", import.meta.url)).text();
const styleSource = await Bun.file(new URL("../../ui/sidebar.css", import.meta.url)).text();

const show: Media = {
    id: "tt9",
    imdbId: "tt9",
    type: "series",
    name: "Show",
    releaseInfo: "",
    poster: ""
};

const episode = (season: number, number: number): Episode => ({
    id: `tt9:${season}:${number}`,
    name: `Episode ${number}`,
    season,
    episode: number,
    aired: "2020-01-01",
    description: "",
    thumbnail: ""
});

test("restores native search focus without losing the selection or stealing another control", () => {
    const calls: string[] = [];
    const input = {
        ownerDocument: { activeElement: null as unknown },
        selectionStart: 2, selectionEnd: 7, selectionDirection: "backward",
        blur() { calls.push("blur"); this.ownerDocument.activeElement = null; },
        focus(options: { preventScroll: boolean }) {
            expect(options).toEqual({ preventScroll: true });
            expect(this.ownerDocument.activeElement).not.toBe(this);
            calls.push("focus");
            this.ownerDocument.activeElement = this;
            this.selectionStart = this.selectionEnd = 12;
            this.selectionDirection = "none";
        },
        setSelectionRange(start: number, end: number, direction: string) {
            calls.push("selection");
            this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction;
        }
    };
    input.ownerDocument.activeElement = input;
    restoreSearchFocus(input as unknown as HTMLInputElement);
    expect(calls).toEqual(["blur", "focus", "selection"]);
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 7, "backward"]);
    calls.length = 0;
    input.ownerDocument.activeElement = { tagName: "BUTTON" };
    restoreSearchFocus(input as unknown as HTMLInputElement);
    expect(calls).toEqual([]);
});

test("a recovered paste replaces the search selection and notifies its normal input handler", () => {
    const paste = (app as unknown as { pasteSearchText: (
        input: HTMLInputElement, text: unknown, selection?: Pick<HTMLInputElement, "value" | "selectionStart" | "selectionEnd">
    ) => void }).pasteSearchText;
    expect(typeof paste).toBe("function");
    const input = {
        ownerDocument: { activeElement: null as unknown },
        value: "before old after", selectionStart: 7, selectionEnd: 10, selectionDirection: "none",
        blur() { this.ownerDocument.activeElement = null; },
        focus() { this.ownerDocument.activeElement = this; this.selectionStart = this.selectionEnd = this.value.length; },
        setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; },
        setRangeText(text: string, start: number, end: number, mode: string) {
            expect(mode).toBe("end");
            this.value = this.value.slice(0, start) + text + this.value.slice(end);
            this.selectionStart = this.selectionEnd = start + text.length;
        },
        dispatchEvent(event: Event) { expect(event.type).toBe("input"); expect(event.bubbles).toBe(true); return true; }
    };
    input.ownerDocument.activeElement = input;
    paste(input as unknown as HTMLInputElement, "日本語");
    expect(input.value).toBe("before 日本語 after");
    expect(input.selectionStart).toBe(10);
    input.value = "before old after";
    input.selectionStart = input.selectionEnd = 0; // IINA's native reset loses the live range.
    paste(input as unknown as HTMLInputElement, "日本語", {
        value: "before old after", selectionStart: 7, selectionEnd: 10
    });
    expect(input.value).toBe("before 日本語 after");
    input.value = "changed text";
    input.selectionStart = input.selectionEnd = input.value.length;
    paste(input as unknown as HTMLInputElement, "!", {
        value: "before old after", selectionStart: 7, selectionEnd: 10
    });
    expect(input.value).toBe("changed text!");
    input.value = "before 日本語 after";
    input.ownerDocument.activeElement = {};
    paste(input as unknown as HTMLInputElement, "Do not steal focus");
    input.ownerDocument.activeElement = input;
    paste(input as unknown as HTMLInputElement, { text: "Not a string" });
    expect(input.value).toBe("before 日本語 after");
});

test("native window blur retains the range while search is still the active control", () => {
    expect(appSource).toContain("if (document.activeElement !== ui.searchInput) blurredSearchSelection = null;");
    expect(appSource).toContain('ui.searchInput.addEventListener("select", rememberSearchSelection)');
});

test("uses exact local, Simkl, and legacy episode marks without inferring gaps", () => {
    const episodes = [episode(1, 1), episode(1, 2), episode(1, 3), episode(1, 4)];
    const state = parseEpisodeWatchState({
        local: [{ id: "tt9", episodes: ["1:1"] }],
        simkl: [{ id: "tt9", episodes: ["1:3"] }]
    });
    const legacy = [{
        id: episodes[3].id,
        media: show,
        episode: episodes[3],
        lastPlayedAt: "2026-09-03T00:00:00.000Z",
        watched: true,
        progress: 100
    }];

    expect(episodes.map((item) => isEpisodeWatched(state, show, item, legacy)))
        .toEqual([true, false, true, true]);
});

test("keeps an explicitly selected valid season during episode refresh", () => {
    const episodes = [episode(1, 1), episode(2, 1), episode(3, 1)];
    const watched = (item: Episode) => item.season === 1;

    expect(getActiveSeason(episodes, 1, watched)).toBe(1);
    expect(getActiveSeason(episodes, 9, watched)).toBe(2);
    expect(getActiveSeason(episodes, undefined, watched)).toBe(2);
    expect(appSource).toContain('else if (view.kind === "episodes")');
    expect(appSource).toContain("current.selectedSeason");
    expect(appSource).toContain("ui.content.scrollTop = scrollTop");
});

test("labels both serial episode orders", () => {
    expect(getEpisodeOrderLabel("oldest")).toBe("Oldest First");
    expect(getEpisodeOrderLabel("newest")).toBe("Newest First");
});

test("uses stable IDs for re-rendered episode order buttons", () => {
    expect(getEpisodeOrderButtonId("oldest")).toBe("episode-order-oldest");
    expect(getEpisodeOrderButtonId("newest")).toBe("episode-order-newest");
});

test("toggles the stream file-size sort label and direction", () => {
    expect(getSizeSortControl("largest")).toEqual({
        label: "Largest File",
        next: "smallest"
    });
    expect(getSizeSortControl("smallest")).toEqual({
        label: "Smallest File",
        next: "largest"
    });
});

test("keeps the stream list rendered while IINA opens playback", () => {
    expect(appSource).not.toContain("showStreamLoading()");
    expect(appSource).not.toContain("Opening stream in IINA...");
});


test("replacing a request aborts the previous request only", () => {
    const previous = new AbortController();
    const current = replaceRequest(previous);

    expect(previous.signal.aborted).toBe(true);
    expect(current.signal.aborted).toBe(false);
});

test("serves cached stream results only while fresh, bounded, and clearable", () => {
    let now = 0;
    const cache = createStreamCache(60_000, 2, () => now);
    const result = { streams: [], failedAddons: 0, successfulAddons: 2 };

    cache.set("movie:tt1", result);
    expect(cache.get("movie:tt1")).toBe(result);

    // exactly at the TTL the entry is stale, not fresh
    now = 60_000;
    expect(cache.get("movie:tt1")).toBeNull();

    now = 60_001;
    cache.set("series:tt2:1:1", result);
    cache.set("series:tt2:1:2", result);
    cache.set("series:tt2:1:3", result);
    // capacity two: the oldest entry leaves first
    expect(cache.get("series:tt2:1:1")).toBeNull();
    expect(cache.get("series:tt2:1:2")).toBe(result);
    expect(cache.get("series:tt2:1:3")).toBe(result);

    cache.clear();
    expect(cache.get("series:tt2:1:2")).toBeNull();
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


test("labels verified and unknown cache states", () => {
    expect(getCacheBadge(true)).toEqual({
        label: "Cached",
        title: "Ready to play from debrid cache",
        state: "cached"
    });
    expect(getCacheBadge(false)).toEqual({
        label: "Uncached",
        title: "Not currently available in debrid cache",
        state: "uncached"
    });
    expect(getCacheBadge(null)).toEqual({
        label: "Cache ?",
        title: "Cache status not provided",
        state: "unknown"
    });
});

test("keeps raw stream titles as tooltips and explicit zero seeders visible", () => {
    expect(appSource).toContain("stream.rawTitle");
    expect(appSource).toContain("stream.seeders !== null");
    expect(appSource).toContain("`${stream.seeders} seeders`");
});

test("shows progress only for unfinished entries with an exact position", () => {
    expect(getProgressDisplay(null, false)).toBeNull();
    expect(getProgressDisplay(42.25, false)).toEqual({ percent: 42, label: "42% watched" });
    expect(getProgressDisplay(95, true)).toBeNull();
});

const stream = (over: Partial<{
    addonName: string; cached: boolean | null; source: string;
    audioLanguages: string[]; seeders: number | null; resolution: string; size: string;
}> = {}) => ({
    addonName: "AIOStreams",
    cached: null as boolean | null,
    source: "WEB-DL",
    audioLanguages: [] as string[],
    seeders: null as number | null,
    resolution: "1080p",
    size: "5 GB",
    ...over
});

test("hoists only the fields every stream agrees on", () => {
    const sameEverywhere = [
        stream({ cached: false, source: "WEBRip" }),
        stream({ cached: false, source: "WEBRip" })
    ];
    expect(getVaryingStreamFields(sameEverywhere)).toEqual({
        addon: false, cache: false, source: false
    });

    const mixed = [
        stream({ cached: true, source: "WEBRip" }),
        stream({ cached: false, source: "BluRay", addonName: "Comet" })
    ];
    expect(getVaryingStreamFields(mixed)).toEqual({ addon: true, cache: true, source: true });
});

test("summarizes constants and leaves varying facts to the rows", () => {
    const streams = [stream({ cached: false, source: "WEBRip" }), stream({ cached: false, source: "WEBRip" })];
    expect(buildStreamSummary(streams, getVaryingStreamFields(streams), true))
        .toBe("2 streams · AIOStreams · EN subs · WEBRip · none cached");

    const mixed = [stream({ cached: true }), stream({ cached: false, source: "BluRay" })];
    expect(buildStreamSummary(mixed, getVaryingStreamFields(mixed), null)).toBe("2 streams · AIOStreams");
});

test("keeps every ready stream visible before the show-more control", () => {
    expect(getTierRowCap(14)).toBe(14);
    expect(getTierRowCap(0)).toBe(5);
    expect(getTierRowCap(40)).toBe(15);
});

test("opens the highest tier that can play without downloading", () => {
    const tiers = [
        { resolution: "2160p", streams: [{ cached: false }, { cached: false }] },
        { resolution: "1080p", streams: [{ cached: true }] },
        { resolution: "720p", streams: [{ cached: true }] }
    ];
    expect(getDefaultTier(tiers, null)).toBe("1080p");
    // a tier the user opened earlier wins while it still has streams
    expect(getDefaultTier(tiers, "720p")).toBe("720p");
    expect(getDefaultTier(tiers, "480p")).toBe("1080p");
    // nothing cached anywhere falls back to the largest tier
    expect(getDefaultTier([
        { resolution: "2160p", streams: [{ cached: false }] },
        { resolution: "1080p", streams: [{ cached: false }, { cached: false }] }
    ], null)).toBe("1080p");
});

test("omits row metadata that the summary line already states", () => {
    const hoisted = { addon: false, cache: false, source: false };
    expect(buildRowMeta(stream({ audioLanguages: ["German"] }), hoisted)).toBe("German");
    expect(buildRowMeta(stream(), hoisted)).toBe("");

    const varying = { addon: true, cache: true, source: true };
    expect(buildRowMeta(stream({ audioLanguages: ["German"], addonName: "Comet" }), varying))
        .toBe("WEB-DL · German · Comet");
});

test("shows seeders only when the stream is not already cached", () => {
    const varying = { addon: false, cache: true, source: false };
    expect(buildRowMeta(stream({ cached: true, seeders: 42 }), varying)).toBe("");
    expect(buildRowMeta(stream({ cached: false, seeders: 42 }), varying)).toBe("42 seeders");
});

test("drops a series prefix the header already shows", () => {
    const pattern = /^\s*Dark[\s(]*(?:\d{4}\)?)?[\s\-–·()]*(?:s0?3\s*[.\s]?e0?4|s0?3|0?3x0?4|season\s*0?3)?[\s\-–·]*/i;
    expect(stripSeriesPrefix("Dark · S03E04 · WEBRip · x265-NTb", pattern)).toBe("WEBRip · x265-NTb");
    expect(stripSeriesPrefix("Dark S03 · WEB-DL Kitsune", pattern)).toBe("WEB-DL Kitsune");
    // never blank a row out entirely
    expect(stripSeriesPrefix("Dark S03E04", pattern)).toBe("Dark S03E04");
    expect(stripSeriesPrefix("Some Other Release", pattern)).toBe("Some Other Release");
    // an orphaned bracket or dash left by the removal must not survive
    expect(stripSeriesPrefix("Dark (2017) S03E04 ( NF · WEB-DL", pattern)).toBe("NF · WEB-DL");
    expect(stripSeriesPrefix("Dark (2017) - S03E04 - The Origin [WEBDL]", pattern)).toBe("The Origin [WEBDL]");
});

test("skeleton stands in for the bands the view resolves into", () => {
    // posters only on the home grid
    expect(getSkeletonCells("grid")).toEqual(Array(6).fill("sk-tile"));
    // every list view arrives as summary, then an open tier heading, then rows
    expect(getSkeletonCells("rows").slice(0, 3)).toEqual(["sk-summary", "sk-tier", "sk-row"]);
    // the episode list leads with the season chip strip and uses its own shorter row
    expect(getSkeletonCells("episodes")[0]).toBe("sk-chips");
    expect(getSkeletonCells("episodes").slice(1)).toEqual(Array(8).fill("sk-erow"));
    // stream bands must never leak into the episode shape - their heights differ
    expect(getSkeletonCells("episodes")).not.toContain("sk-summary");
    expect(getSkeletonCells("episodes")).not.toContain("sk-row");
});

test("marks the playing row only on the episode actually playing", () => {
    const playing = {
        videoId: "tt0988818:1:11",
        url: "https://cdn.example/a.mkv",
        releaseName: "[Mattmurdock] Gintama - 011.mkv"
    };
    const row = { url: "https://cdn.example/a.mkv", rawTitle: "[Mattmurdock] Gintama - 011.mkv" };

    expect(isPlayingStream(row, playingStream(playing, "tt0988818:1:11"))).toBe(true);
    // Opening any other episode marks nothing, even though the player is still going.
    expect(isPlayingStream(row, playingStream(playing, "tt0988818:1:12"))).toBe(false);
    expect(isPlayingStream(row, playingStream(playing, ""))).toBe(false);

    // A debrid addon mints a fresh URL per request, so the name has to carry the match.
    const reissued = { url: "https://cdn.example/DIFFERENT.mkv", rawTitle: row.rawTitle };
    expect(isPlayingStream(reissued, playingStream(playing, "tt0988818:1:11"))).toBe(true);
    // A different file at neither the same URL nor the same name is not the one playing.
    const other = { url: "https://cdn.example/b.mkv", rawTitle: "[AnimeRG] Gintama - 011.mkv" };
    expect(isPlayingStream(other, playingStream(playing, "tt0988818:1:11"))).toBe(false);
    // Nothing playing marks nothing, even for a row with empty fields of its own.
    expect(isPlayingStream({ url: "", rawTitle: "" }, { videoId: "", url: "", releaseName: "" }))
        .toBe(false);
});

test("reads what the player reports defensively", () => {
    expect(parseNowPlaying(undefined)).toEqual({ videoId: "", url: "", releaseName: "" });
    expect(parseNowPlaying({ videoId: 7, url: null, releaseName: [] }))
        .toEqual({ videoId: "", url: "", releaseName: "" });
    expect(parseNowPlaying({ videoId: "tt1:1:1", url: "https://cdn.example/a.mkv", releaseName: "a.mkv" }))
        .toEqual({ videoId: "tt1:1:1", url: "https://cdn.example/a.mkv", releaseName: "a.mkv" });
});

test("matches the row when the overlay started the stream, not just a sidebar click", () => {
    // The overlay's own prefetch supplies the release name too; without it the plugin reports
    // an empty name and, once the debrid link is reissued, nothing can match.
    const overlayStarted = parseNowPlaying({
        videoId: "tt0988818:1:11",
        url: "https://cdn.example/issued-at-prefetch.mkv",
        releaseName: "[ReinForce] Gintama 11 (BDRip 1920x1080 x264 FLAC).mkv"
    });
    const row = {
        url: "https://cdn.example/reissued-for-the-list.mkv",
        rawTitle: "[ReinForce] Gintama 11 (BDRip 1920x1080 x264 FLAC).mkv"
    };

    expect(isPlayingStream(row, playingStream(overlayStarted, "tt0988818:1:11"))).toBe(true);
    // A missing release name is what the bug looked like: no url match, no name to fall back on.
    const nameless = parseNowPlaying({ videoId: "tt0988818:1:11", url: overlayStarted.url });
    expect(isPlayingStream(row, playingStream(nameless, "tt0988818:1:11"))).toBe(false);
});

test("a Continue Watching card resumes an unfinished episode", () => {
    const episodes = [episode(1, 1), episode(1, 2), episode(1, 3)];
    const entry = {
        id: episodes[1].id,
        media: show,
        episode: episodes[1],
        lastPlayedAt: "2026-09-03T00:00:00.000Z",
        watched: false,
        progress: 42
    };

    const target = resolveUpNextEpisode(entry, episodes, () => false);
    expect(target?.resume).toBe(true);
    expect(target?.episode.id).toBe("tt9:1:2");
});

test("a Continue Watching card offers the first episode the watched set is missing", () => {
    // The card asked for the episode after the one history happened to carry, so a gap in the
    // exact watched state was stepped over and rewatching an older episode moved it backwards.
    const episodes = [episode(1, 1), episode(1, 2), episode(1, 3), episode(1, 4)];
    const state = parseEpisodeWatchState({ simkl: [{ id: "tt9", episodes: ["1:1", "1:3"] }] });
    const watched = (item: Episode) => isEpisodeWatched(state, show, item);
    const finished = (at: Episode) => ({
        id: at.id,
        media: show,
        episode: at,
        lastPlayedAt: "2026-09-03T00:00:00.000Z",
        watched: true,
        progress: 100
    });

    expect(resolveUpNextEpisode(finished(episodes[2]), episodes, watched))
        .toEqual({ episode: episodes[1], resume: false });
    // Rewatching episode one does not pull the target back to episode two-after-one.
    expect(resolveUpNextEpisode(finished(episodes[0]), episodes, watched))
        .toEqual({ episode: episodes[1], resume: false });
    // A part-watched episode the watched set says is finished elsewhere is not resumed.
    expect(resolveUpNextEpisode(
        { ...finished(episodes[0]), watched: false, progress: 42 },
        episodes,
        watched
    )).toEqual({ episode: episodes[1], resume: false });

    // Nothing left to watch removes the card.
    const allWatched = parseEpisodeWatchState({
        simkl: [{ id: "tt9", episodes: ["1:1", "1:2", "1:3", "1:4"] }]
    });
    expect(resolveUpNextEpisode(
        finished(episodes[3]),
        episodes,
        (item) => isEpisodeWatched(allWatched, show, item)
    )).toBeNull();
});

test("an unwatched special never becomes what a show is continued with", () => {
    const episodes = [episode(0, 1), episode(1, 1), episode(1, 2)];
    const watched = (item: Episode) => item.season === 1 && item.episode === 1;
    const entry = {
        id: episodes[1].id,
        media: show,
        episode: episodes[1],
        lastPlayedAt: "2026-09-03T00:00:00.000Z",
        watched: true,
        progress: 100
    };

    expect(resolveUpNextEpisode(entry, episodes, watched)?.episode.id).toBe("tt9:1:2");
    expect(getActiveSeason(episodes, undefined, watched)).toBe(1);
});

test("a Continue Watching card for a series the metadata has no episodes for is dropped", () => {
    // A cour once placed as its own show left a card on an IMDb id Cinemeta answers with an
    // empty body: no poster, no episode list, and an "After SxxExx" label that never resolved.
    // A lookup that merely failed still leaves the card alone.
    expect(appSource).toContain("if (!details || !slot.isConnected) return;");
    expect(appSource).toMatch(/if \(details\.episodes\.length === 0\) \{\s*slot\.remove\(\);/);
});

test("a press waits for playback to start, and stops waiting when it does", () => {
    const pending = { url: "https://host/a.mkv", releaseName: "Show.S01E01.1080p", startedAt: 1_000 };

    // Nothing reported yet: the press is still waiting.
    expect(getPendingPlayback(pending, "", 2_000)).toBe(pending);
    // The player reports it playing, which is what the press was waiting for.
    expect(getPendingPlayback(pending, pending.url, 2_000)).toBeNull();
    // Something else is playing - a press the viewer replaced, or playback started elsewhere.
    expect(getPendingPlayback(pending, "https://host/b.mkv", 2_000)).toBeNull();
    // A start that never happened must not leave the row waiting for the rest of the session.
    expect(getPendingPlayback(pending, "", 1_000 + PLAYBACK_START_TIMEOUT_MS)).toBeNull();
    expect(getPendingPlayback(null, "", 2_000)).toBeNull();
});

test("the waiting row is the one that was pressed", () => {
    const pending = { url: "https://host/a.mkv", releaseName: "Show.S01E01.1080p", startedAt: 0 };

    expect(isPendingStream({ url: "https://host/a.mkv", rawTitle: "other" }, pending)).toBe(true);
    // A debrid addon mints a new URL for the same file, so the release name matches it too.
    expect(isPendingStream({ url: "https://host/z.mkv", rawTitle: "Show.S01E01.1080p" }, pending)).toBe(true);
    expect(isPendingStream({ url: "https://host/z.mkv", rawTitle: "Show.S01E02.1080p" }, pending)).toBe(false);
    expect(isPendingStream({ url: "https://host/a.mkv", rawTitle: "x" }, null)).toBe(false);

    // A release name nothing carries must not mark every unnamed row.
    const unnamed = { url: "https://host/a.mkv", releaseName: "", startedAt: 0 };
    expect(isPendingStream({ url: "https://host/b.mkv", rawTitle: "" }, unnamed)).toBe(false);
});

test("the sidebar marks the pressed row and drops the mark when playback is reported", () => {
    // The URL is never written into the DOM: a debrid link carries private credentials.
    expect(appSource).toContain("beginPendingPlayback(stream);");
    expect(appSource).toContain("if (isPendingStream(stream, pendingPlayback)) return;");
    expect(appSource).toContain("settlePendingPlayback();");
    expect(appSource).not.toMatch(/dataset\.url\s*=/);
    expect(styleSource).toContain(".srow--starting");
    expect(styleSource).toContain("prefers-reduced-motion");
});
