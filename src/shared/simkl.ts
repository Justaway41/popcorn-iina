import type { WatchHistoryEntry } from "./history";
import type { PlaybackContext } from "./messages";
import { isImdbId } from "./stremio";
import {
    buildScrobblePayload,
    clampProgress,
    getFiniteNumber,
    getNonNegativeNumber,
    getPositiveNumber,
    getRecord,
    getString,
    mergeWatchHistory,
    parseJson,
    remoteMedia,
    type TraktResponse as HttpResponse,
    type TraktScrobbleAction as SimklScrobbleAction,
    type TraktTransport as HttpTransport
} from "./trakt";

export type { SimklScrobbleAction };

export interface SimklState {
    clientId: string;
    /** Long-lived; Simkl issues no refresh token. Never log this. */
    accessToken: string;
    lastError: string;
    retryAt: number;
    /**
     * The `all` timestamp from the last `/sync/activities` read. Doubles as the
     * `date_from` cursor. Simkl suspends client ids that pull the full list every time.
     */
    lastActivityAt: string;
}

export interface SimklPin {
    userCode: string;
    verificationUrl: string;
    expiresAt: number;
    intervalMs: number;
}

export class SimklError extends Error {
    constructor(
        public readonly status: number,
        public readonly retryAt = 0,
        message = `Simkl request failed with status ${status}.`
    ) {
        super(message);
        this.name = "SimklError";
    }
}

const SIMKL_API = "https://api.simkl.com";
const SIMKL_PIN_URL = "https://simkl.com/pin";
const SIMKL_DEVELOPER_URL = "https://simkl.com/settings/developer";
const DEFAULT_RETRY_MS = 60_000;

export function parseSimklExternalLinkRequest(value: unknown): string {
    const url = getString(getRecord(value)?.url);
    return url === SIMKL_PIN_URL || url === SIMKL_DEVELOPER_URL ? url : "";
}

export function parseSimklState(value: unknown): SimklState {
    const item = getRecord(parseJson(value));
    return {
        clientId: getString(item?.clientId),
        accessToken: getString(item?.accessToken),
        lastError: getString(item?.lastError),
        retryAt: getNonNegativeNumber(item?.retryAt),
        lastActivityAt: getString(item?.lastActivityAt)
    };
}

export function isSimklConnected(state: SimklState): boolean {
    return state.clientId !== "" && state.accessToken !== "";
}

export async function requestSimklPin(
    transport: HttpTransport,
    state: SimklState,
    now = Date.now()
): Promise<SimklPin> {
    const data = await request(transport, state, "GET", pinPath(state), null, now);
    const item = getRecord(data);
    const userCode = getString(item?.user_code);
    const verificationUrl = getString(item?.verification_url) || SIMKL_PIN_URL;
    const expiresIn = getPositiveNumber(item?.expires_in);
    const interval = getPositiveNumber(item?.interval);
    if (!userCode || !expiresIn || !interval) {
        throw new Error("Invalid Simkl pin response.");
    }
    return {
        userCode,
        verificationUrl,
        expiresAt: now + expiresIn * 1000,
        intervalMs: interval * 1000
    };
}

export async function pollSimklPin(
    transport: HttpTransport,
    state: SimklState,
    pin: SimklPin,
    wait: (ms: number) => Promise<void>
): Promise<SimklState> {
    let intervalMs = pin.intervalMs;
    while (Date.now() < pin.expiresAt) {
        let item: Record<string, unknown> | null = null;
        try {
            item = getRecord(await request(
                transport,
                state,
                "GET",
                pinPath(state, pin.userCode),
                null,
                Date.now()
            ));
        } catch (error: unknown) {
            // A transient failure must not cancel authorization; only a rejected or
            // invalid client id does, and only expiry ends the wait otherwise.
            const simklError = error instanceof SimklError ? error : null;
            if (simklError && simklError.status < 500 && simklError.status !== 429) throw simklError;
            const retryAt = simklError?.retryAt ?? 0;
            if (retryAt > Date.now()) intervalMs = Math.max(intervalMs, retryAt - Date.now());
        }
        const accessToken = getString(item?.access_token);
        // Simkl answers `result: "KO"` for a code nobody has approved yet.
        if (isOk(item) && accessToken) {
            return { ...state, accessToken, lastError: "", retryAt: 0 };
        }
        if (Date.now() + intervalMs >= pin.expiresAt) break;
        await wait(intervalMs);
    }
    throw new Error("Simkl pin expired before it was approved.");
}

