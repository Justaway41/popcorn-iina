import type { WatchedCour, WatchedShowPatch, WatchHistoryEntry } from "../shared/history";
import type { PlaybackContext } from "../shared/messages";
import {
    parseSimklState,
    simklScrobble,
    syncSimklHistory,
    uploadSimklHistory,
    type AnimeCourEpisode,
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
    sync(history: WatchHistoryEntry[]): Promise<{
        history: WatchHistoryEntry[];
        watchedPatches: WatchedShowPatch[];
        watchedCours: WatchedCour[];
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
        sync(history) {
            return enqueue(async () => {
                const state = read();
                const empty = { history, watchedPatches: [], watchedCours: [] };
                if (!state.accessToken) return empty;
                try {
                    const result = await syncSimklHistory(transport, state, history);
                    if (!saveIfCurrent(state, result.state)) return empty;
                    return {
                        history: result.history,
                        watchedPatches: result.watchedPatches,
                        watchedCours: result.watchedCours
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
