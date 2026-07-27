export function shouldOfferNextEpisode(isReplacingPlayback: boolean, reachedNaturalEof: boolean): boolean {
    return !isReplacingPlayback && reachedNaturalEof;
}

export function getPlaybackMilestone(
    percent: number,
    recentRecorded: boolean,
    watchedRecorded: boolean
): 5 | 90 | null {
    if (percent >= 90 && !watchedRecorded) return 90;
    if (percent >= 5 && !recentRecorded) return 5;
    return null;
}
