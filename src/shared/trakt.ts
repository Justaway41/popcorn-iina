import type { WatchHistoryEntry } from "./history";
import type { PlaybackContext } from "./messages";
import { isImdbId } from "./stremio";

export interface TraktTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

export interface TraktState {
    clientId: string;
    clientSecret: string;
    tokens: TraktTokens | null;
    reconnectRequired: boolean;
    initialHistoryUploaded: boolean;
    lastSyncAt: string;
    lastError: string;
    retryAt: number;
}

export interface TraktScrobblePayload {
    progress: number;
    movie?: { ids: { imdb: string } };
    show?: { ids: { imdb: string } };
    episode?: { season: number; number: number };
}

export interface TraktResponse {
    status: number;
    data: unknown;
    headers: Record<string, string>;
}

export type TraktTransport = (
    method: "GET" | "POST",
    url: string,
    body: unknown,
    headers: Record<string, string>
) => Promise<TraktResponse>;

export interface TraktDeviceCode {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresAt: number;
    intervalMs: number;
}

export type TraktScrobbleAction = "start" | "pause" | "stop";

export class TraktError extends Error {
    constructor(
        public readonly status: number,
        public readonly retryAt = 0,
        message = `Trakt request failed with status ${status}.`
    ) {
        super(message);
        this.name = "TraktError";
    }
}

const TRAKT_API = "https://api.trakt.tv";
const TRAKT_ACCOUNT_URL = "https://trakt.tv/join";
const TRAKT_APPLICATIONS_URL = "https://app.trakt.tv/settings/apps/api";
const MAX_HISTORY_ITEMS = 100;
const TOKEN_REFRESH_WINDOW_MS = 60_000;
const DEFAULT_RETRY_MS = 60_000;

export function parseTraktExternalLinkRequest(value: unknown): string {
    const url = getString(getRecord(value)?.url);
    if (url === TRAKT_ACCOUNT_URL || url === TRAKT_APPLICATIONS_URL) return url;
    return /^https:\/\/trakt\.tv\/activate\/[A-Za-z0-9_-]+$/.test(url) ? url : "";
}

function apiHeaders(state: TraktState): Record<string, string> {
    return {
        Accept: "application/json",
        "Content-Type": "application/json",
        "trakt-api-key": state.clientId,
        "trakt-api-version": "2",
        ...(state.tokens ? { Authorization: `Bearer ${state.tokens.accessToken}` } : {})
    };
}

export function parseTraktState(value: unknown): TraktState {
    const item = getRecord(parseJson(value));
    const tokens = getRecord(item?.tokens);
    const accessToken = getString(tokens?.accessToken);
    const refreshToken = getString(tokens?.refreshToken);
    const expiresAt = getPositiveNumber(tokens?.expiresAt);
    return {
        clientId: getString(item?.clientId),
        clientSecret: getString(item?.clientSecret),
        tokens: accessToken && refreshToken && expiresAt
            ? { accessToken, refreshToken, expiresAt }
            : null,
        reconnectRequired: item?.reconnectRequired === true,
        initialHistoryUploaded: item?.initialHistoryUploaded === true,
        lastSyncAt: getString(item?.lastSyncAt),
        lastError: getString(item?.lastError),
        retryAt: getNonNegativeNumber(item?.retryAt)
    };
}

export function buildScrobblePayload(
    context: PlaybackContext,
    progress: number
): TraktScrobblePayload {
    const value = Math.max(0, Math.min(100, progress));
    if (!context.episode) {
        return { movie: { ids: { imdb: context.media.imdbId } }, progress: value };
    }
    return {
        show: { ids: { imdb: context.media.imdbId } },
        episode: { season: context.episode.season, number: context.episode.episode },
        progress: value
    };
}

export async function requestDeviceCode(
    transport: TraktTransport,
    state: TraktState,
    now = Date.now()
): Promise<TraktDeviceCode> {
    const data = await request(
        transport,
        state,
        "POST",
        "/oauth/device/code",
        { client_id: state.clientId },
        now
    );
    const item = getRecord(data);
    const deviceCode = getString(item?.device_code);
    const userCode = getString(item?.user_code);
    const verificationUrl = getString(item?.verification_url);
    const expiresIn = getPositiveNumber(item?.expires_in);
    const interval = getPositiveNumber(item?.interval);
    if (!deviceCode || !userCode || !verificationUrl || !expiresIn || !interval) {
        throw new Error("Invalid Trakt device code response.");
    }
    return {
        deviceCode,
        userCode,
        verificationUrl,
        expiresAt: now + expiresIn * 1000,
        intervalMs: interval * 1000
    };
}

