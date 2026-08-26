import { expect, test } from "bun:test";

import {
    isCurrentRequest,
    isPrefetchFresh,
    shouldSendWatchedStop,
    shouldOfferNextEpisode,
    shouldSaveProgress
} from "./playback";

test("offers the next episode only after natural EOF", () => {
    expect(shouldOfferNextEpisode(false, true)).toBe(true);
    expect(shouldOfferNextEpisode(false, false)).toBe(false);
    expect(shouldOfferNextEpisode(true, true)).toBe(false);
});

test("accepts only results from the current playback request", () => {
    expect(isCurrentRequest(2, 2)).toBe(true);
    expect(isCurrentRequest(2, 3)).toBe(false);
});

test("saves local progress every 30 seconds", () => {
    expect(shouldSaveProgress(29_999, 0, 30_000)).toBe(false);
    expect(shouldSaveProgress(30_000, 0, 30_000)).toBe(true);
    expect(shouldSaveProgress(60_001, 30_001, 30_000)).toBe(true);
});

test("sends one watched stop when playback crosses 90 percent", () => {
    expect(shouldSendWatchedStop(89.9, false)).toBe(false);
    expect(shouldSendWatchedStop(90, false)).toBe(true);
    expect(shouldSendWatchedStop(91, true)).toBe(false);
});

test("treats a prefetch older than its budget as stale", () => {
    expect(isPrefetchFresh(0, 9 * 60_000, 10 * 60_000)).toBe(true);
    expect(isPrefetchFresh(0, 10 * 60_000, 10 * 60_000)).toBe(false);
    expect(isPrefetchFresh(0, 20 * 60_000, 10 * 60_000)).toBe(false);
    expect(isPrefetchFresh(Number.NaN, 0, 10 * 60_000)).toBe(false);
});
