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
