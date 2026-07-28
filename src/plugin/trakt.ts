import type { WatchHistoryEntry } from "../shared/history";
import type { PlaybackContext } from "../shared/messages";
import {
    parseTraktState,
    scrobble,
    syncTraktHistory,
    type TraktScrobbleAction,
    type TraktTransport
} from "../shared/trakt";

export function createIinaTransport(http: IINA.API.HTTP): TraktTransport {
    return async (method, url, body, headers) => {
        const options = { params: {}, headers, data: body };
        const response = method === "GET"
            ? await http.get(url, options)
            : await http.post(url, options);
        return {
            status: response.statusCode,
            data: response.data ?? safeJson(response.text),
            headers: {}
        };
    };
}

function safeJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

export interface IinaTraktClient {
    sendPlayback(
        action: TraktScrobbleAction,
        context: PlaybackContext,
        progress: number
    ): Promise<void>;
    sync(history: WatchHistoryEntry[]): Promise<WatchHistoryEntry[]>;
}

export function createIinaTraktClient(
    http: IINA.API.HTTP,
    preferences: IINA.API.Preferences,
    onError: (error: unknown) => void
): IinaTraktClient {
    const transport = createIinaTransport(http);
    const read = () => parseTraktState(preferences.get("trakt"));
    const save = (state: ReturnType<typeof parseTraktState>) => {
        preferences.set("trakt", JSON.stringify(state));
        preferences.sync();
    };
    const saveIfCurrent = (
        input: ReturnType<typeof parseTraktState>,
        output: ReturnType<typeof parseTraktState>
    ) => {
        if (sameConnection(read(), input)) save(output);
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
                if (!state.tokens) return;
                try {
                    saveIfCurrent(
                        state,
                        await scrobble(transport, state, action, context, progress)
                    );
                } catch (error) {
                    onError(error);
                }
            });
        },
        sync(history) {
            return enqueue(async () => {
                const state = read();
                if (!state.tokens) return history;
                try {
                    const result = await syncTraktHistory(transport, state, history);
                    saveIfCurrent(state, result.state);
                    return result.history;
                } catch (error) {
                    onError(error);
                    return history;
                }
            });
        }
    };
}

function sameConnection(
    current: ReturnType<typeof parseTraktState>,
    input: ReturnType<typeof parseTraktState>
): boolean {
    return current.clientId === input.clientId &&
        current.clientSecret === input.clientSecret &&
        current.tokens?.accessToken === input.tokens?.accessToken &&
        current.tokens?.refreshToken === input.tokens?.refreshToken &&
        current.tokens?.expiresAt === input.tokens?.expiresAt;
}
