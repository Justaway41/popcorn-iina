export interface IntroInterval {
    start: number;
    end: number;
}

export interface PlaybackSegments {
    intro: IntroInterval | null;
    recap: IntroInterval | null;
    credits: IntroInterval | null;
}

export type OverlayAction = "recap" | "intro" | "credits" | "next";

/**
 * How long before the end of a file Next Episode appears when no credits interval was found.
 * Only a fallback: a real interval from chapters, AniSkip, or IntroDB always wins.
 */
export const NEXT_EPISODE_TAIL_SEC = 60;

/** Below this, a file is a clip rather than an episode and the tail would cover most of it. */
const MIN_TAIL_DURATION_SEC = 300;

/**
 * Chapter names are whatever the person who encoded the file typed. Exact-match patterns missed
 * everything but the four most literal spellings, so `Ending Song`, `ED1`, and `NCED` - all
 * ordinary in anime releases - left the file looking as though it had no marked segments at all.
 * Deliberately still strict at the start of the name: `Endcard` and `Introduction` are not these.
 */
const INTRO_CHAPTER = /^(?:intro|opening|avant)\b|^(?:nc)?op\s*\d*$/i;
const CREDITS_CHAPTER = /^(?:ending|credits|outro|end\s*credits)\b|^(?:nc)?ed\s*\d*$/i;

export function findChapterIntro(
    chapters: Array<{ title: string; start: number }>
): IntroInterval | null {
    return findChapterInterval(chapters, INTRO_CHAPTER);
}

export function findChapterCredits(
    chapters: Array<{ title: string; start: number }>,
    duration: number
): IntroInterval | null {
    return findChapterInterval(
        chapters,
        CREDITS_CHAPTER,
        Number.isFinite(duration) && duration > 0 ? duration : null
    );
}

function findChapterInterval(
    chapters: Array<{ title: string; start: number }>,
    names: RegExp,
    fallbackEnd: number | null = null
): IntroInterval | null {
    const sorted = chapters
        .filter((chapter) => Number.isFinite(chapter.start))
        .sort((a, b) => a.start - b.start);
    const index = sorted.findIndex((chapter) => names.test(chapter.title.trim()));
    if (index === -1) return null;
    const next = sorted.slice(index + 1).find((chapter) => chapter.start > sorted[index].start);
    const end = next?.start ?? fallbackEnd;
    return end !== null && end > sorted[index].start
        ? { start: sorted[index].start, end }
        : null;
}

export function parseKitsuMalId(value: unknown): string {
    const data = record(value)?.data;
    if (!Array.isArray(data)) return "";
    for (const entry of data) {
        const attributes = record(record(entry)?.attributes);
        if (attributes?.externalSite === "myanimelist/anime") {
            const id = stringValue(attributes.externalId);
            if (/^\d+$/.test(id)) return id;
        }
    }
    return "";
}

/**
 * The MyAnimeList id ani.zip maps an IMDb id onto. AniSkip is keyed by MAL id alone, so an anime
 * opened through Cinemeta - which knows only IMDb ids - had no way to reach it and never got
 * intro or outro timings. A non-anime IMDb id simply maps to nothing.
 */
export function parseAniZipMalId(value: unknown): string {
    const id = record(record(value)?.mappings)?.mal_id;
    return typeof id === "number" && Number.isInteger(id) && id > 0 ? String(id) : "";
}

export function parseAniSkipInterval(
    value: unknown,
    skipType: "op" | "ed" = "op"
): IntroInterval | null {
    const response = record(value);
    if (response?.found !== true || !Array.isArray(response.results)) return null;
    for (const result of response.results) {
        const item = record(result);
        if (item?.skipType !== skipType) continue;
        const interval = record(item.interval);
        const start = numberValue(interval?.startTime);
        const end = numberValue(interval?.endTime);
        if (start !== null && end !== null && start >= 0 && start < end) return { start, end };
    }
    return null;
}

/**
 * IntroDB answers 200 with a null segment rather than 404 when it holds nothing for an episode,
 * so an absent segment is ordinary and must read as "no data", never as an error.
 */
export function parseIntroDbSegment(
    value: unknown,
    type: "intro" | "recap" | "outro"
): IntroInterval | null {
    const segment = record(record(value)?.[type]);
    const start = numberValue(segment?.start_sec);
    const end = numberValue(segment?.end_sec);
    return start !== null && end !== null && start >= 0 && start < end ? { start, end } : null;
}

export function isInsideIntro(time: number, interval: IntroInterval | null): boolean {
    return Boolean(interval && Number.isFinite(time) && time >= interval.start && time < interval.end);
}

function isInsideTail(time: number, duration: number): boolean {
    if (!Number.isFinite(time) || !Number.isFinite(duration)) return false;
    if (duration < MIN_TAIL_DURATION_SEC) return false;
    return time >= duration - NEXT_EPISODE_TAIL_SEC;
}

export function getOverlayAction(
    time: number,
    segments: PlaybackSegments,
    nextReady: boolean,
    duration = 0
): OverlayAction | null {
    // A recap runs before the intro, so it is offered first.
    if (isInsideIntro(time, segments.recap)) return "recap";
    if (isInsideIntro(time, segments.intro)) return "intro";
    const credits = segments.credits;
    if (credits && isInsideIntro(time, credits)) {
        // An ending song the episode plays past is an outro to skip, not the end of the episode.
        // Offering Next Episode there ended a file that still had a scene left in it.
        if (!endsEpisode(credits, duration)) {
            // Skipping an outro is a seek inside this file, so unlike Next Episode it needs
            // nothing loaded and must still be offered when no next episode is ready.
            // Too long to be an ending song is bad data: seeking to the end of such an interval
            // would drop the viewer somewhere arbitrary, so offer nothing instead.
            return credits.end - credits.start <= MAX_SKIP_SEGMENT_SEC ? "credits" : null;
        }
        return nextReady ? "next" : null;
    }
    // Stands in when no credits interval was supplied, and closes out an episode that played on
    // past its outro.
    return nextReady && isInsideTail(time, duration) ? "next" : null;
}

/** Whether credits run to the end of the file rather than sitting inside the episode. */
function endsEpisode(credits: IntroInterval, duration: number): boolean {
    if (!Number.isFinite(duration) || duration <= 0) return true;
    return credits.end > duration - NEXT_EPISODE_TAIL_SEC;
}

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The longest an intro or recap can plausibly run. A rip chaptered only "Intro" then "Credits"
 * yields an interval that swallows the whole episode, and skipping it lands on the end of the
 * file - which reads as the episode simply ending.
 */
const MAX_SKIP_SEGMENT_SEC = 300;

/** Drops interval data that would seek the viewer out of the episode rather than past a segment. */
export function sanitizeSegments(found: PlaybackSegments, duration: number): PlaybackSegments {
    const known = Number.isFinite(duration) && duration > 0;
    const inFile = (interval: IntroInterval | null) =>
        interval && (!known || interval.end <= duration) ? interval : null;
    const skippable = (interval: IntroInterval | null) => {
        const inside = inFile(interval);
        if (!inside || inside.end - inside.start > MAX_SKIP_SEGMENT_SEC) return null;
        // Landing inside the tail would immediately offer Next Episode instead of the episode.
        return !known || inside.end <= duration - NEXT_EPISODE_TAIL_SEC ? inside : null;
    };
    return { intro: skippable(found.intro), recap: skippable(found.recap), credits: inFile(found.credits) };
}