export async function pollDeviceToken(
    transport: TraktTransport,
    state: TraktState,
    code: TraktDeviceCode,
    wait: (ms: number) => Promise<void>
): Promise<TraktState> {
    let intervalMs = code.intervalMs;
    while (Date.now() < code.expiresAt) {
        const response = await transport(
            "POST",
            `${TRAKT_API}/oauth/device/token`,
            {
                code: code.deviceCode,
                client_id: state.clientId,
                client_secret: state.clientSecret
            },
            apiHeaders(state)
        );
        if (response.status === 200) {
            return {
                ...state,
                tokens: parseTokens(response.data),
                reconnectRequired: false,
                lastError: "",
                retryAt: 0
            };
        }
        if (response.status === 404) {
            throw new TraktError(response.status, 0, "Trakt device code is invalid.");
        }
        if (response.status === 409) {
            throw new TraktError(response.status, 0, "Trakt device code was already used.");
        }
        if (response.status === 410) {
            throw new TraktError(response.status, 0, "Trakt device code expired.");
        }
        if (response.status === 418) {
            throw new TraktError(response.status, 0, "Trakt device authorization was denied.");
        }
        if (response.status === 429) {
            intervalMs += retryAfterMs(response.headers) ?? code.intervalMs;
        } else if (response.status !== 400) {
            throw responseError(response, Date.now());
        }
        if (Date.now() + intervalMs >= code.expiresAt) break;
        await wait(intervalMs);
    }
    throw new TraktError(410, 0, "Trakt device code expired.");
}

export async function refreshTraktTokens(
    transport: TraktTransport,
    state: TraktState,
    now = Date.now()
): Promise<TraktState> {
    if (!state.tokens || state.tokens.expiresAt - now >= TOKEN_REFRESH_WINDOW_MS) {
        return state;
    }
    try {
        const data = await request(
            transport,
            state,
            "POST",
            "/oauth/token",
            {
                refresh_token: state.tokens.refreshToken,
                client_id: state.clientId,
                client_secret: state.clientSecret,
                redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
                grant_type: "refresh_token"
            },
            now
        );
        return {
            ...state,
            tokens: parseTokens(data),
            reconnectRequired: false,
            lastError: "",
            retryAt: 0
        };
    } catch (error) {
        if (isRefreshRejection(error)) return reconnectState(state);
        throw error;
    }
}

export async function scrobble(
    transport: TraktTransport,
    state: TraktState,
    action: TraktScrobbleAction,
    context: PlaybackContext,
    progress: number,
    now = Date.now()
): Promise<TraktState> {
    if (!isImdbId(context.media.imdbId)) return state;
    if (state.retryAt > now) return state;
    let current = state;
    try {
        current = await refreshTraktTokens(transport, current, now);
        if (!current.tokens) {
            return current.reconnectRequired
                ? current
                : { ...current, lastError: "Trakt is not connected." };
        }
        await request(
            transport,
            current,
            "POST",
            `/scrobble/${action}`,
            buildScrobblePayload(context, progress),
            now
        );
        return { ...current, lastError: "", retryAt: 0 };
    } catch (error) {
        if (isAuthenticationError(error)) return reconnectState(current);
        return {
            ...current,
            lastError: error instanceof Error ? error.message : "Trakt request failed.",
            retryAt: error instanceof TraktError ? error.retryAt : 0
        };
    }
}

