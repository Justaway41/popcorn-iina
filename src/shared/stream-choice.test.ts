import { expect, test } from "bun:test";

import {
    filterStreamsToShow,
    pickNextEpisodeStream,
    releaseTokens
} from "./stream-choice";
import { normalizeLanguage, parsePlayableStreams } from "./stremio";

test("recommends the resolution being played, then the highest available", () => {
    const streams = [
        { title: "720", resolution: "720p", cached: null, audioLanguages: [], subtitleLanguages: null },
        { title: "1080 first", resolution: "1080p", cached: null, audioLanguages: [], subtitleLanguages: null },
        { title: "1080 second", resolution: "1080p", cached: null, audioLanguages: [], subtitleLanguages: null },
        { title: "4K", resolution: "2160p", cached: null, audioLanguages: [], subtitleLanguages: null },
        { title: "Unknown", resolution: "", cached: null, audioLanguages: [], subtitleLanguages: null }
    ];
    const options = { previousResolution: "" };
    expect(pickNextEpisodeStream(streams, { ...options, previousResolution: "1080p" })?.title).toBe("1080 first");
    expect(pickNextEpisodeStream(streams, { ...options, previousResolution: "720p" })?.title).toBe("720");
    // Nothing matches what was playing, so the best on offer wins rather than the nearest below it.
    expect(pickNextEpisodeStream(streams, { ...options, previousResolution: "1440p" })?.title).toBe("4K");
    expect(pickNextEpisodeStream(streams, { ...options, previousResolution: "900p" })?.title).toBe("4K");
    expect(pickNextEpisodeStream(streams, options)?.title).toBe("4K");
    expect(pickNextEpisodeStream([{ ...streams[4] }], { previousResolution: "1080p" })).toBeNull();
});

test("next-episode pick prefers cache, then audio, then subtitles, then resolution", () => {
    const base = { resolution: "1080p", subtitleLanguages: null as string[] | null };
    const streams = [
        { ...base, title: "uncached english", cached: false, audioLanguages: ["English"] },
        { ...base, title: "cached other", cached: true, audioLanguages: ["Japanese"] },
        { ...base, title: "cached english", cached: true, audioLanguages: ["English"] }
    ];
    expect(pickNextEpisodeStream(streams, {
        previousResolution: "1080p",
        preferredAudio: "english"
    })?.title).toBe("cached english");

    // unknown audio stays neutral: it beats a known mismatch, never a known match
    const unknownAudio = [
        { ...base, title: "unreported", cached: true, audioLanguages: [] },
        { ...base, title: "japanese", cached: true, audioLanguages: ["Japanese"] }
    ];
    expect(pickNextEpisodeStream(unknownAudio, {
        previousResolution: "1080p",
        preferredAudio: "English"
    })?.title).toBe("unreported");

    // subtitle preference applies the same way, with unknown (null) neutral
    const subtitles = [
        { ...base, title: "no subs reported", cached: true, audioLanguages: [], subtitleLanguages: null },
        { ...base, title: "polish", cached: true, audioLanguages: [], subtitleLanguages: ["Polish"] },
        { ...base, title: "english subs", cached: true, audioLanguages: [], subtitleLanguages: ["English"] }
    ];
    expect(pickNextEpisodeStream(subtitles, {
        previousResolution: "1080p",
        preferredSubtitle: "English"
    })?.title).toBe("english subs");

    // without preferences the old behavior stands: cache first, then closest resolution
    const noPrefs = [
        { ...base, title: "cached 720", cached: true, resolution: "720p", audioLanguages: [], subtitleLanguages: null },
        { ...base, title: "uncached 1080", cached: false, audioLanguages: [], subtitleLanguages: null }
    ];
    expect(pickNextEpisodeStream(noPrefs, { previousResolution: "1080p" })?.title).toBe("cached 720");
});

