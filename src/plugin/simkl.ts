import type { PlaybackContext } from "../shared/messages";
import {
    parseSimklState,
    simklScrobble,
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
}

export function createIinaSimklClient(
    http: IINA.API.HTTP,
    preferences: IINA.API.Preferences,
    onError: (error: unknown) => void
): IinaSimklClient {
    const transport = createIinaTransport(http);
    const read = () => parseSimklState(preferences.get("simkl"));
    let pending = Promise.resolve();

    return {
        sendPlayback(action, context, progress) {
            const result = pending.then(async () => {
                const state = read();
                if (!state.accessToken) return;
                try {
                    const next = await simklScrobble(transport, state, action, context, progress);
                    // Only write back if the connection did not change underneath us, so a
                    // scrobble in flight cannot resurrect a token cleared in preferences.
                    if (sameConnection(read(), state)) {
                        preferences.set("simkl", next);
                        preferences.sync();
                    }
                } catch (error) {
                    onError(error);
                }
            });
            pending = result.then(() => {}, () => {});
            return result;
        }
    };
}

function sameConnection(current: SimklState, input: SimklState): boolean {
    return current.clientId === input.clientId && current.accessToken === input.accessToken;
}
