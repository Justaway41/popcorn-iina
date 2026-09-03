import { cacheRank } from "./stremio";

/**
 * Choosing which stream to play, and which to show at all.
 *
 * Separate from `stremio.ts`, which turns addon responses into `PlayableStream`s: this module
 * never parses, it only ranks and filters what that produced. The two questions it answers are
 * "is this stream even the thing being watched" and "of the ones that are, which is best".
 */

/**
 * Drops streams an addon parsed as a different show. One IMDb id can answer with a show's
 * spin-offs, so a stream list for Gintama carries episodes of Gintama Mr Ginpachis Zany Class
 * and Gintama. Porori-hen alongside the ones asked for.
 *
 * Only applied when at least one stream does name the show being watched. An addon that spells
 * it differently - a romanized anime title against Cinemeta's English one - would otherwise
 * match nothing and empty the list, which is far worse than showing a few foreign rows.
 */
export function filterStreamsToShow<T extends { showTitle?: string }>(
    streams: T[],
    showTitle: string
): T[] {
    const wanted = titleWords(showTitle);
    if (wanted.length === 0) return streams;
    // Without a stream that names this show there is nothing to measure the others against.
    if (!streams.some((stream) => isSameTitle(titleWords(stream.showTitle || ""), wanted))) {
        return streams;
    }
    return streams.filter((stream) => {
        const title = titleWords(stream.showTitle || "");
        // Unknown stays, and so does an unrelated title: an addon listing this show as
        // "Attack On Titan" or "L'attacco Dei Giganti" shares no word with "Shingeki no Kyojin"
        // yet is the same show, and dropping translations would hide most of the list.
        return title.length === 0 || !isNarrowerTitle(title, wanted);
    });
}

function titleWords(value: string): string[] {
    return titleKey(value).split(" ").filter(Boolean);
}

function isSameTitle(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((word, index) => word === b[index]);
}

/**
 * Whether two titles are the same name with something appended, in either direction. That is
 * what a spin-off looks like next to its parent - `Gintama Mr Ginpachis Zany Class` beside
 * `Gintama`, `Bleach` beside `Bleach Thousand Year Blood War` - and it is the only relation
 * safe to act on. A wholly different string is far more likely a translation than another show.
 */
function isNarrowerTitle(a: string[], b: string[]): boolean {
    const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
    return shorter.length > 0 &&
        shorter.length < longer.length &&
        shorter.every((word, index) => word === longer[index]);
}

/**
 * Compares titles on their words alone, so punctuation and spacing cannot split a match. A
 * parenthesised alias is dropped first: addons list the same show as
 * `Shingeki No Kyojin (Attack On Titan)`, and keeping the alias would read as a different show.
 */
function titleKey(value: string): string {
    return value
        .replace(/\([^)]*\)/g, " ")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * Unknown is never treated as wrong: a formatter this cannot read must leave every stream
 * equal rather than rank the whole list as a mismatch.
 */
function showRank(streamTitle: string, wanted: string): number {
    if (!wanted || !streamTitle) return 0;
    return titleKey(streamTitle) === titleKey(wanted) ? 0 : 1;
}

export interface NextEpisodeStreamOptions {
    previousResolution?: string;
    preferredAudio?: string;
    preferredSubtitle?: string;
    /** Name of the file playing now, used to keep the next episode in the same release. */
    previousRelease?: string;
    /** Name of the show being watched, used to reject other shows sharing its IMDb id. */
    showTitle?: string;
}

/**
 * The words of a release name, with numbers dropped. The same group's next episode differs only
 * in its episode number and checksum; a different show differs in the title itself.
 */
export function releaseTokens(name: string): Set<string> {
    return new Set(
        name.toLowerCase()
            .replace(/\.[a-z0-9]{2,4}$/, "")
            .replace(/\d+/g, " ")
            .split(/[^a-z]+/)
            .filter((token) => token.length > 1)
    );
}

/** Share of words two release names have in common before they count as the same release. */
const SAME_RELEASE_OVERLAP = 0.6;

/**
 * An addon can answer one IMDb id with several different shows - every Gintama spin-off shares
 * one - and each of them has an episode with the requested number, so nothing else in a stream
 * list tells them apart. Staying with the release already playing is the only signal that does.
 */
function releaseRank(name: string, previous: Set<string>): number {
    if (previous.size === 0) return 0;
    const tokens = releaseTokens(name);
    if (tokens.size === 0) return 1;
    let shared = 0;
    tokens.forEach((token) => {
        if (previous.has(token)) shared += 1;
    });
    return shared / Math.max(tokens.size, previous.size) >= SAME_RELEASE_OVERLAP ? 0 : 1;
}

/**
 * Picks the stream the overlay's Next Episode button will play. Availability decides whether
 * playback starts now, so a stream reported cached ranks first; then come the user's audio and
 * subtitle preferences - unknown states stay neutral and never read as negative - then the
 * resolution already playing, and failing that the highest on offer.
 */
export function pickNextEpisodeStream<T extends {
    resolution: string;
    cached: boolean | null;
    audioLanguages: string[];
    subtitleLanguages: string[] | null;
    rawTitle?: string;
    showTitle?: string;
}>(streams: T[], options: NextEpisodeStreamOptions = {}): T | null {
    const target = qualityHeight(options.previousResolution || "");
    const preferredAudio = (options.preferredAudio || "").trim().toLowerCase();
    const preferredSubtitle = (options.preferredSubtitle || "").trim().toLowerCase();
    const previousRelease = releaseTokens(options.previousRelease || "");
    let bestStream: T | null = null;
    let bestRank: number[] = [];
    streams.forEach((stream, index) => {
        const height = qualityHeight(stream.resolution);
        if (height === null) return;
        const rank = [
            // Before availability: a stream of a different show is no use however fast it starts.
            showRank(stream.showTitle || "", options.showTitle || ""),
            cacheRank(stream.cached),
            // Above language, because the same release is already in the language being heard,
            // and a stream of the wrong show is useless whatever it is dubbed in.
            releaseRank(stream.rawTitle || "", previousRelease),
            languageRank(stream.audioLanguages, preferredAudio),
            languageRank(stream.subtitleLanguages, preferredSubtitle),
            // Matching what is playing comes first, but everything else is ranked by height
            // alone: absolute distance used to prefer 720p over 2160p when 1080p was playing.
            target !== null && height === target ? 0 : 1,
            -height,
            index
        ];
        if (!bestStream || compareRanks(rank, bestRank) < 0) {
            bestStream = stream;
            bestRank = rank;
        }
    });
    return bestStream;
}

/** Labels `parseAudioLanguages` emits for releases that carry several tracks without naming them. */
const UNNAMED_AUDIO_LABELS = ["dual audio", "multi", "other"];

function languageRank(languages: string[] | null, preferred: string): number {
    if (!preferred) return 0;
    if (!languages || languages.length === 0) return 1;
    const normalized = languages.map((language) => language.trim().toLowerCase());
    if (normalized.includes(preferred)) return 0;
    // A release saying only "Dual Audio" has named no language, so it cannot be a mismatch;
    // ranking it below a stream that says nothing at all buried the likeliest correct pick.
    return normalized.every((language) => UNNAMED_AUDIO_LABELS.includes(language)) ? 1 : 2;
}

function compareRanks(a: number[], b: number[]): number {
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
}

function qualityHeight(quality: string): number | null {
    if (/^4k$/i.test(quality)) return 2160;
    const match = quality.match(/^(\d{3,4})p$/i);
    return match ? Number(match[1]) : null;
}
