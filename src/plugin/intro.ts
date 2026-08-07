export interface IntroInterval {
    start: number;
    end: number;
}

export interface PlaybackSegments {
    intro: IntroInterval | null;
    recap: IntroInterval | null;
    credits: IntroInterval | null;
}

export type OverlayAction = "recap" | "intro" | "next";

/**
 * How long before the end of a file Next Episode appears when no credits interval was found.
 * Only a fallback: a real interval from chapters, AniSkip, or IntroDB always wins.
 */
export const NEXT_EPISODE_TAIL_SEC = 60;

/** Below this, a file is a clip rather than an episode and the tail would cover most of it. */
const MIN_TAIL_DURATION_SEC = 300;

export function findChapterIntro(
    chapters: Array<{ title: string; start: number }>
): IntroInterval | null {
    return findChapterInterval(chapters, /^(intro|opening|op)$/i);
}

export function findChapterCredits(
    chapters: Array<{ title: string; start: number }>,
    duration: number
): IntroInterval | null {
    return findChapterInterval(
        chapters,
        /^(ending|credits|outro|ed)$/i,
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
    if (!nextReady) return null;
    if (isInsideIntro(time, segments.credits)) return "next";
    // Only stand in for a credits interval that no source supplied.
    return !segments.credits && isInsideTail(time, duration) ? "next" : null;
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
