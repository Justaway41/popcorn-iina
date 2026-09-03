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

/** One cour of an anime as AniList lists it: the unit AniSkip keys its timings by. */
export interface AnimeEntry {
    anilistId: number;
    malId: string;
    /** Null while airing; the entry then covers whatever remains of its season. */
    episodes: number | null;
}

/** Formats that are a run of episodes. Films, OVAs, and specials are not cours of the show. */
const ANIME_SERIES_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);

/**
 * A Cinemeta season this close in length to a cour is that cour: the difference is a recap or
 * special one side counts and the other does not, and letting it shift every later season by
 * that much would put each of them one or two episodes off.
 */
const SEASON_SNAP_TOLERANCE = 2;

/**
 * How far a submission's runtime may sit from the file's before it is for a different cut.
 * AniSkip filters on `episodeLength` itself, within about fifteen seconds, which discarded every
 * submission for a rip trimmed differently from the submitter's: a 1443s file against a 1475s
 * submission answered 404 and the episode looked unknown. Asking for every submission and
 * choosing the nearest keeps those; past a minute the rip is a different edit.
 */
export const ANISKIP_LENGTH_TOLERANCE_SEC = 60;

function normalizeTitle(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseAnimeEntry(node: Record<string, unknown> | null): AnimeEntry | null {
    if (!node || !ANIME_SERIES_FORMATS.has(stringValue(node.format))) return null;
    const anilistId = node.id;
    const malId = node.idMal;
    if (typeof anilistId !== "number" || !Number.isInteger(anilistId) || anilistId <= 0) return null;
    if (typeof malId !== "number" || !Number.isInteger(malId) || malId <= 0) return null;
    const episodes = numberValue(node.episodes);
    return { anilistId, malId: String(malId), episodes: episodes !== null && episodes > 0 ? episodes : null };
}

/** Month index of an entry's start, so cours sort by when they aired; unknown sorts last. */
function startOrder(node: Record<string, unknown> | null): number {
    const date = record(node?.startDate);
    return (numberValue(date?.year) ?? 9999) * 12 + (numberValue(date?.month) ?? 0);
}

/**
 * The first cour of the franchise a title names, from an AniList search. The search is fuzzy
 * and answers anything, so a result counts only when one of its titles is the name asked for:
 * exactly, or as the other's leading words, the way `Attack on Titan` leads `Attack on Titan:
 * Junior High`. Exact beats leading and the earliest wins within each, which is what makes the
 * root the first season rather than whichever sequel the search ranked higher. No match at all
 * is how live action is told apart from anime.
 */
export function parseAniListRoot(value: unknown, name: string): AnimeEntry | null {
    const wanted = normalizeTitle(name);
    const media = record(record(record(value)?.data)?.Page)?.media;
    if (!wanted || !Array.isArray(media)) return null;
    let best: { entry: AnimeEntry; exact: boolean; order: number } | null = null;
    for (const item of media) {
        const node = record(item);
        const entry = parseAnimeEntry(node);
        if (!node || !entry) continue;
        const title = record(node.title);
        const synonyms = Array.isArray(node.synonyms) ? node.synonyms : [];
        const names = [title?.english, title?.romaji, ...synonyms]
            .map((candidate) => normalizeTitle(stringValue(candidate)))
            .filter(Boolean);
        const exact = names.includes(wanted);
        const leading = exact ||
            names.some((candidate) => wanted.startsWith(`${candidate} `) || candidate.startsWith(`${wanted} `));
        if (!leading) continue;
        const order = startOrder(node);
        if (!best || (exact && !best.exact) || (exact === best.exact && order < best.order)) {
            best = { entry, exact, order };
        }
    }
    return best?.entry ?? null;
}

/** The cour that continues the one queried, from its AniList relations; null at the end of the run. */
export function parseAniListSequel(value: unknown): AnimeEntry | null {
    const edges = record(record(record(record(value)?.data)?.Media)?.relations)?.edges;
    if (!Array.isArray(edges)) return null;
    let best: { entry: AnimeEntry; order: number } | null = null;
    for (const item of edges) {
        const edge = record(item);
        if (edge?.relationType !== "SEQUEL") continue;
        const node = record(edge.node);
        const entry = parseAnimeEntry(node);
        if (!entry) continue;
        const order = startOrder(node);
        if (!best || order < best.order) best = { entry, order };
    }
    return best?.entry ?? null;
}

/** Episodes per season of a Cinemeta episode list, specials (season 0) left out. */
export function seasonEpisodeCounts(
    episodes: Array<{ season: number; episode: number }>
): Array<{ season: number; count: number }> {
    const counts = new Map<number, number>();
    for (const episode of episodes) {
        if (episode.season > 0) counts.set(episode.season, (counts.get(episode.season) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([season, count]) => ({ season, count }))
        .sort((a, b) => a.season - b.season);
}

/**
 * Where a Cinemeta season and episode fall in the sequel chain. Cinemeta numbers a show in
 * seasons; MyAnimeList numbers it in cours, and AniSkip is keyed by cour, so asking it for
 * "season 2, episode 5" with the first cour's id answers with the first season's timings. The
 * two schemes rarely agree - Attack on Titan season 3 is two MAL entries - so the chain is
 * consumed in order, each season taking as many cour episodes as it has, and the episode is
 * renumbered within the cour it lands in.
 */
export function mapAnimeEpisode(
    seasons: Array<{ season: number; count: number }>,
    chain: AnimeEntry[],
    season: number,
    episode: number
): { malId: string; episode: number } | null {
    for (const segment of courSegments(seasons, chain)) {
        if (segment.season !== season) continue;
        if (episode <= segment.seasonStart || episode > segment.seasonStart + segment.count) continue;
        return { malId: segment.malId, episode: segment.courStart + episode - segment.seasonStart };
    }
    return null;
}

/**
 * The reverse: where a cour's own episode number lands in Cinemeta's seasons. Simkl files each
 * cour as its own show numbered from one, so an episode read back from it says nothing about
 * the season the sidebar draws until it is walked back through the same chain.
 */
export function mapCourEpisode(
    seasons: Array<{ season: number; count: number }>,
    chain: AnimeEntry[],
    malId: string,
    episode: number
): { season: number; episode: number } | null {
    for (const segment of courSegments(seasons, chain)) {
        if (segment.malId !== malId) continue;
        if (episode <= segment.courStart || episode > segment.courStart + segment.count) continue;
        return { season: segment.season, episode: segment.seasonStart + episode - segment.courStart };
    }
    return null;
}

interface CourSegment {
    season: number;
    malId: string;
    /** Episodes already used in this Cinemeta season before the segment. */
    seasonStart: number;
    /** Episodes already used in this cour before the segment. */
    courStart: number;
    count: number;
}

/**
 * The seasons and cours laid side by side. Cinemeta numbers a show in seasons and MyAnimeList
 * numbers it in cours, and the two rarely agree - Attack on Titan season 3 is two MAL entries -
 * so the chain is consumed in order, each season taking as many cour episodes as it has. Both
 * directions read the same segments, which is what keeps them exact inverses.
 */
function courSegments(
    seasons: Array<{ season: number; count: number }>,
    chain: AnimeEntry[]
): CourSegment[] {
    const segments: CourSegment[] = [];
    let index = 0;
    let used = 0;
    for (const current of seasons) {
        let filled = 0;
        while (filled < current.count && index < chain.length) {
            const entry = chain[index];
            const total = entry.episodes ?? Number.POSITIVE_INFINITY;
            const snap = used === 0 && filled === 0 && Number.isFinite(total) &&
                Math.abs(total - current.count) <= SEASON_SNAP_TOLERANCE;
            const take = snap ? current.count : Math.min(total - used, current.count - filled);
            // An entry AniList reports as having no episodes would never advance the walk.
            if (take <= 0) {
                index += 1;
                used = 0;
                continue;
            }
            segments.push({
                season: current.season,
                malId: entry.malId,
                seasonStart: filled,
                courStart: used,
                count: take
            });
            filled += take;
            used += take;
            if (snap || used >= total) {
                index += 1;
                used = 0;
            }
        }
    }
    return segments;
}

/**
 * The interval of one type from an AniSkip answer that holds every submission for the episode.
 * With a duration, the submission nearest the file's runtime wins, and one further away than
 * `ANISKIP_LENGTH_TOLERANCE_SEC` is for a different cut and is left alone.
 */
export function parseAniSkipInterval(
    value: unknown,
    skipType: "op" | "ed" = "op",
    duration = 0
): IntroInterval | null {
    const response = record(value);
    if (response?.found !== true || !Array.isArray(response.results)) return null;
    let best: { interval: IntroInterval; distance: number } | null = null;
    for (const result of response.results) {
        const item = record(result);
        if (item?.skipType !== skipType) continue;
        const interval = record(item.interval);
        const start = numberValue(interval?.startTime);
        const end = numberValue(interval?.endTime);
        if (start === null || end === null || start < 0 || start >= end) continue;
        const length = numberValue(item.episodeLength);
        const distance = duration > 0 && length !== null ? Math.abs(length - duration) : 0;
        if (distance > ANISKIP_LENGTH_TOLERANCE_SEC) continue;
        if (!best || distance < best.distance) best = { interval: { start, end }, distance };
    }
    return best?.interval ?? null;
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
