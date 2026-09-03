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

export interface WatchedShow {
    id: string;
    episodes: string[];
}

export interface EpisodeWatchState {
    local: WatchedShow[];
    simkl: WatchedShow[];
}

export type WatchedShowPatch = WatchedShow;

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

export function parseEpisodeWatchState(
    value: unknown,
    legacyHistory: WatchHistoryEntry[] = []
): EpisodeWatchState {
    let stored: unknown = value;
    try {
        stored = typeof value === "string" ? JSON.parse(value) as unknown : value;
    } catch {
        stored = null;
    }
    const item = getRecord(stored);
    const state = {
        local: parseWatchedShows(item?.local),
        simkl: parseWatchedShows(item?.simkl)
    };
    for (const entry of legacyHistory) {
        if (!entry.watched || !entry.episode) continue;
        addWatchedEpisode(state.local, historyTitleId(entry), episodeCoordinate(entry.episode));
    }
    return state;
}

export function episodeCoordinate(episode: Episode): string {
    return `${episode.season}:${episode.episode}`;
}

export function markEpisodeWatched(
    state: EpisodeWatchState,
    context: PlaybackContext
): EpisodeWatchState {
    if (!context.episode) return state;
    const next = parseEpisodeWatchState(state);
    addWatchedEpisode(next.local, mediaTitleId(context.media), episodeCoordinate(context.episode));
    return next;
}

export function applySimklWatchedPatches(
    state: EpisodeWatchState,
    patches: WatchedShowPatch[]
): EpisodeWatchState {
    const next = parseEpisodeWatchState(state);
    for (const patch of parseWatchedShows(patches)) {
        next.simkl = next.simkl.filter((show) => show.id !== patch.id);
        if (patch.episodes.length > 0) next.simkl.push(patch);
    }
    return next;
}

export function clearSimklWatched(state: EpisodeWatchState): EpisodeWatchState {
    return { ...parseEpisodeWatchState(state), simkl: [] };
}

export function isEpisodeWatched(
    state: EpisodeWatchState,
    media: Media,
    episode: Episode,
    legacyHistory: WatchHistoryEntry[] = []
): boolean {
    const titleId = mediaTitleId(media);
    const coordinate = episodeCoordinate(episode);
    if ([...state.local, ...state.simkl].some((show) =>
        show.id === titleId && show.episodes.includes(coordinate))) return true;
    return legacyHistory.some((entry) =>
        entry.watched
        && entry.episode != null
        && historyTitleId(entry) === titleId
        && episodeCoordinate(entry.episode) === coordinate);
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
    const titleId = mediaTitleId(context.media);
    return [entry, ...entries.filter((item) =>
        item.id !== id
        && (entry.watched || item.watched || historyTitleId(item) !== titleId)
    )].slice(0, MAX_HISTORY_ITEMS);
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
    return mediaTitleId(entry.media);
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

function parseWatchedShows(value: unknown): WatchedShow[] {
    if (!Array.isArray(value)) return [];
    const shows: WatchedShow[] = [];
    for (const valueShow of value) {
        const item = getRecord(valueShow);
        const id = getString(item?.id).trim();
        if (!id || !Array.isArray(item?.episodes)) continue;
        const existing = shows.find((show) => show.id === id);
        const show = existing || { id, episodes: [] };
        if (!existing) shows.push(show);
        for (const coordinate of item.episodes) {
            if (typeof coordinate !== "string" || !isEpisodeCoordinate(coordinate)) continue;
            if (!show.episodes.includes(coordinate)) show.episodes.push(coordinate);
        }
        show.episodes.sort(compareEpisodeCoordinates);
    }
    return shows;
}

function addWatchedEpisode(shows: WatchedShow[], id: string, coordinate: string): void {
    if (!id || !isEpisodeCoordinate(coordinate)) return;
    let show = shows.find((item) => item.id === id);
    if (!show) {
        show = { id, episodes: [] };
        shows.push(show);
    }
    if (!show.episodes.includes(coordinate)) show.episodes.push(coordinate);
    show.episodes.sort(compareEpisodeCoordinates);
}

function isEpisodeCoordinate(value: string): boolean {
    const match = /^(\d+):(\d+)$/.exec(value);
    if (!match) return false;
    return match.slice(1).every((part) => Number.isSafeInteger(Number(part)));
}

function compareEpisodeCoordinates(first: string, second: string): number {
    const [firstSeason, firstEpisode] = first.split(":").map(Number);
    const [secondSeason, secondEpisode] = second.split(":").map(Number);
    return firstSeason - secondSeason || firstEpisode - secondEpisode;
}

function mediaTitleId(media: Media): string {
    return media.imdbId || media.providerId || media.id;
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
