export interface IntroInterval {
    start: number;
    end: number;
}

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

export function isInsideIntro(time: number, interval: IntroInterval | null): boolean {
    return Boolean(interval && Number.isFinite(time) && time >= interval.start && time < interval.end);
}

export function getOverlayAction(
    time: number,
    intro: IntroInterval | null,
    credits: IntroInterval | null,
    nextReady: boolean
): "intro" | "next" | null {
    if (isInsideIntro(time, intro)) return "intro";
    if (nextReady && isInsideIntro(time, credits)) return "next";
    return null;
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
