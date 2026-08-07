import type { AddonManifest, StremioCatalog } from "./addons";
import { canonicalizeManifestUrl } from "./addons";

export type MediaType = "movie" | "series";
export type EpisodeOrder = "oldest" | "newest";
export type SizeOrder = "largest" | "smallest";

export interface Media {
    id: string;
    imdbId: string;
    type: MediaType;
    name: string;
    releaseInfo: string;
    poster: string;
    sourceManifestUrl?: string;
    providerId?: string;
    providerType?: string;
    malId?: string;
}

export interface Episode {
    id: string;
    name: string;
    season: number;
    episode: number;
    aired: string;
    description: string;
    thumbnail: string;
}

export interface PlayableStream {
    title: string;
    rawTitle: string;
    url: string;
    /** Vertical resolution only, normalized to `2160p`/`1080p`/…; never a source type. */
    resolution: string;
    /** Release source such as `WEB-DL` or `BluRay`. Display only. */
    source: string;
    size: string;
    audioLanguages: string[];
    subtitleLanguages: string[] | null;
    cached: boolean | null;
    seeders: number | null;
}

const CINEMETA_BASE_URL = "https://v3-cinemeta.strem.io";
const CINEMETA_MANIFEST_URL = `${CINEMETA_BASE_URL}/manifest.json`;
const OPEN_SUBTITLES_BASE_URL = "https://opensubtitles-v3.strem.io";

const LANGUAGE_ALIASES: Array<[string, string[]]> = [
    ["English", ["english", "eng"]],
    ["Japanese", ["japanese", "jpn"]],
    ["Hindi", ["hindi", "hin"]],
    ["Korean", ["korean", "kor"]],
    ["Chinese", ["chinese", "chi", "zho"]],
    ["Spanish", ["spanish", "spa"]],
    ["French", ["french", "fre", "fra"]],
    ["German", ["german", "ger", "deu"]],
    ["Italian", ["italian", "ita"]],
    ["Portuguese", ["portuguese", "por", "pob"]],
    ["Russian", ["russian", "rus"]],
    ["Arabic", ["arabic", "ara"]],
    ["Tamil", ["tamil", "tam"]],
    ["Telugu", ["telugu", "tel"]]
];

export function buildCinemetaSearchUrl(type: MediaType, query: string): string {
    return `${CINEMETA_BASE_URL}/catalog/${type}/all/search=${encodeURIComponent(query.trim())}.json`;
}

export function buildCinemetaTrendingUrl(type: MediaType): string {
    return `${CINEMETA_BASE_URL}/catalog/${type}/top.json`;
}

export function buildCinemetaSeriesUrl(imdbId: string): string {
    return `${CINEMETA_BASE_URL}/meta/series/${encodeURIComponent(imdbId)}.json`;
}

export function buildCinemetaPosterUrl(imdbId: string): string {
    return `https://images.metahub.space/poster/medium/${encodeURIComponent(imdbId)}/img`;
}

export function buildOpenSubtitlesUrl(type: MediaType, videoId: string): string {
    return `${OPEN_SUBTITLES_BASE_URL}/subtitles/${type}/${encodeURIComponent(videoId)}.json`;
}

export function buildStremioStreamUrl(manifestUrl: string, type: MediaType, videoId: string): string {
    return buildStremioResourceUrl(manifestUrl, "stream", type, videoId);
}

export function buildStremioResourceUrl(
    manifestUrl: string,
    resource: "catalog" | "meta" | "stream" | "subtitles",
    type: string,
    id: string,
    extra: Record<string, string> = {}
): string {
    const canonical = canonicalizeManifestUrl(manifestUrl);
    const queryIndex = canonical.indexOf("?");
    const path = queryIndex === -1 ? canonical : canonical.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : canonical.slice(queryIndex);
    const extraPath = Object.entries(extra).map(([name, value]) => (
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
    ));
    return path.replace(
        /\/manifest\.json$/i,
        `/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}${
            extraPath.length ? `/${extraPath.join("/")}` : ""
        }.json`
    ) + query;
}

export function getSearchableCatalogs(
    manifest: AddonManifest,
    mediaType: MediaType
): StremioCatalog[] {
    const types = mediaType === "movie" ? new Set(["movie"]) : new Set(["series", "anime"]);
    return manifest.catalogs.filter((catalog) => (
        types.has(catalog.type) && catalog.extra.some((extra) => extra.name === "search")
    ));
}

