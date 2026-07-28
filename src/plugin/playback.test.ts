import { expect, test } from "bun:test";

import {
    shouldSendWatchedStop,
    shouldOfferNextEpisode,
    shouldSaveProgress
} from "./playback";

test("offers the next episode only after natural EOF", () => {
    expect(shouldOfferNextEpisode(false, true)).toBe(true);
    expect(shouldOfferNextEpisode(false, false)).toBe(false);
    expect(shouldOfferNextEpisode(true, true)).toBe(false);
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
