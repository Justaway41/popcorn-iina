import { expect, test } from "bun:test";

import {
    findChapterCredits,
    findChapterIntro,
    getOverlayAction,
    isInsideIntro,
    NEXT_EPISODE_TAIL_SEC,
    mapAnimeEpisode,
    mapCourEpisode,
    parseAniListRoot,
    parseAniListSequel,
    parseAniSkipInterval,
    parseIntroDbSegment,
    parseKitsuMalId,
    sanitizeSegments,
    seasonEpisodeCounts
} from "./intro";

test("uses a named intro chapter with the next chapter as its end", () => {
    expect(findChapterIntro([
        { title: "Preview", start: 0 },
        { title: "Opening", start: 30 },
        { title: "Episode", start: 120 }
    ])).toEqual({ start: 30, end: 120 });
    expect(findChapterIntro([
        { title: "Opening Theme", start: 30 },
        { title: "Episode", start: 120 }
    ])).toEqual({ start: 30, end: 120 });
    // Names a person typed, not a fixed vocabulary: ED1 and NCOP are ordinary in anime releases.
    expect(findChapterIntro([
        { title: "NCOP", start: 20 },
        { title: "Part A", start: 110 }
    ])).toEqual({ start: 20, end: 110 });
    // Still strict at the start of the name, so a chapter that merely begins with the letters
    // of one is not mistaken for it.
    expect(findChapterIntro([
        { title: "Introduction", start: 30 },
        { title: "Episode", start: 120 }
    ])).toBeNull();
    expect(findChapterIntro([{ title: "OP", start: 30 }])).toBeNull();
});

test("uses named credits chapters through the next chapter or media duration", () => {
    expect(findChapterCredits([
        { title: "Episode", start: 0 },
        { title: "Credits", start: 1200 }
    ], 1500)).toEqual({ start: 1200, end: 1500 });
    expect(findChapterCredits([
        { title: "ED", start: 1200 },
        { title: "Preview", start: 1410 }
    ], 1500)).toEqual({ start: 1200, end: 1410 });
    expect(findChapterCredits([{ title: "Ending Theme", start: 1200 }], 1500))
        .toEqual({ start: 1200, end: 1500 });
    expect(findChapterCredits([
        { title: "ED1", start: 1300 },
        { title: "Preview", start: 1400 }
    ], 1500)).toEqual({ start: 1300, end: 1400 });
    // An endcard is not the ending song.
    expect(findChapterCredits([{ title: "Endcard", start: 1200 }], 1500)).toBeNull();
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
    const segments = { intro: { start: 10, end: 100 }, recap: null, credits: { start: 90, end: 150 } };
    expect(getOverlayAction(95, segments, true)).toBe("intro");
    expect(getOverlayAction(120, segments, true)).toBe("next");
    expect(getOverlayAction(120, segments, false)).toBeNull();
    expect(getOverlayAction(160, segments, true)).toBeNull();
});

test("offers Skip Recap ahead of the intro that follows it", () => {
    const segments = {
        intro: { start: 100, end: 190 },
        recap: { start: 10, end: 100 },
        credits: null
    };
    expect(getOverlayAction(50, segments, true)).toBe("recap");
    expect(getOverlayAction(100, segments, true)).toBe("intro");
    // overlapping data must not let a recap mask the intro past its own end
    expect(getOverlayAction(150, { ...segments, recap: { start: 10, end: 900 } }, true)).toBe("recap");
});

test("falls back to the tail of the file when no credits interval was found", () => {
    const duration = 3000;
    const bare = { intro: null, recap: null, credits: null };
    expect(getOverlayAction(duration - NEXT_EPISODE_TAIL_SEC - 1, bare, true, duration)).toBeNull();
    expect(getOverlayAction(duration - NEXT_EPISODE_TAIL_SEC, bare, true, duration)).toBe("next");
    // nothing to play next means nothing to offer
    expect(getOverlayAction(duration - 1, bare, false, duration)).toBeNull();
    // credits sitting early in the file are an outro, and do not stop the tail closing the episode
    const withCredits = { ...bare, credits: { start: 100, end: 200 } };
    expect(getOverlayAction(duration - 1, withCredits, true, duration)).toBe("next");
    expect(getOverlayAction(150, withCredits, true, duration)).toBe("credits");
    // short clips are not episodes; the whole file would otherwise be "the tail"
    expect(getOverlayAction(120, bare, true, 130)).toBeNull();
    // an unknown duration must not trigger anything
    expect(getOverlayAction(120, bare, true, 0)).toBeNull();
});

