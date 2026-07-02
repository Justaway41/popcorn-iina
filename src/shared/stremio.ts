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
}

const CINEMETA_BASE_URL = "https://v3-cinemeta.strem.io";

export function normalizeAddonManifestUrl(value: string): string {
    const trimmed = value.trim();
    const normalized = trimmed.startsWith("stremio://")
        ? `https://${trimmed.slice("stremio://".length)}`
        : trimmed;

    if (!/^https?:\/\/[^/]+/i.test(normalized)) {
        throw new Error("Addon URL must start with http://, https://, or stremio://");
    }
    return normalized
        .split(/[?#]/, 1)[0]
        .replace(/\/manifest\.json\/?$/i, "")
        .replace(/\/+$/, "");
}

export function buildCinemetaSearchUrl(type: MediaType, query: string): string {
    return `${CINEMETA_BASE_URL}/catalog/${type}/all/search=${encodeURIComponent(query.trim())}.json`;
}

export function buildCinemetaTrendingUrl(type: MediaType): string {
    return `${CINEMETA_BASE_URL}/catalog/${type}/top.json`;
}

export function buildCinemetaSeriesUrl(imdbId: string): string {
    return `${CINEMETA_BASE_URL}/meta/series/${encodeURIComponent(imdbId)}.json`;
}

export function buildStremioStreamUrl(baseUrl: string, type: MediaType, videoId: string): string {
    return `${baseUrl.replace(/\/+$/, "")}/stream/${type}/${encodeURIComponent(videoId)}.json`;
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
        const title = getString(stream?.title) || getString(stream?.description) || getString(stream?.name) || "Stream";
        return [{
            title,
            url,
            quality: title.match(/\b(4K|2160p|1080p|720p|480p|HDRip|BRRip|WEBRip)\b/i)?.[0] || "",
            size: title.match(/(?:💾\s*)?([\d.]+\s*[KMGT]B)\b/i)?.[1] || ""
        }];
    });
}

export function findNextEpisode(episodes: Episode[], current: Episode): Episode | null {
    const sorted = [...episodes].sort((a, b) => {
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
