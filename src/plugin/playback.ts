export function shouldOfferNextEpisode(isReplacingPlayback: boolean, reachedNaturalEof: boolean): boolean {
    return !isReplacingPlayback && reachedNaturalEof;
}

export function shouldSaveProgress(
    nowMs: number,
    lastSavedAtMs: number,
    intervalMs: number
): boolean {
    return nowMs - lastSavedAtMs >= intervalMs;
}