export async function syncTraktHistory(
    transport: TraktTransport,
    state: TraktState,
    local: WatchHistoryEntry[],
    now = Date.now()
): Promise<{ state: TraktState; history: WatchHistoryEntry[] }> {
    if (state.retryAt > now) return { state, history: local };
    let current = state;
    try {
        current = await refreshTraktTokens(transport, state, now);
        if (!current.tokens) {
            return {
                state: current.reconnectRequired
                    ? current
                    : { ...current, lastError: "Trakt is not connected." },
                history: local
            };
        }

        const playback = await request(transport, current, "GET", "/sync/playback", null, now);
        const watched = await request(
            transport,
            current,
            "GET",
            "/sync/history?limit=100",
            null,
            now
        );
        const history = mergeWatchHistory(local, parseTraktHistory(playback, watched));

        if (!current.initialHistoryUploaded) {
            const remoteWatched = new Set(
                parseTraktHistory([], watched).map(historyKey)
            );
            const pending = local.filter(
                (entry) => entry.watched && isImdbId(entry.media.imdbId) && !remoteWatched.has(historyKey(entry))
            );
            if (pending.length > 0) {
                await request(
                    transport,
                    current,
                    "POST",
                    "/sync/history",
                    historyUploadPayload(pending),
                    now
                );
            }
        }

        return {
            state: {
                ...current,
                initialHistoryUploaded: true,
                lastSyncAt: new Date(now).toISOString(),
                lastError: "",
                retryAt: 0
            },
            history
        };
    } catch (error) {
        if (isAuthenticationError(error)) {
            return { state: reconnectState(current), history: local };
        }
        if (!(error instanceof TraktError) || error.status !== 429) throw error;
        return {
            state: { ...current, lastError: error.message, retryAt: error.retryAt },
            history: local
        };
    }
}

function isAuthenticationError(error: unknown): error is TraktError {
    return error instanceof TraktError && error.status === 401;
}

function isRefreshRejection(error: unknown): error is TraktError {
    return error instanceof TraktError && (error.status === 400 || error.status === 401);
}

function reconnectState(state: TraktState): TraktState {
    return {
        ...state,
        tokens: null,
        reconnectRequired: true,
        lastError: "Trakt connection expired. Reconnect required.",
        retryAt: 0
    };
}

export function parseTraktHistory(playback: unknown, watched: unknown): WatchHistoryEntry[] {
    const entries = [
        ...(Array.isArray(playback) ? playback.flatMap((item) => parseRemote(item, false)) : []),
        ...(Array.isArray(watched) ? watched.flatMap((item) => parseRemote(item, true)) : [])
    ];
    return mergeWatchHistory([], entries);
}

export function mergeWatchHistory(
    local: WatchHistoryEntry[],
    remote: WatchHistoryEntry[]
): WatchHistoryEntry[] {
    const entries = new Map<string, WatchHistoryEntry>();
    for (const entry of [...local, ...remote]) {
        const key = historyKey(entry);
        const existing = entries.get(key);
        entries.set(key, existing ? mergeEntry(existing, entry) : entry);
    }
    return [...entries.values()]
        .sort((a, b) => timestamp(b.lastPlayedAt) - timestamp(a.lastPlayedAt))
        .slice(0, MAX_HISTORY_ITEMS);
}

function parseRemote(value: unknown, watched: boolean): WatchHistoryEntry[] {
    const item = getRecord(value);
    const playedAt = getString(item?.[watched ? "watched_at" : "paused_at"]);
    if (!item || !playedAt) return [];
    const progress = watched ? 100 : clampProgress(item.progress);
    if (progress === null) return [];

    if (item.type === "movie") {
        const movie = getRecord(item.movie);
        const imdbId = getString(getRecord(movie?.ids)?.imdb);
        const name = getString(movie?.title);
        if (!imdbId || !name) return [];
        return [{
            id: imdbId,
            media: remoteMedia(imdbId, "movie", name, movie?.year),
            lastPlayedAt: playedAt,
            watched,
            progress
        }];
    }

    if (item.type !== "episode") return [];
    const show = getRecord(item.show);
    const episode = getRecord(item.episode);
    const imdbId = getString(getRecord(show?.ids)?.imdb);
    const showName = getString(show?.title);
    const season = getFiniteNumber(episode?.season);
    const number = getFiniteNumber(episode?.number);
    if (!imdbId || !showName || season === null || number === null) return [];
    return [{
        id: `${imdbId}:${season}:${number}`,
        media: remoteMedia(imdbId, "series", showName, show?.year),
        episode: {
            id: `${imdbId}:${season}:${number}`,
            name: getString(episode?.title) || `Episode ${season}x${number}`,
            season,
            episode: number,
            aired: getString(episode?.first_aired),
            description: getString(episode?.overview),
            thumbnail: ""
        },
        lastPlayedAt: playedAt,
        watched,
        progress
    }];
}

