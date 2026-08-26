export function shouldOfferNextEpisode(isReplacingPlayback: boolean, reachedNaturalEof: boolean): boolean {
    return !isReplacingPlayback && reachedNaturalEof;
}

export function isCurrentRequest(expectedRevision: number, currentRevision: number): boolean {
    return expectedRevision === currentRevision;
}

export function shouldSaveProgress(
    nowMs: number,
    lastSavedAtMs: number,
    intervalMs: number
): boolean {
    return nowMs - lastSavedAtMs >= intervalMs;
}

export function shouldSendWatchedStop(progress: number, stopSent: boolean): boolean {
    return !stopSent && Number.isFinite(progress) && progress >= 90;
}

/**
 * A prefetched stream link is generated when the episode starts, and debrid links can expire
 * within tens of minutes; playing a stale one fails in mpv with "Cannot open file or stream".
 * Past this age the link must be re-fetched through the sidebar instead of played blind.
 */
export function isPrefetchFresh(prefetchedAtMs: number, nowMs: number, maxAgeMs: number): boolean {
    return Number.isFinite(prefetchedAtMs) && nowMs - prefetchedAtMs >= 0 && nowMs - prefetchedAtMs < maxAgeMs;
}