test("a release naming no audio language is unknown, not a mismatch", () => {
    const base = { resolution: "1080p", cached: null, subtitleLanguages: null as string[] | null };
    const streams = [
        { ...base, title: "japanese", audioLanguages: ["Japanese"] },
        { ...base, title: "dual audio", audioLanguages: ["Dual Audio"] },
        { ...base, title: "silent", audioLanguages: [] }
    ];

    // Dual Audio very likely carries English, so it must not rank below a stream that says nothing.
    expect(pickNextEpisodeStream(streams, {
        previousResolution: "1080p",
        preferredAudio: "english"
    })?.title).toBe("dual audio");

    // Naming a language it does not have still counts against it.
    expect(pickNextEpisodeStream(
        [streams[0], streams[1]],
        { previousResolution: "1080p", preferredAudio: "english" }
    )?.title).toBe("dual audio");

    // An explicit match still beats every unnamed release.
    expect(pickNextEpisodeStream(
        [...streams, { ...base, title: "english", audioLanguages: ["English"] }],
        { previousResolution: "1080p", preferredAudio: "english" }
    )?.title).toBe("english");
});

test("keeps the next episode in the release already playing", () => {
    // One IMDb id, three different shows: an addon answers Gintama with its spin-offs too, and
    // every one of them has an episode 11, so the episode number cannot tell them apart.
    const base = { cached: true, audioLanguages: [] as string[], subtitleLanguages: null as string[] | null };
    const streams = [
        { ...base, resolution: "1080p", rawTitle: "[ReinForce] Gintama. 11 (BDRip 1920x1080 x264 FLAC).mkv" },
        { ...base, resolution: "1080p", rawTitle: "GINTAMA.Mr..Ginpachis.Zany.Class.S01E11.1080p.NF.WEB-DL.JPN.mkv" },
        { ...base, resolution: "1080p", rawTitle: "[Mattmurdock] Gintama - 011 (BD 1080p HEVC Opus)[92F1F8B3].mkv" },
        { ...base, resolution: "720p", rawTitle: "[AnimeRG] Gintama - 011 [720p] [x265] [pseudo].mkv" }
    ];
    const pick = (previousRelease: string) => pickNextEpisodeStream(streams, {
        previousResolution: "1080p",
        previousRelease
    })?.rawTitle;

    // The checksum differs on every episode, so matching cannot require an identical name.
    expect(pick("[Mattmurdock] Gintama - 010 (BD 1080p HEVC Opus)[A1B2C3D4].mkv"))
        .toBe("[Mattmurdock] Gintama - 011 (BD 1080p HEVC Opus)[92F1F8B3].mkv");
    // Staying with the release outranks quality: this one is only 720p.
    expect(pick("[AnimeRG] Gintama - 010 [720p] [x265] [pseudo].mkv"))
        .toBe("[AnimeRG] Gintama - 011 [720p] [x265] [pseudo].mkv");
    expect(pick("[ReinForce] Gintama. 10 (BDRip 1920x1080 x264 FLAC).mkv"))
        .toBe("[ReinForce] Gintama. 11 (BDRip 1920x1080 x264 FLAC).mkv");

    // An opaque or missing filename is no signal at all and must not rank anything down.
    expect(pick("")).toBe(streams[0].rawTitle);
    expect(pick("a7f3e91c2b.mkv")).toBe(streams[0].rawTitle);
});

test("release continuity ignores numbers and file extensions", () => {
    expect([...releaseTokens("[AnimeRG] Gintama - 011 [720p] [x265] [pseudo].mkv")])
        .toEqual(["animerg", "gintama", "pseudo"]);
    // Episode number apart, consecutive episodes of one release read identically.
    expect([...releaseTokens("Gintama s01e10.1080P Aac Ita Jpn Web-Dl x264.mkv")])
        .toEqual([...releaseTokens("Gintama s01e11.1080P Aac Ita Jpn Web-Dl x264.mkv")]);
});