function mergeEntry(first: WatchHistoryEntry, second: WatchHistoryEntry): WatchHistoryEntry {
    const [older, newer] = timestamp(first.lastPlayedAt) > timestamp(second.lastPlayedAt)
        ? [second, first]
        : [first, second];
    return {
        ...newer,
        media: { ...newer.media, poster: older.media.poster || newer.media.poster },
        ...(newer.episode || older.episode ? {
            episode: mergeEpisode(older.episode, newer.episode)
        } : {}),
        watched: older.watched || newer.watched
    };
}

function mergeEpisode(
    older: WatchHistoryEntry["episode"],
    newer: WatchHistoryEntry["episode"]
) {
    if (!newer) return older!;
    if (!older) return newer;
    return {
        ...newer,
        description: older.description || newer.description,
        thumbnail: older.thumbnail || newer.thumbnail
    };
}

async function request(
    transport: TraktTransport,
    state: TraktState,
    method: "GET" | "POST",
    path: string,
    body: unknown,
    now: number
): Promise<unknown> {
    const response = await transport(
        method,
        `${TRAKT_API}${path}`,
        body,
        apiHeaders(state)
    );
    if (response.status >= 200 && response.status < 300) return response.data;
    throw responseError(response, now);
}

function responseError(response: TraktResponse, now: number): TraktError {
    const retryAt = response.status === 429
        ? now + (retryAfterMs(response.headers) ?? DEFAULT_RETRY_MS)
        : 0;
    return new TraktError(
        response.status,
        retryAt,
        response.status === 429
            ? "Trakt rate limit exceeded."
            : `Trakt request failed with status ${response.status}.`
    );
}

function retryAfterMs(headers: Record<string, string>): number | null {
    const value = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
    const seconds = Number(value);
    return value !== undefined && Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1000
        : null;
}

function parseTokens(value: unknown): TraktTokens {
    const item = getRecord(value);
    const accessToken = getString(item?.access_token);
    const refreshToken = getString(item?.refresh_token);
    const createdAt = getNonNegativeNumberOrNull(item?.created_at);
    const expiresIn = getPositiveNumber(item?.expires_in);
    if (!accessToken || !refreshToken || createdAt === null || !expiresIn) {
        throw new Error("Invalid Trakt token response.");
    }
    return {
        accessToken,
        refreshToken,
        expiresAt: (createdAt + expiresIn) * 1000
    };
}

function historyUploadPayload(entries: WatchHistoryEntry[]) {
    const episodes = entries.filter((entry) => entry.episode);
    return {
        movies: entries.flatMap((entry) => entry.episode ? [] : [{
            watched_at: entry.lastPlayedAt,
            ids: { imdb: entry.media.imdbId }
        }]),
        episodes: [],
        ...(episodes.length > 0 ? {
            shows: episodes.map((entry) => ({
                ids: { imdb: entry.media.imdbId },
                seasons: [{
                    number: entry.episode!.season,
                    episodes: [{
                        number: entry.episode!.episode,
                        watched_at: entry.lastPlayedAt
                    }]
                }]
            }))
        } : {})
    };
}

export function remoteMedia(
    imdbId: string,
    type: "movie" | "series",
    name: string,
    year: unknown
) {
    return {
        id: imdbId,
        imdbId,
        type,
        name,
        releaseInfo: typeof year === "number" || typeof year === "string" ? String(year) : "",
        poster: ""
    };
}

function timestamp(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function historyKey(entry: WatchHistoryEntry): string {
    return entry.episode
        ? `${entry.media.imdbId}:${entry.episode.season}:${entry.episode.episode}`
        : entry.media.imdbId;
}

export function parseJson(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

export function clampProgress(value: unknown): number | null {
    const progress = getFiniteNumber(value);
    return progress === null ? null : Math.max(0, Math.min(100, progress));
}

export function getRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function getString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

export function getFiniteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function getPositiveNumber(value: unknown): number | null {
    const number = getFiniteNumber(value);
    return number !== null && number > 0 ? number : null;
}

export function getNonNegativeNumber(value: unknown): number {
    const number = getFiniteNumber(value);
    return number !== null && number >= 0 ? number : 0;
}

function getNonNegativeNumberOrNull(value: unknown): number | null {
    const number = getFiniteNumber(value);
    return number !== null && number >= 0 ? number : null;
}
