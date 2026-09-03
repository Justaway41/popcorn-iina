import type { WatchedShowPatch, WatchHistoryEntry } from "../shared/history";
import type { PlaybackContext } from "../shared/messages";
import {
    parseSimklState,
    simklScrobble,
    syncSimklHistory,
    type SimklScrobbleAction,
    type SimklState
} from "../shared/simkl";
import { createIinaTransport } from "./trakt";

export interface IinaSimklClient {
    sendPlayback(
        action: SimklScrobbleAction,
        context: PlaybackContext,
        progress: number
    ): Promise<void>;
    sync(history: WatchHistoryEntry[]): Promise<{
        history: WatchHistoryEntry[];
        watchedPatches: WatchedShowPatch[];
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
        sendPlayback(action, context, progress) {
            return enqueue(async () => {
                const state = read();
                if (!state.accessToken) return;
                try {
                    saveIfCurrent(
                        state,
                        await simklScrobble(transport, state, action, context, progress)
                    );
                } catch (error) {
                    onError(error);
                }
            });
        },
        sync(history) {
            return enqueue(async () => {
                const state = read();
                if (!state.accessToken) return { history, watchedPatches: [] };
                try {
                    const result = await syncSimklHistory(transport, state, history);
                    if (!saveIfCurrent(state, result.state)) {
                        return { history, watchedPatches: [] };
                    }
                    return { history: result.history, watchedPatches: result.watchedPatches };
                } catch (error) {
                    onError(error);
                    return { history, watchedPatches: [] };
                }
            });
        }
    };
}

function sameConnection(current: SimklState, input: SimklState): boolean {
    return current.clientId === input.clientId && current.accessToken === input.accessToken;
}