export function parseMediaTypePreference(value: unknown): MediaType {
    return value === "series" ? "series" : "movie";
}

export function parseEpisodeOrder(value: unknown): EpisodeOrder {
    return value === "newest" ? "newest" : "oldest";
}

/** Absent means an install that predates the setting, so segment lookups stay on. */
export function parseSkipSegments(value: unknown): boolean {
    return value !== false;
}

export function sortEpisodes(episodes: Episode[], order: EpisodeOrder): Episode[] {
    const direction = order === "newest" ? -1 : 1;
    return [...episodes].sort((a, b) =>
        direction * (a.season - b.season || a.episode - b.episode)
    );
}

export function sortStreamsBySize<T extends { size: string }>(
    streams: T[],
    order: SizeOrder
): T[] {
    return streams.map((stream, index) => ({ stream, index, bytes: parseByteSize(stream.size) }))
        .sort((a, b) => {
            if (a.bytes === null) return b.bytes === null ? a.index - b.index : 1;
            if (b.bytes === null) return -1;
            const difference = order === "largest" ? b.bytes - a.bytes : a.bytes - b.bytes;
            return difference || a.index - b.index;
        })
        .map(({ stream }) => stream);
}

// Availability outranks file size: an uncached stream costs a download wait no matter how
// good it is. Unknown sits between the two because it may still play instantly.
function cacheRank(cached: boolean | null): number {
    return cached === true ? 0 : cached === null ? 1 : 2;
}

export function sortStreamsForPlayback<T extends { size: string; cached: boolean | null }>(
    streams: T[],
    order: SizeOrder
): T[] {
    // Array.prototype.sort is stable, so the size ordering survives inside each cache rank.
    return sortStreamsBySize(streams, order)
        .sort((a, b) => cacheRank(a.cached) - cacheRank(b.cached));
}

export function groupStreamsByResolution<T extends { resolution: string }>(
    streams: T[]
): Array<{ resolution: string; streams: T[] }> {
    const groups = new Map<string, T[]>();
    streams.forEach((stream) => {
        const key = RESOLUTION_ORDER.includes(stream.resolution) ? stream.resolution : "other";
        groups.set(key, [...(groups.get(key) || []), stream]);
    });
    const rank = (value: string) => {
        const index = RESOLUTION_ORDER.indexOf(value);
        return index < 0 ? RESOLUTION_ORDER.length : index;
    };
    return [...groups.entries()]
        .sort((a, b) => rank(a[0]) - rank(b[0]))
        .map(([resolution, items]) => ({ resolution, streams: items }));
}