test("offers the skip again after seeking back into an interval already skipped", () => {
    const segments = { intro: { start: 0, end: 32 }, recap: null, credits: null };
    expect(getOverlayAction(10, segments, false)).toBe("intro");
    // skipping seeks just past the end, so the control falls away on its own
    expect(getOverlayAction(32.5, segments, false)).toBeNull();
    // and the interval must survive that, or rewinding leaves nothing to offer
    expect(getOverlayAction(10, segments, false)).toBe("intro");
});

test("reads an IntroDB segment, treating an absent one as no data", () => {
    // captured from api.introdb.app for Dark S01E01
    const dark = {
        imdb_id: "tt5753856",
        season: 1,
        episode: 1,
        intro: { start_sec: 192, end_sec: 276, start_ms: 192000, end_ms: 276000, confidence: 1, submission_count: 1 },
        recap: null,
        outro: { start_sec: 2907, end_sec: 3092, start_ms: 2907000, end_ms: 3092000, confidence: 1, submission_count: 1 }
    };
    expect(parseIntroDbSegment(dark, "intro")).toEqual({ start: 192, end: 276 });
    expect(parseIntroDbSegment(dark, "outro")).toEqual({ start: 2907, end: 3092 });
    expect(parseIntroDbSegment(dark, "recap")).toBeNull();
    // fractional seconds are real: Game of Thrones S01E01 outro
    expect(parseIntroDbSegment({ outro: { start_sec: 3631.5, end_sec: 3699.5 } }, "outro"))
        .toEqual({ start: 3631.5, end: 3699.5 });
    // an intro starting at zero is valid, as on Friends
    expect(parseIntroDbSegment({ intro: { start_sec: 0, end_sec: 47 } }, "intro"))
        .toEqual({ start: 0, end: 47 });
    // an unknown title still answers 200 with nulls rather than 404
    expect(parseIntroDbSegment({ imdb_id: "tt9999999", intro: null, recap: null, outro: null }, "intro"))
        .toBeNull();
    expect(parseIntroDbSegment({ intro: { start_sec: 200, end_sec: 100 } }, "intro")).toBeNull();
    expect(parseIntroDbSegment({ intro: { start_sec: -5, end_sec: 100 } }, "intro")).toBeNull();
    expect(parseIntroDbSegment({ intro: { end_sec: 100 } }, "intro")).toBeNull();
    expect(parseIntroDbSegment(null, "intro")).toBeNull();
});

test("rejects skip intervals that would seek out of the episode", () => {
    const intro = { start: 30, end: 120 };
    const credits = { start: 1400, end: 1440 };
    // a rip chaptered only "Intro" then "Credits" makes the whole episode look like an intro
    expect(sanitizeSegments({ intro: { start: 0, end: 1400 }, recap: null, credits }, 1440))
        .toEqual({ intro: null, recap: null, credits });
    // nor may a skip land in the tail, where it would offer Next Episode instead of the episode
    expect(sanitizeSegments({ intro: { start: 1300, end: 1400 }, recap: null, credits: null }, 1440))
        .toEqual({ intro: null, recap: null, credits: null });
    expect(sanitizeSegments({ intro, recap: { start: 0, end: 30 }, credits }, 1440))
        .toEqual({ intro, recap: { start: 0, end: 30 }, credits });
    // credits legitimately run to the end of the file
    expect(sanitizeSegments({ intro, recap: null, credits: { start: 1400, end: 1500 } }, 1440))
        .toEqual({ intro, recap: null, credits: null });
    // an unknown duration cannot rule anything out beyond the length of the segment itself
    expect(sanitizeSegments({ intro, recap: null, credits }, 0))
        .toEqual({ intro, recap: null, credits });
});

