import type { WatchHistoryEntry } from "./history";
import type { PlaybackContext } from "./messages";

export interface TraktTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

export interface TraktState {
    clientId: string;
    clientSecret: string;
    tokens: TraktTokens | null;
    initialHistoryUploaded: boolean;
    lastSyncAt: string;
    lastError: string;
    retryAt: number;
}

export interface TraktScrobblePayload {
    progress: number;
    movie?: { ids: { imdb: string } };
    show?: { ids: { imdb: string } };
    episode?: { season: number; number: number };
}

const MAX_HISTORY_ITEMS = 100;

export function parseTraktState(value: unknown): TraktState {
    const item = getRecord(parseJson(value));
    const tokens = getRecord(item?.tokens);
    const accessToken = getString(tokens?.accessToken);
    const refreshToken = getString(tokens?.refreshToken);
    const expiresAt = getPositiveNumber(tokens?.expiresAt);
    return {
        clientId: getString(item?.clientId),
        clientSecret: getString(item?.clientSecret),
        tokens: accessToken && refreshToken && expiresAt
            ? { accessToken, refreshToken, expiresAt }
            : null,
        initialHistoryUploaded: item?.initialHistoryUploaded === true,
        lastSyncAt: getString(item?.lastSyncAt),
        lastError: getString(item?.lastError),
        retryAt: getNonNegativeNumber(item?.retryAt)
    };
}

export function buildScrobblePayload(
    context: PlaybackContext,
    progress: number
): TraktScrobblePayload {
    const value = Math.max(0, Math.min(100, progress));
    if (!context.episode) {
        return { movie: { ids: { imdb: context.media.imdbId } }, progress: value };
    }
    return {
        show: { ids: { imdb: context.media.imdbId } },
        episode: { season: context.episode.season, number: context.episode.episode },
        progress: value
    };
}

export function parseTraktHistory(playback: unknown, watched: unknown): WatchHistoryEntry[] {
    const entries = [
        ...(Array.isArray(playback) ? playback.flatMap((item) => parseRemote(item, false)) : []),
        ...(Array.isArray(watched) ? watched.flatMap((item) => parseRemote(item, true)) : [])
    ];
    return mergeWatchHistory([], entries);
}

export function mergeWatchHistory(
    local: WatchHistoryEntry[],
    remote: WatchHistoryEntry[]
): WatchHistoryEntry[] {
    const entries = new Map<string, WatchHistoryEntry>();
    for (const entry of [...local, ...remote]) {
        const existing = entries.get(entry.id);
        entries.set(entry.id, existing ? mergeEntry(existing, entry) : entry);
    }
    return [...entries.values()]
        .sort((a, b) => timestamp(b.lastPlayedAt) - timestamp(a.lastPlayedAt))
        .slice(0, MAX_HISTORY_ITEMS);
}

function parseRemote(value: unknown, watched: boolean): WatchHistoryEntry[] {
    const item = getRecord(value);
    const playedAt = getString(item?.[watched ? "watched_at" : "paused_at"]);
    if (!item || !playedAt) return [];
    const progress = watched ? 100 : clampProgress(item.progress);
    if (progress === null) return [];

    if (item.type === "movie") {
        const movie = getRecord(item.movie);
        const imdbId = getString(getRecord(movie?.ids)?.imdb);
        const name = getString(movie?.title);
        if (!imdbId || !name) return [];
        return [{
            id: imdbId,
            media: remoteMedia(imdbId, "movie", name, movie?.year),
            lastPlayedAt: playedAt,
            watched,
            progress
        }];
    }

    if (item.type !== "episode") return [];
    const show = getRecord(item.show);
    const episode = getRecord(item.episode);
    const imdbId = getString(getRecord(show?.ids)?.imdb);
    const showName = getString(show?.title);
    const season = getFiniteNumber(episode?.season);
    const number = getFiniteNumber(episode?.number);
    if (!imdbId || !showName || season === null || number === null) return [];
    return [{
        id: `${imdbId}:${season}:${number}`,
        media: remoteMedia(imdbId, "series", showName, show?.year),
        episode: {
            id: `${imdbId}:${season}:${number}`,
            name: getString(episode?.title) || `Episode ${season}x${number}`,
            season,
            episode: number,
            aired: getString(episode?.first_aired),
            description: getString(episode?.overview),
            thumbnail: ""
        },
        lastPlayedAt: playedAt,
        watched,
        progress
    }];
}

function mergeEntry(first: WatchHistoryEntry, second: WatchHistoryEntry): WatchHistoryEntry {
    const [older, newer] = timestamp(first.lastPlayedAt) > timestamp(second.lastPlayedAt)
        ? [second, first]
        : [first, second];
    return {
        ...newer,
        media: { ...newer.media, poster: older.media.poster || newer.media.poster },
        ...(newer.episode || older.episode ? {
            episode: mergeEpisode(older.episode, newer.episode)
        } : {}),
        watched: older.watched || newer.watched
    };
}

function mergeEpisode(
    older: WatchHistoryEntry["episode"],
    newer: WatchHistoryEntry["episode"]
) {
    if (!newer) return older!;
    if (!older) return newer;
    return {
        ...newer,
        description: older.description || newer.description,
        thumbnail: older.thumbnail || newer.thumbnail
    };
}

function remoteMedia(
    imdbId: string,
    type: "movie" | "series",
    name: string,
    year: unknown
) {
    return {
        id: imdbId,
        imdbId,
        type,
        name,
        releaseInfo: typeof year === "number" || typeof year === "string" ? String(year) : "",
        poster: ""
    };
}

function timestamp(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function parseJson(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

function clampProgress(value: unknown): number | null {
    const progress = getFiniteNumber(value);
    return progress === null ? null : Math.max(0, Math.min(100, progress));
}

function getRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function getString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function getFiniteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getPositiveNumber(value: unknown): number | null {
    const number = getFiniteNumber(value);
    return number !== null && number > 0 ? number : null;
}

function getNonNegativeNumber(value: unknown): number {
    const number = getFiniteNumber(value);
    return number !== null && number >= 0 ? number : 0;
}