export function parseByteSize(value: string): number | null {
    const match = value.trim().match(/^([\d.]+)\s*([KMGT])B$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    const power = ["K", "M", "G", "T"].indexOf(match[2].toUpperCase()) + 1;
    return Number.isFinite(amount) && amount >= 0 ? amount * 1024 ** power : null;
}

export function findClosestQualityStream<T extends { resolution: string }>(
    streams: T[],
    previousQuality: string
): T | null {
    const known = streams.flatMap((stream, index) => {
        const height = qualityHeight(stream.resolution);
        return height === null ? [] : [{ stream, index, height }];
    });
    if (known.length === 0) return null;
    const target = qualityHeight(previousQuality);
    known.sort((a, b) => {
        if (target === null) return b.height - a.height || a.index - b.index;
        return Math.abs(a.height - target) - Math.abs(b.height - target) ||
            b.height - a.height || a.index - b.index;
    });
    return known[0].stream;
}

export function parseMediaResponse(
    value: unknown,
    source: { manifestUrl: string } = { manifestUrl: CINEMETA_MANIFEST_URL }
): Media[] {
    const metas = getRecord(value)?.metas;
    if (!Array.isArray(metas)) {
        return [];
    }
    return metas.flatMap((entry) => {
        const item = getRecord(entry);
        const id = getString(item?.id);
        const providerType = getString(item?.type);
        const type = providerType === "movie"
            ? "movie"
            : providerType === "series" || providerType === "anime" ? "series" : null;
        const name = getString(item?.name);
        if (!id || !type || !name) {
            return [];
        }
        const imdbId = firstImdbId(item?.imdb_id, id, getRecord(item?.behaviorHints)?.defaultVideoId);
        return [{
            id,
            imdbId,
            type,
            name,
            releaseInfo: getString(item?.releaseInfo) || getStringOrNumber(item?.year),
            poster: getString(item?.poster),
            sourceManifestUrl: source.manifestUrl,
            providerId: id,
            providerType,
            malId: getStringOrNumber(item?.mal_id)
        }];
    });
}

export function parseMediaMetadata(
    value: unknown,
    source: { manifestUrl: string },
    preview: Media
): { media: Media; episodes: Episode[] } {
    const meta = getRecord(getRecord(value)?.meta);
    if (!meta) return { media: preview, episodes: [] };
    const parsed = parseMediaResponse({ metas: [meta] }, source)[0];
    const media = parsed ? {
        ...preview,
        ...parsed,
        name: parsed.name || preview.name,
        releaseInfo: parsed.releaseInfo || preview.releaseInfo,
        poster: parsed.poster || preview.poster,
        imdbId: parsed.imdbId || preview.imdbId,
        malId: parsed.malId || preview.malId || ""
    } : preview;
    return { media, episodes: parseSeriesEpisodes(value) };
}

export function mergeMediaResults(groups: Media[][]): Media[] {
    const seen = new Set<string>();
    return groups.flatMap((group) => group.flatMap((media) => {
        const key = isImdbId(media.imdbId)
            ? `imdb:${media.imdbId.toLowerCase()}`
            : `title:${media.type}:${normalizeTitle(media.name)}:${releaseYear(media.releaseInfo)}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [media];
    }));
}

export function isImdbId(value: string): boolean {
    return /^tt\d+$/i.test(value.trim());
}

export function isCompatibleSubtitleId(value: string): boolean {
    return /^tt\d+(?::\d+:\d+)?$/i.test(value.trim());
}

export function parseSeriesEpisodes(value: unknown): Episode[] {
    const videos = getRecord(getRecord(value)?.meta)?.videos;
    if (!Array.isArray(videos)) {
        return [];
    }
    return videos.flatMap((entry) => {
        const item = getRecord(entry);
        const providerId = getString(item?.id);
        const name = getString(item?.name) || getString(item?.title);
        const season = getNumber(item?.season);
        const episode = getNumber(item?.number);
        if (!providerId || !name || season === null || episode === null) {
            return [];
        }
        const imdbId = firstImdbId(item?.imdb_id);
        const imdbSeason = getNumber(item?.imdbSeason);
        const imdbEpisode = getNumber(item?.imdbEpisode);
        const id = imdbId && imdbSeason !== null && imdbEpisode !== null
            ? `${imdbId}:${imdbSeason}:${imdbEpisode}`
            : providerId;
        return [{
            id,
            name,
            season,
            episode,
            aired: getString(item?.firstAired) || getString(item?.released),
            description: getString(item?.description) || getString(item?.overview),
            thumbnail: getString(item?.thumbnail)
        }];
    });
}

export function parsePlayableStreams(value: unknown): PlayableStream[] {
    const streams = getRecord(value)?.streams;
    if (!Array.isArray(streams)) {
        return [];
    }
    return streams.flatMap((entry) => {
        const stream = getRecord(entry);
        const url = getString(stream?.url);
        if (!isHttpUrl(url)) {
            return [];
        }
        const name = getString(stream?.name);
        const description = getString(stream?.description);
        const providerTitle = getString(stream?.title) || description || name || "Stream";
        const behaviorHints = getRecord(stream?.behaviorHints);
        const streamData = getRecord(stream?.streamData);
        const service = getRecord(streamData?.service);
        const torrent = getRecord(streamData?.torrent);
        const filename = getString(behaviorHints?.filename) || getString(streamData?.filename);
        const rawTitle = filename || providerTitle;
        const metadata = [name, providerTitle, description, filename].join(" ");
        const structuredCached = getBoolean(service?.cached) ?? getBoolean(streamData?.cached);
        const structuredSeeders = getNonNegativeInteger(torrent?.seeders)
            ?? getNonNegativeInteger(streamData?.seeders);
        const structuredSize = formatByteSize(
            getPositiveNumber(behaviorHints?.videoSize) ?? getPositiveNumber(streamData?.size)
        );
        return [{
            title: cleanStreamTitle(rawTitle),
            rawTitle,
            url,
            resolution: parseResolution(filename || metadata, metadata),
            source: (filename.match(SOURCE_PATTERN) || metadata.match(SOURCE_PATTERN))?.[0] || "",
            size: structuredSize || metadata.match(/(?:💾\s*)?([\d.]+\s*[KMGT]B)\b/i)?.[1] || "",
            audioLanguages: parseAudioLanguages(metadata),
            subtitleLanguages: parseSubtitleLanguages(stream?.subtitles),
            cached: structuredCached ?? parseCacheStatus(metadata),
            seeders: structuredSeeders ?? parseSeeders(metadata)
        }];
    });
}

export function parseEnglishSubtitleAvailability(value: unknown): boolean {
    return parseSubtitleLanguages(getRecord(value)?.subtitles)?.includes("English") || false;
}

export function isEpisodeAvailable(episode: Episode, now = new Date()): boolean {
    const aired = Date.parse(episode.aired);
    return !Number.isFinite(aired) || aired <= now.getTime();
}

export function findNextEpisode(episodes: Episode[], current: Episode, now = new Date()): Episode | null {
    const sorted = episodes.filter((episode) => isEpisodeAvailable(episode, now)).sort((a, b) => {
        if (a.season !== b.season) return a.season - b.season;
        if (a.episode !== b.episode) return a.episode - b.episode;
        return a.id.localeCompare(b.id);
    });
    const index = sorted.findIndex((episode) => episode.id === current.id);
    if (index !== -1) {
        return sorted[index + 1] || null;
    }
    return sorted.find((episode) => (
        episode.season > current.season ||
        (episode.season === current.season && episode.episode > current.episode)
    )) || null;
}

function isHttpUrl(value: string): boolean {
    return /^https?:\/\/[^/]+/i.test(value.trim());
}

function cleanStreamTitle(value: string): string {
    const firstLine = value.split(/\r?\n/).find((line) => line.trim())?.trim() || value.trim();
    const cleaned = firstLine
        .replace(/\.(?:mkv|mp4|avi|mov|m4v|ts|m2ts|webm|iso)$/i, "")
        // Release-site tags. Only bracket blocks that look like a site are dropped, so
        // plain group tags such as [SubsPlease] survive.
        .replace(/【[^】]*】/g, " ")
        .replace(/\[[^\]]*(?:www\s*\.|\.com|\.net|\.org|\.tv|[一-鿿])[^\]]*\]/gi, " ")
        .replace(/\b(?:www\s*\.\s*)?[a-z0-9-]+\s*\.\s*(?:com|net|org|tv|me)\b/gi, " ")
        .replace(/\p{Extended_Pictographic}|[\uFE0F\u200D]/gu, " ")
        .replace(/[._]+/g, " ")
        .replace(/\bH\s*26([45])\b/gi, "H.26$1")
        .replace(/\bS(\d{1,2})\s+E(\d{1,3})\b/gi, "S$1E$2")
        .replace(/\bWEB\s+DL\b/gi, "WEB-DL")
        .replace(/\b(?:4K|(?:2160|1440|1080|720|576|480|360|240)p)\b/gi, " ")
        .replace(/\b\d+(?:\.\d+)?\s*[KMGT]B\b/gi, " ")
        .replace(/[|•]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(
            /\s+(?=(?:S\d{1,2}E\d{1,3}|WEB(?:-?DL|Rip)|BluRay|REMUX|HDR(?:10\+?)?|DV|DoVi|HEVC|AVC|AV1|x26[45]|H\.26[45])\b)/gi,
            " · "
        );
    return cleaned || firstLine || "Stream";
}

const RESOLUTION_PATTERN = /\b(4K|(?:2160|1440|1080|720|576|480|360|240)p)\b/i;
const SOURCE_PATTERN = /\b(WEB-?DL|WEBRip|BluRay|BRRip|HDRip|REMUX)\b/i;

// Standard abbreviations. Addons may label a resolution instead of stating it, so these
// are a last resort consulted only when no explicit token exists anywhere.
const RESOLUTION_ALIASES: Array<[RegExp, string]> = [
    [/\b(?:4K\s*)?UHD\b/i, "2160p"],
    [/\bQHD\b/i, "1440p"],
    [/\bFHD\b/i, "1080p"],
    [/\bHD\b/i, "720p"]
];

export const RESOLUTION_ORDER = ["2160p", "1440p", "1080p", "720p", "576p", "480p", "360p", "240p"];

function normalizeResolution(value: string): string {
    if (!value) return "";
    return /^4k$/i.test(value) ? "2160p" : value.toLowerCase();
}

// Prefer the filename: it is a release name and is immune to display decoration, while
// `name`/`description` may carry addon-specific labels instead of literal tokens.
function parseResolution(primary: string, metadata: string): string {
    const literal = normalizeResolution(primary.match(RESOLUTION_PATTERN)?.[0] || "");
    if (literal) return literal;
    return RESOLUTION_ALIASES.find(([pattern]) => pattern.test(metadata))?.[1] || "";
}

// Words state cache status; emoji only decorate it. A decorative glyph must never be able
// to invert an explicit statement, so words are checked first and an explicit negative wins.
function parseCacheStatus(value: string): boolean | null {
    if (/\b(?:uncached|not\s+ready|download(?:ing)?)\b/i.test(value)) return false;
    if (/\b(?:cached|instant|ready)\b/i.test(value)) return true;
    const cached = /⚡|\[[^\]\r\n]{1,20}\+\]/.test(value);
    const uncached = /⬇|⏳/.test(value);
    return cached === uncached ? null : cached;
}

function parseSeeders(value: string): number | null {
    const match = value.match(/(?:\bseeders?\s*[:=]?\s*|[👤👥🌱⇄⇋]\s*)(\d+)\b/iu)
        ?? value.match(/\bS:\s*(\d+)\b/i);
    return match ? Number(match[1]) : null;
}

function formatByteSize(value: number | null): string {
    if (value === null) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const amount = value / 1024 ** exponent;
    const precision = amount >= 10 || exponent === 0 ? 1 : 2;
    return `${Number(amount.toFixed(precision))} ${units[exponent]}`;
}

function parseAudioLanguages(value: string): string[] {
    let audioMetadata = value.replace(/\be[\s._-]*subs?\b/gi, " ");
    LANGUAGE_ALIASES.forEach(([, aliases]) => {
        const language = `(?:${aliases.join("|")})`;
        audioMetadata = audioMetadata
            .replace(new RegExp(`\\b${language}\\b[\\s._-]*(?:subtitles?|subs?|cc)\\b`, "gi"), " ")
            .replace(new RegExp(`\\b(?:subtitles?|subs?|cc)\\b[\\s:._-]*${language}\\b`, "gi"), " ");
    });

    const languages = LANGUAGE_ALIASES.flatMap(([name, aliases]) => (
        new RegExp(`\\b(?:${aliases.join("|")})\\b`, "i").test(audioMetadata) ? [name] : []
    ));
    if (languages.length > 1) return languages;

    const generic = /\bdual[\s._-]*audio\b/i.test(audioMetadata)
        ? "Dual Audio"
        : /\bmulti(?:[\s._-]*(?:audio|dub))?\b/i.test(audioMetadata) ? "Multi" : "";
    if (!generic) return languages;
    return languages.length === 0 ? [generic] : [...languages, "Other"];
}

function qualityHeight(quality: string): number | null {
    if (/^4k$/i.test(quality)) return 2160;
    const match = quality.match(/^(\d{3,4})p$/i);
    return match ? Number(match[1]) : null;
}

function parseSubtitleLanguages(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    return [...new Set(value.flatMap((entry) => {
        const language = normalizeLanguage(getString(getRecord(entry)?.lang));
        return language ? [language] : [];
    }))];
}

function normalizeLanguage(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return "";
    const language = LANGUAGE_ALIASES.find(([, aliases]) => aliases.includes(normalized))?.[0];
    if (language) return language;
    return normalized.length <= 3 ? normalized.toUpperCase() : value.trim();
}

function getRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function getString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function getBoolean(value: unknown): boolean | null {
    return typeof value === "boolean" ? value : null;
}

function getPositiveNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function getNonNegativeInteger(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function getStringOrNumber(value: unknown): string {
    return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : "";
}

function firstImdbId(...values: unknown[]): string {
    return values.map(getString).find(isImdbId) || "";
}

function normalizeTitle(value: string): string {
    return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function releaseYear(value: string): string {
    return value.match(/\b\d{4}\b/)?.[0] || "";
}

function getNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