test("an ending song inside the episode is an outro to skip, not the end of the episode", () => {
    const duration = 1440;
    // A 24 minute episode whose ED runs 19:00-20:30, with a scene after it.
    const segments = { intro: null, recap: null, credits: { start: 1140, end: 1230 } };

    expect(getOverlayAction(1200, segments, true, duration)).toBe("credits");
    // Past the outro the episode carries on, so nothing is offered until the tail.
    expect(getOverlayAction(1250, segments, true, duration)).toBeNull();
    // The end of the file still offers the next episode, which credits used to suppress.
    expect(getOverlayAction(1400, segments, true, duration)).toBe("next");

    // Credits that run to the end of the file are the end of the episode, as before.
    const ending = { intro: null, recap: null, credits: { start: 1380, end: 1440 } };
    expect(getOverlayAction(1400, ending, true, duration)).toBe("next");

    // Without a duration there is no inside to be past, so credits stay the end.
    expect(getOverlayAction(1200, segments, true, 0)).toBe("next");
    // Skipping an outro seeks inside this file, so it does not wait for a next episode to load.
    expect(getOverlayAction(1200, segments, false, duration)).toBe("credits");
    // Leaving the episode does need one.
    expect(getOverlayAction(1400, segments, false, duration)).toBeNull();
    expect(getOverlayAction(1400, ending, false, duration)).toBeNull();
});

test("credits too long to be an ending song are not offered as a skip", () => {
    // A chapter named "Ending" with nothing after it until far later swallows the episode.
    const segments = { intro: null, recap: null, credits: { start: 60, end: 1000 } };

    expect(getOverlayAction(300, segments, true, 1440)).toBeNull();
    expect(getOverlayAction(1400, segments, true, 1440)).toBe("next");
});

const search = (media: unknown[]) => ({ data: { Page: { media } } });
const tv = (id: number, idMal: number, year: number, episodes: number | null, english: string, extra: Record<string, unknown> = {}) => ({
    id, idMal, format: "TV", episodes, startDate: { year, month: 4 }, synonyms: [], title: { english, romaji: english }, ...extra
});

test("finds the first cour of the franchise a title names, and only for a title it knows", () => {
    // Copied shape of a live search: the search ranks a sequel above the first season.
    const bleach = search([
        tv(2, 53998, 2023, 13, "BLEACH: Thousand-Year Blood War - The Separation"),
        tv(1, 41467, 2022, 13, "BLEACH: Thousand-Year Blood War"),
        tv(3, 56784, 2024, 14, "BLEACH: Thousand-Year Blood War - The Conflict")
    ]);
    expect(parseAniListRoot(bleach, "Bleach: Thousand-Year Blood War")).toEqual({ anilistId: 1, malId: "41467", episodes: 13 });

    // A spin-off shares the leading words but the first season is earlier, so it is the root.
    const titan = search([
        tv(5, 31374, 2015, 12, "Attack on Titan: Junior High"),
        tv(4, 16498, 2013, 25, "Attack on Titan"),
        { ...tv(6, 42091, 2020, 1, "Attack on Titan ~Chronicle~"), format: "MOVIE" }
    ]);
    expect(parseAniListRoot(titan, "Attack on Titan")?.malId).toBe("16498");
    // Romaji and synonyms count as the title too; punctuation and case do not.
    expect(parseAniListRoot(search([tv(7, 16498, 2013, 25, "Attack on Titan", { title: { english: "Attack on Titan", romaji: "Shingeki no Kyojin" } })]), "SHINGEKI NO KYOJIN")?.malId).toBe("16498");
    expect(parseAniListRoot(search([tv(8, 52991, 2023, 28, "Frieren: Beyond Journey\u2019s End")]), "Frieren: Beyond Journey's End")?.malId).toBe("52991");

    // A search answers something for any words at all; without a matching title it is not anime.
    expect(parseAniListRoot(search([tv(9, 1, 2001, 12, "Office Ladies Anime")]), "The Office")).toBeNull();
    expect(parseAniListRoot(search([{ ...tv(10, 21, 1999, null, "ONE PIECE"), idMal: null }]), "One Piece")).toBeNull();
    expect(parseAniListRoot({ errors: [{ message: "Too Many Requests" }] }, "One Piece")).toBeNull();
    expect(parseAniListRoot(null, "")).toBeNull();
});