export async function simklScrobble(
    transport: HttpTransport,
    state: SimklState,
    action: SimklScrobbleAction,
    context: PlaybackContext,
    progress: number,
    now = Date.now()
): Promise<SimklState> {
    if (!isSimklConnected(state)) return state;
    if (!isImdbId(context.media.imdbId)) return state;
    if (state.retryAt > now) return state;
    try {
        await request(
            transport,
            state,
            "POST",
            `/scrobble/${action}`,
            buildScrobblePayload(context, progress),
            now
        );
        return { ...state, lastError: "", retryAt: 0 };
    } catch (error) {
        // Tokens do not expire, so a 401 means the credentials were revoked or changed.
        if (error instanceof SimklError && error.status === 401) {
            return {
                ...state,
                accessToken: "",
                lastError: "Simkl connection was rejected. Reconnect required.",
                retryAt: 0
            };
        }
        return {
            ...state,
            lastError: error instanceof SimklError ? error.message : "Simkl request failed.",
            retryAt: error instanceof SimklError ? error.retryAt : 0
        };
    }
}

export async function syncSimklHistory(
    transport: HttpTransport,
    state: SimklState,
    local: WatchHistoryEntry[],
    now = Date.now()
): Promise<{ state: SimklState; history: WatchHistoryEntry[] }> {
    if (!isSimklConnected(state) || state.retryAt > now) return { state, history: local };
    try {
        const activities = getRecord(
            await request(transport, state, "GET", "/sync/activities", null, now)
        );
        const activityAt = getString(activities?.all);
        // Nothing changed since the last pull, so skip the expensive lists entirely.
        if (activityAt && activityAt === state.lastActivityAt) {
            return { state: { ...state, lastError: "", retryAt: 0 }, history: local };
        }

        // Without a cursor this is the documented first full sync; after that it stays small.
        const cursor = state.lastActivityAt
            ? `?date_from=${encodeURIComponent(state.lastActivityAt)}`
            : "";
        const items = await request(transport, state, "GET", `/sync/all-items/${cursor}`, null, now);
        const playback = await request(transport, state, "GET", `/sync/playback${cursor}`, null, now);

        return {
            state: {
                ...state,
                lastActivityAt: activityAt || state.lastActivityAt,
                lastError: "",
                retryAt: 0
            },
            history: mergeWatchHistory(local, parseSimklHistory(items, playback))
        };
    } catch (error) {
        if (error instanceof SimklError && error.status === 401) {
            return {
                state: {
                    ...state,
                    accessToken: "",
                    lastError: "Simkl connection was rejected. Reconnect required.",
                    retryAt: 0
                },
                history: local
            };
        }
        return {
            state: {
                ...state,
                lastError: error instanceof SimklError ? error.message : "Simkl request failed.",
                retryAt: error instanceof SimklError ? error.retryAt : 0
            },
            history: local
        };
    }
}

export function parseSimklHistory(items: unknown, playback: unknown): WatchHistoryEntry[] {
    const lists = getRecord(items);
    const entries = [
        ...listEntries(lists?.shows),
        ...listEntries(lists?.anime),
        ...listEntries(lists?.movies),
        ...(Array.isArray(playback) ? playback.flatMap(parsePlayback) : [])
    ];
    return mergeWatchHistory([], entries);
}

function listEntries(value: unknown): WatchHistoryEntry[] {
    return Array.isArray(value) ? value.flatMap(parseListItem) : [];
}

/**
 * One entry per title, from the last episode watched. Simkl can return every watched
 * episode with `extended=full`, but the local history is capped at 100 recent items,
 * so pulling megabytes of back catalogue would only be discarded.
 */
function parseListItem(value: unknown): WatchHistoryEntry[] {
    const item = getRecord(value);
    const playedAt = getString(item?.last_watched_at);
    if (!item || !playedAt) return [];

    const movie = getRecord(item.movie);
    if (movie) {
        const imdbId = getString(getRecord(movie.ids)?.imdb);
        const name = getString(movie.title);
        if (!isImdbId(imdbId) || !name) return [];
        return [{
            id: imdbId,
            media: remoteMedia(imdbId, "movie", name, movie.year),
            lastPlayedAt: playedAt,
            watched: true,
            progress: 100
        }];
    }

    const show = getRecord(item.show);
    const imdbId = getString(getRecord(show?.ids)?.imdb);
    const name = getString(show?.title);
    const position = parseLastWatched(item.last_watched);
    if (!isImdbId(imdbId) || !name || !position) return [];
    return [seriesEntry(imdbId, name, show?.year, position, "", playedAt, true, 100)];
}

