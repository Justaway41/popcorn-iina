import { canonicalizeManifestUrl } from "./addons";

export type MediaType = "movie" | "series";

export interface Media {
    id: string;
    imdbId: string;
    type: MediaType;
    name: string;
    releaseInfo: string;
    poster: string;
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
    url: string;
    quality: string;
    size: string;
    audioLanguages: string[];
    subtitleLanguages: string[] | null;
}

const CINEMETA_BASE_URL = "https://v3-cinemeta.strem.io";
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

export function buildOpenSubtitlesUrl(type: MediaType, videoId: string): string {
    return `${OPEN_SUBTITLES_BASE_URL}/subtitles/${type}/${encodeURIComponent(videoId)}.json`;
}

export function buildStremioStreamUrl(manifestUrl: string, type: MediaType, videoId: string): string {
    const canonical = canonicalizeManifestUrl(manifestUrl);
    const queryIndex = canonical.indexOf("?");
    const path = queryIndex === -1 ? canonical : canonical.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : canonical.slice(queryIndex);
    return path.replace(
        /\/manifest\.json$/i,
        `/stream/${type}/${encodeURIComponent(videoId)}.json`
    ) + query;
}

export function parseMediaTypePreference(value: unknown): MediaType {
    return value === "series" ? "series" : "movie";
}

export function parseMediaResponse(value: unknown): Media[] {
    const metas = getRecord(value)?.metas;
    if (!Array.isArray(metas)) {
        return [];
    }
    return metas.flatMap((entry) => {
        const item = getRecord(entry);
        const id = getString(item?.id);
        const type = item?.type === "movie" || item?.type === "series" ? item.type : null;
        const name = getString(item?.name);
        if (!id || !type || !name) {
            return [];
        }
        return [{
            id,
            imdbId: getString(item?.imdb_id) || id,
            type,
            name,
            releaseInfo: getString(item?.releaseInfo),
            poster: getString(item?.poster)
        }];
    });
}

export function parseSeriesEpisodes(value: unknown): Episode[] {
    const videos = getRecord(getRecord(value)?.meta)?.videos;
    if (!Array.isArray(videos)) {
        return [];
    }
    return videos.flatMap((entry) => {
        const item = getRecord(entry);
        const id = getString(item?.id);
        const name = getString(item?.name);
        const season = getNumber(item?.season);
        const episode = getNumber(item?.number);
        if (!id || !name || season === null || episode === null) {
            return [];
        }
        return [{
            id,
            name,
            season,
            episode,
            aired: getString(item?.firstAired),
            description: getString(item?.description),
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
        const title = getString(stream?.title) || description || name || "Stream";
        const metadata = [name, title, description].join(" ");
        return [{
            title,
            url,
            quality: metadata.match(/\b(4K|2160p|1080p|720p|480p|HDRip|BRRip|WEBRip)\b/i)?.[0] || "",
            size: metadata.match(/(?:💾\s*)?([\d.]+\s*[KMGT]B)\b/i)?.[1] || "",
            audioLanguages: parseAudioLanguages(metadata),
            subtitleLanguages: parseSubtitleLanguages(stream?.subtitles)
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

function getNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