test("follows the earliest sequel that is itself a run of episodes", () => {
    const relations = (edges: unknown[]) => ({ data: { Media: { relations: { edges } } } });
    expect(parseAniListSequel(relations([
        { relationType: "SIDE_STORY", node: tv(20, 31374, 2015, 12, "Junior High") },
        { relationType: "SEQUEL", node: { ...tv(21, 36702, 2018, 1, "Roar of Awakening"), format: "MOVIE" } },
        { relationType: "SEQUEL", node: tv(22, 35760, 2018, 12, "Season 3") },
        { relationType: "PREQUEL", node: tv(23, 16498, 2013, 25, "Season 1") }
    ]))).toEqual({ anilistId: 22, malId: "35760", episodes: 12 });
    // An airing cour reports no episode count yet.
    expect(parseAniListSequel(relations([{ relationType: "SEQUEL", node: tv(24, 61316, 2026, null, "Season 4") }])))
        .toEqual({ anilistId: 24, malId: "61316", episodes: null });
    expect(parseAniListSequel(relations([]))).toBeNull();
    expect(parseAniListSequel({ errors: [] })).toBeNull();
});

test("counts a series' episodes per season, leaving specials out", () => {
    const episodes = [
        { season: 1, episode: 1 }, { season: 1, episode: 2 }, { season: 0, episode: 1 },
        { season: 2, episode: 1 }, { season: 2, episode: 2 }, { season: 2, episode: 3 }
    ];
    expect(seasonEpisodeCounts(episodes)).toEqual([{ season: 1, count: 2 }, { season: 2, count: 3 }]);
    expect(seasonEpisodeCounts([])).toEqual([]);
});

test("places a Cinemeta season and episode in the cour AniSkip keys by", () => {
    const entry = (malId: string, episodes: number | null) => ({ anilistId: Number(malId), malId, episodes });
    // Attack on Titan: Cinemeta season 3 is 22 episodes, MAL has it as 12 + 10.
    const titan = [entry("16498", 25), entry("25777", 12), entry("35760", 12), entry("38524", 10), entry("40028", 16), entry("48583", 12)];
    const titanSeasons = [{ season: 1, count: 25 }, { season: 2, count: 12 }, { season: 3, count: 22 }, { season: 4, count: 28 }];
    expect(mapAnimeEpisode(titanSeasons, titan, 1, 21)).toEqual({ malId: "16498", episode: 21 });
    expect(mapAnimeEpisode(titanSeasons, titan, 3, 12)).toEqual({ malId: "35760", episode: 12 });
    expect(mapAnimeEpisode(titanSeasons, titan, 3, 15)).toEqual({ malId: "38524", episode: 3 });
    expect(mapAnimeEpisode(titanSeasons, titan, 4, 20)).toEqual({ malId: "48583", episode: 4 });
    // Past everything the chain covers there is nothing to ask for.
    expect(mapAnimeEpisode(titanSeasons, titan, 4, 29)).toBeNull();
    expect(mapAnimeEpisode(titanSeasons, titan, 5, 1)).toBeNull();

    // One cour give or take a special is that cour, so the specials do not shift later seasons.
    const seasonsWithSpecial = [{ season: 1, count: 26 }, { season: 2, count: 12 }];
    expect(mapAnimeEpisode(seasonsWithSpecial, titan, 2, 1)).toEqual({ malId: "25777", episode: 1 });
    // One cour split across two Cinemeta seasons continues its numbering.
    const split = [{ season: 1, count: 13 }, { season: 2, count: 12 }];
    expect(mapAnimeEpisode(split, [entry("31240", 25)], 2, 1)).toEqual({ malId: "31240", episode: 14 });
    // An airing cour with no count yet covers the rest of its season.
    expect(mapAnimeEpisode([{ season: 1, count: 1100 }], [entry("21", null)], 1, 1000)).toEqual({ malId: "21", episode: 1000 });
    expect(mapAnimeEpisode([], titan, 1, 1)).toBeNull();
});