test("rejects a stream the addon parsed as a different show", () => {
    // Gintama's spin-offs share its IMDb id and each has an episode 11, so only the parsed
    // title separates them - and the spin-off is the cached, higher quality one.
    const base = { audioLanguages: [] as string[], subtitleLanguages: null as string[] | null };
    const streams = [
        { ...base, rawTitle: "spinoff", showTitle: "Gintama Mr Ginpachis Zany Class", resolution: "2160p", cached: true },
        { ...base, rawTitle: "main", showTitle: "Gintama", resolution: "720p", cached: false }
    ];
    expect(pickNextEpisodeStream(streams, { showTitle: "Gintama" })?.rawTitle).toBe("main");

    // With no show to compare against, nothing is rejected.
    expect(pickNextEpisodeStream(streams, {})?.rawTitle).toBe("spinoff");
    // A stream whose title the formatter did not expose stays eligible.
    const unknown = [{ ...base, rawTitle: "unlabelled", showTitle: "", resolution: "2160p", cached: true }, streams[1]];
    expect(pickNextEpisodeStream(unknown, { showTitle: "Gintama" })?.rawTitle).toBe("unlabelled");
});

test("hides streams for other shows sharing the IMDb id, unless that would empty the list", () => {
    const streams = [
        { rawTitle: "main", showTitle: "Gintama" },
        { rawTitle: "spinoff", showTitle: "Gintama Mr Ginpachis Zany Class" },
        { rawTitle: "porori", showTitle: "Gintama. Porori-hen (2006-2021)" },
        { rawTitle: "unlabelled", showTitle: "" }
    ];

    // Unknown titles stay: the formatter simply did not expose one.
    expect(filterStreamsToShow(streams, "Gintama").map((s) => s.rawTitle))
        .toEqual(["main", "unlabelled"]);
    // Punctuation and case cannot split a match.
    expect(filterStreamsToShow(streams, "GINTAMA!").map((s) => s.rawTitle))
        .toEqual(["main", "unlabelled"]);

    // An addon that romanizes the title matches nothing, and must leave the list whole rather
    // than hand back an empty stream screen.
    const romanized = [
        { rawTitle: "a", showTitle: "Shingeki no Kyojin" },
        { rawTitle: "b", showTitle: "Shingeki no Kyojin" }
    ];
    expect(filterStreamsToShow(romanized, "Attack on Titan").map((s) => s.rawTitle)).toEqual(["a", "b"]);
    // No show to compare against changes nothing.
    expect(filterStreamsToShow(streams, "")).toHaveLength(4);
});

test("keeps streams visible to next-episode matching when only the title names a source", () => {
    // Previously `quality` held "WEBRip" for these, qualityHeight() returned null, and
    // next-episode matching dropped every one of them - so no next episode was offered.
    const streams = parsePlayableStreams({
        streams: [
            {
                url: "https://cdn.example/a.mkv",
                behaviorHints: { filename: "Dark.S03E04.1080p.WEBRip.x264-ION10.mkv" }
            },
            {
                url: "https://cdn.example/b.mkv",
                behaviorHints: { filename: "Dark.S03E04.2160p.WEBRip.DV.HDR10.mkv" }
            }
        ]
    });
    expect(pickNextEpisodeStream(streams, { previousResolution: "1080p" })?.resolution).toBe("1080p");
});

test("normalizes track language tags onto parsed release language names", () => {
    expect(normalizeLanguage("jpn")).toBe("Japanese");
    expect(normalizeLanguage("eng")).toBe("English");
    expect(normalizeLanguage("Japanese")).toBe("Japanese");
    expect(normalizeLanguage("")).toBe("");
    // A tag no alias covers is kept rather than guessed at, so it can still match a release.
    expect(normalizeLanguage("nor")).toBe("NOR");

    // The point of the mapping: a track tagged jpn must select a release labelled Japanese.
    const base = { resolution: "1080p", cached: null, subtitleLanguages: null as string[] | null };
    const streams = [
        { ...base, title: "english dub", audioLanguages: ["English"] },
        { ...base, title: "japanese", audioLanguages: ["Japanese"] }
    ];
    expect(pickNextEpisodeStream(streams, {
        previousResolution: "1080p",
        preferredAudio: normalizeLanguage("jpn").toLowerCase()
    })?.title).toBe("japanese");
});
