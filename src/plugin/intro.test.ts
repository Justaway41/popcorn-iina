import { expect, test } from "bun:test";

import {
    findChapterCredits,
    findChapterIntro,
    getOverlayAction,
    isInsideIntro,
    parseAniSkipInterval,
    parseKitsuMalId
} from "./intro";

test("uses an exact named intro chapter with the next chapter as its end", () => {
    expect(findChapterIntro([
        { title: "Preview", start: 0 },
        { title: "Opening", start: 30 },
        { title: "Episode", start: 120 }
    ])).toEqual({ start: 30, end: 120 });
    expect(findChapterIntro([
        { title: "Opening Theme", start: 30 },
        { title: "Episode", start: 120 }
    ])).toBeNull();
    expect(findChapterIntro([{ title: "OP", start: 30 }])).toBeNull();
});

test("uses exact credits chapters through the next chapter or media duration", () => {
    expect(findChapterCredits([
        { title: "Episode", start: 0 },
        { title: "Credits", start: 1200 }
    ], 1500)).toEqual({ start: 1200, end: 1500 });
    expect(findChapterCredits([
        { title: "ED", start: 1200 },
        { title: "Preview", start: 1410 }
    ], 1500)).toEqual({ start: 1200, end: 1410 });
    expect(findChapterCredits([{ title: "Ending Theme", start: 1200 }], 1500)).toBeNull();
    expect(findChapterCredits([{ title: "Outro", start: 1200 }], 0)).toBeNull();
});

test("extracts only a MyAnimeList anime mapping from Kitsu", () => {
    expect(parseKitsuMalId({ data: [
        { attributes: { externalSite: "anilist/anime", externalId: "154587" } },
        { attributes: { externalSite: "myanimelist/anime", externalId: "52991" } }
    ] })).toBe("52991");
    expect(parseKitsuMalId({ data: [{ attributes: { externalSite: "myanimelist/manga", externalId: "1" } }] }))
        .toBe("");
});

test("accepts only a finite positive AniSkip opening interval", () => {
    expect(parseAniSkipInterval({
        found: true,
        results: [{ skipType: "op", interval: { startTime: 116.748, endTime: 206.748 } }]
    })).toEqual({ start: 116.748, end: 206.748 });
    expect(parseAniSkipInterval({
        found: true,
        results: [{ skipType: "ed", interval: { startTime: 100, endTime: 200 } }]
    })).toBeNull();
    expect(parseAniSkipInterval({
        found: true,
        results: [{ skipType: "op", interval: { startTime: 200, endTime: 100 } }]
    })).toBeNull();
});

test("selects an AniSkip ending interval when requested", () => {
    const response = {
        found: true,
        results: [
            { skipType: "op", interval: { startTime: 100, endTime: 200 } },
            { skipType: "ed", interval: { startTime: 1320, endTime: 1410 } }
        ]
    };
    expect(parseAniSkipInterval(response, "ed")).toEqual({ start: 1320, end: 1410 });
});

test("shows the control from the intro start until just before its end", () => {
    const interval = { start: 10, end: 100 };
    expect(isInsideIntro(9.99, interval)).toBe(false);
    expect(isInsideIntro(10, interval)).toBe(true);
    expect(isInsideIntro(99.99, interval)).toBe(true);
    expect(isInsideIntro(100, interval)).toBe(false);
});

test("prioritizes Skip Intro over a ready Next Episode action", () => {
    const intro = { start: 10, end: 100 };
    const credits = { start: 90, end: 150 };
    expect(getOverlayAction(95, intro, credits, true)).toBe("intro");
    expect(getOverlayAction(120, intro, credits, true)).toBe("next");
    expect(getOverlayAction(120, intro, credits, false)).toBeNull();
    expect(getOverlayAction(160, intro, credits, true)).toBeNull();
});