/** Simkl writes `S01E05` for shows and bare `E148` for absolute-numbered anime. */
function parseLastWatched(value: unknown): { season: number; episode: number } | null {
    const match = /^(?:S(\d+))?E(\d+)$/i.exec(getString(value).trim());
    if (!match) return null;
    return { season: match[1] ? Number(match[1]) : 1, episode: Number(match[2]) };
}

function parsePlayback(value: unknown): WatchHistoryEntry[] {
    const item = getRecord(value);
    const playedAt = getString(item?.paused_at);
    const progress = clampProgress(item?.progress);
    if (!item || !playedAt || progress === null) return [];

    const movie = getRecord(item.movie);
    if (movie) {
        const imdbId = getString(getRecord(movie.ids)?.imdb);
        const name = getString(movie.title);
        if (!isImdbId(imdbId) || !name) return [];
        return [{
            id: imdbId,
            media: remoteMedia(imdbId, "movie", name, movie.year),
            lastPlayedAt: playedAt,
            watched: false,
            progress
        }];
    }

    const show = getRecord(item.show);
    const episode = getRecord(item.episode);
    const imdbId = getString(getRecord(show?.ids)?.imdb);
    const name = getString(show?.title);
    const season = getFiniteNumber(episode?.season);
    const number = getFiniteNumber(episode?.episode);
    if (!isImdbId(imdbId) || !name || season === null || number === null) return [];
    return [seriesEntry(
        imdbId,
        name,
        show?.year,
        { season, episode: number },
        getString(episode?.title),
        playedAt,
        false,
        progress
    )];
}

function seriesEntry(
    imdbId: string,
    name: string,
    year: unknown,
    position: { season: number; episode: number },
    episodeName: string,
    playedAt: string,
    watched: boolean,
    progress: number
): WatchHistoryEntry {
    const id = `${imdbId}:${position.season}:${position.episode}`;
    return {
        id,
        media: remoteMedia(imdbId, "series", name, year),
        episode: {
            id,
            name: episodeName || `Episode ${position.season}x${position.episode}`,
            season: position.season,
            episode: position.episode,
            aired: "",
            description: "",
            thumbnail: ""
        },
        lastPlayedAt: playedAt,
        watched,
        progress
    };
}

function pinPath(state: SimklState, userCode = ""): string {
    const base = userCode ? `/oauth/pin/${encodeURIComponent(userCode)}` : "/oauth/pin";
    return `${base}?client_id=${encodeURIComponent(state.clientId)}`;
}

function isOk(item: Record<string, unknown> | null): boolean {
    return getString(item?.result).toUpperCase() === "OK";
}

function apiHeaders(state: SimklState): Record<string, string> {
    return {
        Accept: "application/json",
        "Content-Type": "application/json",
        "simkl-api-key": state.clientId,
        ...(state.accessToken ? { Authorization: `Bearer ${state.accessToken}` } : {})
    };
}

async function request(
    transport: HttpTransport,
    state: SimklState,
    method: "GET" | "POST",
    path: string,
    body: unknown,
    now: number
): Promise<unknown> {
    // The client id rides in the query string, so a transport rejection quoting the
    // request URL must never escape this function.
    const response = await transport(
        method,
        `${SIMKL_API}${path}`,
        body,
        apiHeaders(state)
    ).catch(() => {
        throw new Error("Simkl request failed.");
    });
    if (response.status >= 200 && response.status < 300) return response.data;
    throw responseError(response, now);
}

function responseError(response: HttpResponse, now: number): SimklError {
    const retryAt = response.status === 429
        ? now + (retryAfterMs(response.headers) ?? DEFAULT_RETRY_MS)
        : 0;
    return new SimklError(
        response.status,
        retryAt,
        response.status === 429
            ? "Simkl rate limit exceeded."
            : `Simkl request failed with status ${response.status}.`
    );
}

function retryAfterMs(headers: Record<string, string>): number | null {
    const value = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
    const seconds = Number(value);
    return value !== undefined && Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1000
        : null;
}
