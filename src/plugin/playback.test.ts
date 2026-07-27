import { expect, test } from "bun:test";

import { getPlaybackMilestone, shouldOfferNextEpisode } from "./playback";

test("offers the next episode only after natural EOF", () => {
    expect(shouldOfferNextEpisode(false, true)).toBe(true);
    expect(shouldOfferNextEpisode(false, false)).toBe(false);
    expect(shouldOfferNextEpisode(true, true)).toBe(false);
});

test("emits each playback milestone once", () => {
    expect(getPlaybackMilestone(4.9, false, false)).toBeNull();
    expect(getPlaybackMilestone(5, false, false)).toBe(5);
    expect(getPlaybackMilestone(50, true, false)).toBeNull();
    expect(getPlaybackMilestone(90, true, false)).toBe(90);
    expect(getPlaybackMilestone(100, true, true)).toBeNull();
    expect(getPlaybackMilestone(95, false, false)).toBe(90);
});
