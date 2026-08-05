import { expect, test } from "bun:test";

import {
    findChapterIntro,
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

test("shows the control from the intro start until just before its end", () => {
    const interval = { start: 10, end: 100 };
    expect(isInsideIntro(9.99, interval)).toBe(false);
    expect(isInsideIntro(10, interval)).toBe(true);
    expect(isInsideIntro(99.99, interval)).toBe(true);
    expect(isInsideIntro(100, interval)).toBe(false);
});