test("reads a cour episode back onto the season the sidebar draws", () => {
    const entry = (malId: string, episodes: number | null) => ({ anilistId: Number(malId), malId, episodes });
    // Bleach: Thousand-Year Blood War. Simkl files every cour as its own show numbered from
    // one, so "episode 6 of MAL 56784" is the sidebar's season 3 episode 6.
    const bleach = [entry("41467", 13), entry("53998", 13), entry("56784", 14), entry("62651", 10)];
    const bleachSeasons = [
        { season: 1, count: 13 },
        { season: 2, count: 13 },
        { season: 3, count: 14 },
        { season: 4, count: 10 }
    ];
    expect(mapCourEpisode(bleachSeasons, bleach, "56784", 6)).toEqual({ season: 3, episode: 6 });
    expect(mapCourEpisode(bleachSeasons, bleach, "41467", 13)).toEqual({ season: 1, episode: 13 });
    expect(mapCourEpisode(bleachSeasons, bleach, "53998", 1)).toEqual({ season: 2, episode: 1 });
    // Nothing to place: past the cour's own length, or a cour this show does not contain.
    expect(mapCourEpisode(bleachSeasons, bleach, "56784", 15)).toBeNull();
    expect(mapCourEpisode(bleachSeasons, bleach, "16498", 1)).toBeNull();

    // Exact inverse of the forward mapping, including a season split across two MAL entries
    // and a cour split across two Cinemeta seasons.
    const titan = [entry("16498", 25), entry("25777", 12), entry("35760", 12), entry("38524", 10), entry("40028", 16), entry("48583", 12)];
    const titanSeasons = [{ season: 1, count: 25 }, { season: 2, count: 12 }, { season: 3, count: 22 }, { season: 4, count: 28 }];
    for (const [season, episode] of [[1, 21], [3, 12], [3, 15], [4, 20]] as const) {
        const cour = mapAnimeEpisode(titanSeasons, titan, season, episode);
        expect(cour).not.toBeNull();
        expect(mapCourEpisode(titanSeasons, titan, cour?.malId ?? "", cour?.episode ?? 0))
            .toEqual({ season, episode });
    }
    const split = [{ season: 1, count: 13 }, { season: 2, count: 12 }];
    expect(mapCourEpisode(split, [entry("31240", 25)], "31240", 14)).toEqual({ season: 2, episode: 1 });
    expect(mapCourEpisode([], titan, "16498", 1)).toBeNull();
});

test("takes the AniSkip submission nearest the file's runtime, and none for a different cut", () => {
    const response = {
        found: true,
        results: [
            { skipType: "op", episodeLength: 1449, interval: { startTime: 198, endTime: 288 } },
            { skipType: "op", episodeLength: 1463, interval: { startTime: 208, endTime: 298 } },
            { skipType: "ed", episodeLength: 1464, interval: { startTime: 1358, endTime: 1448 } }
        ]
    };
    expect(parseAniSkipInterval(response, "op", 1443)).toEqual({ start: 198, end: 288 });
    expect(parseAniSkipInterval(response, "op", 1470)).toEqual({ start: 208, end: 298 });
    // The one ending submission is 21 seconds off the 1443s file, which AniSkip's own filter
    // rejected; it is well inside a minute and now counts.
    expect(parseAniSkipInterval(response, "ed", 1443)).toEqual({ start: 1358, end: 1448 });
    // Two minutes off is another edit of the episode altogether.
    expect(parseAniSkipInterval(response, "op", 1600)).toBeNull();
    // Without a runtime to compare against, the first valid submission stands, as before.
    expect(parseAniSkipInterval(response, "op")).toEqual({ start: 198, end: 288 });
});
