import type { WatchedCour, WatchedShowPatch, WatchHistoryEntry } from "../shared/history";
import type { PlaybackContext } from "../shared/messages";
import {
    parseSimklState,
    simklScrobble,
    syncSimklHistory,
    uploadSimklHistory,
    resolveSimklCourChains,
    uploadSimklResume,
    type AnimeCourEpisode,
    type SimklAnimeNode,
    type SimklCourChain,
    type SimklResumePoint,
    type SimklUploadEpisode,
    type SimklScrobbleAction,
    type SimklState
} from "../shared/simkl";
import { createIinaTransport } from "./trakt";

export interface IinaSimklClient {
    sendPlayback(
        action: SimklScrobbleAction,
        context: PlaybackContext,
        progress: number,
        cour: AnimeCourEpisode | null
    ): Promise<void>;
    /** Sends locally watched episodes Simkl has never been told about. */
    upload(episodes: SimklUploadEpisode[]): Promise<void>;
    /** Sends where playback was left for anything still unfinished. */
    uploadResume(points: SimklResumePoint[]): Promise<void>;
    /** The airing order of each franchise a cour belongs to, read from Simkl's own relations. */
    courChains(cours: WatchedCour[]): Promise<SimklCourChain[]>;
    /**
     * Pulls what changed on Simkl. The cursor does not move until `commit` is called, which the
     * caller does only after storing what came back: saved first, an interrupted sync skipped
     * those changes for good, since an incremental pull never sends them again.
     */
    sync(history: WatchHistoryEntry[]): Promise<{
        history: WatchHistoryEntry[];
        /** Only what Simkl reported, for deciding what it is still missing. */
        remoteHistory: WatchHistoryEntry[];
        /** Whether this pull carried everything, so held state can be rebuilt from it. */
        fullPull: boolean;
        watchedPatches: WatchedShowPatch[];
        watchedCours: WatchedCour[];
        commit(): void;
    }>;
}

export function createIinaSimklClient(
    http: IINA.API.HTTP,
    preferences: IINA.API.Preferences,
    onError: (error: unknown) => void
): IinaSimklClient {
    const transport = createIinaTransport(http);
    const read = () => parseSimklState(preferences.get("simkl"));
    // Only write back if the connection did not change underneath us, so a request in
    // flight cannot resurrect a token cleared in preferences.
    const saveIfCurrent = (input: SimklState, output: SimklState) => {
        if (!sameConnection(read(), input)) return false;
        preferences.set("simkl", output);
        preferences.sync();
        return true;
    };
    // Franchise shapes do not change within a session.
    const animeNodes = new Map<string, SimklAnimeNode | null>();
    let pending = Promise.resolve();
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = pending.then(operation);
        pending = result.then(() => {}, () => {});
        return result;
    };

    return {
        sendPlayback(action, context, progress, cour) {
            return enqueue(async () => {
                const state = read();
                if (!state.accessToken) return;
                try {
                    saveIfCurrent(
                        state,
                        await simklScrobble(transport, state, action, context, progress, cour)
                    );
                } catch (error) {
                    onError(error);
                }
            });
        },
        upload(episodes) {
            return enqueue(async () => {
                const state = read();
                if (!state.accessToken) return;
                try {
                    saveIfCurrent(state, await uploadSimklHistory(transport, state, episodes));
                } catch (error) {
                    onError(error);
                }
            });
        },
        uploadResume(points) {
            return enqueue(async () => {
                const state = read();
                if (!state.accessToken) return;
                try {
                    saveIfCurrent(state, await uploadSimklResume(transport, state, points));
                } catch (error) {
                    onError(error);
                }
            });
        },
        courChains(cours) {
            return enqueue(async () => {
                const state = read();
                if (!state.accessToken) return [];
                try {
                    return await resolveSimklCourChains(transport, state, cours, animeNodes);
                } catch (error) {
                    onError(error);
                    return [];
                }
            });
        },
        sync(history) {
            return enqueue(async () => {
                const state = read();
                const empty = {
                    history,
                    remoteHistory: [],
                    fullPull: false,
                    watchedPatches: [],
                    watchedCours: [],
                    commit: () => {}
                };
                if (!state.accessToken) return empty;
                try {
                    const result = await syncSimklHistory(transport, state, history);
                    // A failed pull records its error, retry window, or cleared token at once.
                    if (result.state.lastError || !result.state.accessToken) {
                        saveIfCurrent(state, result.state);
                        return empty;
                    }
                    if (!sameConnection(read(), state)) return empty;
                    return {
                        history: result.history,
                        remoteHistory: result.remoteHistory,
                        fullPull: result.fullPull,
                        watchedPatches: result.watchedPatches,
                        watchedCours: result.watchedCours,
                        // The caller flushes: IINA drops a preference write that lands on the
                        // heels of another, and the pull's data and its cursor belong in one
                        // flush anyway - a lost flush must not leave the cursor past data that
                        // was never stored.
                        commit: () => {
                            // Re-read so a scrobble or upload saved meanwhile keeps its fields;
                            // only what this pull owns is written.
                            const current = read();
                            if (!sameConnection(current, state)) return;
                            preferences.set("simkl", {
                                ...current,
                                lastActivityAt: result.state.lastActivityAt,
                                lastSyncAt: result.state.lastSyncAt,
                                fullPullVersion: result.state.fullPullVersion,
                                lastError: "",
                                retryAt: 0
                            });
                        }
                    };
                } catch (error) {
                    onError(error);
                    return empty;
                }
            });
        }
    };
}

function sameConnection(current: SimklState, input: SimklState): boolean {
    return current.clientId === input.clientId && current.accessToken === input.accessToken;
}
