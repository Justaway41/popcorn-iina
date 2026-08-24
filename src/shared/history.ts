import type { PlaybackContext } from "./messages";
import type { Episode, Media } from "./stremio";

export interface WatchHistoryEntry {
    id: string;
    media: Media;
    episode?: Episode;
    lastPlayedAt: string;
    watched: boolean;
    progress: number | null;
}

const MAX_HISTORY_ITEMS = 100;

export function parseWatchHistory(value: unknown): WatchHistoryEntry[] {
    try {
        const items = typeof value === "string" ? JSON.parse(value) as unknown : value;
        if (!Array.isArray(items)) return [];
        return items.flatMap(parseEntry).slice(0, MAX_HISTORY_ITEMS);
    } catch {
        return [];
    }
}

export function recordPlayback(
    entries: WatchHistoryEntry[],
    context: PlaybackContext,
    percent: number,
    playedAt: string
): WatchHistoryEntry[] {
    if (!Number.isFinite(percent) || percent < 5) return entries;
    const id = historyContextId(context);
    const existing = entries.find((entry) => entry.id === id);
    const progress = Math.max(0, Math.min(100, percent));
    const entry: WatchHistoryEntry = {
        id,
        media: context.media,
        ...(context.episode ? { episode: context.episode } : {}),
        lastPlayedAt: playedAt,
        watched: Boolean(existing?.watched || progress >= 90),
        progress
    };
    return [entry, ...entries.filter((item) => item.id !== id)].slice(0, MAX_HISTORY_ITEMS);
}

/**
 * A card stands for a title, not an episode, so removing one drops every episode of that title;
 * otherwise the episode before it takes its place on the very next render.
 */
export function removeHistoryEntry(
    entries: WatchHistoryEntry[],
    id: string
): WatchHistoryEntry[] {
    const target = entries.find((entry) => entry.id === id);
    if (!id || !target) return entries;
    return entries.filter((entry) => historyTitleId(entry) !== historyTitleId(target));
}

/**
 * One entry per title, the most recent one. Watching three episodes of a show is one thing in
 * progress, not three, and listing each of them buries everything else.
 * Expects entries newest first, which is how both `recordPlayback` and `mergeWatchHistory` order.
 */
export function latestPerTitle(entries: WatchHistoryEntry[]): WatchHistoryEntry[] {
    const seen = new Set<string>();
    return entries.filter((entry) => {
        const id = historyTitleId(entry);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

export function historyTitleId(entry: WatchHistoryEntry): string {
    return entry.media.imdbId || entry.media.providerId || entry.media.id;
}

export function getHistoryEntry(
    entries: WatchHistoryEntry[],
    context: PlaybackContext
): WatchHistoryEntry | null {
    const id = historyContextId(context);
    return entries.find((entry) => entry.id === id) || null;
}

export function getResumePercent(progress: number | null, watched: boolean): number | null {
    return !watched && progress !== null && progress >= 5 && progress < 90
        ? progress
        : null;
}

function parseEntry(value: unknown): WatchHistoryEntry[] {
    const item = getRecord(value);
    const media = parseMedia(item?.media);
    const episode = item?.episode == null ? null : parseEpisode(item.episode);
    const id = getString(item?.id);
    const lastPlayedAt = getString(item?.lastPlayedAt);
    const watched = item?.watched;
    if (!item || !media || (item.episode != null && !episode) || !id || !lastPlayedAt || typeof watched !== "boolean") {
        return [];
    }
    if (id !== (episode?.id || media.imdbId || media.providerId || media.id)) return [];
    return [{
        id,
        media,
        ...(episode ? { episode } : {}),
        lastPlayedAt,
        watched,
        progress: normalizeProgress(item.progress, watched)
    }];
}

function normalizeProgress(value: unknown, watched: boolean): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return watched ? 100 : null;
    }
    return Math.max(0, Math.min(100, value));
}

function parseMedia(value: unknown): Media | null {
    const item = getRecord(value);
    const type = item?.type === "movie" || item?.type === "series" ? item.type : null;
    const id = getString(item?.id);
    const imdbId = getString(item?.imdbId);
    const name = getString(item?.name);
    if (!item || !type || !id || !(imdbId || getString(item.providerId)) || !name) return null;
    return {
        id,
        imdbId,
        type,
        name,
        releaseInfo: getString(item.releaseInfo),
        poster: getString(item.poster),
        ...(getString(item.sourceManifestUrl) ? { sourceManifestUrl: getString(item.sourceManifestUrl) } : {}),
        ...(getString(item.providerId) ? { providerId: getString(item.providerId) } : {}),
        ...(getString(item.providerType) ? { providerType: getString(item.providerType) } : {}),
        ...(getString(item.malId) ? { malId: getString(item.malId) } : {})
    };
}

export function historyContextId(context: PlaybackContext): string {
    return context.episode?.id || context.media.imdbId || context.media.providerId || context.media.id;
}

function parseEpisode(value: unknown): Episode | null {
    const item = getRecord(value);
    const id = getString(item?.id);
    const name = getString(item?.name);
    const season = getNumber(item?.season);
    const episode = getNumber(item?.episode);
    if (!item || !id || !name || season === null || episode === null) return null;
    return {
        id,
        name,
        season,
        episode,
        aired: getString(item.aired),
        description: getString(item.description),
        thumbnail: getString(item.thumbnail)
    };
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
