import { expect, test } from "bun:test";

import {
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
