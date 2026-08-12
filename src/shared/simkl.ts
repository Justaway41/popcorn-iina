import type { PlaybackContext } from "./messages";
import { isImdbId } from "./stremio";
import {
    buildScrobblePayload,
    getNonNegativeNumber,
    getPositiveNumber,
    getRecord,
    getString,
    parseJson,
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
        retryAt: getNonNegativeNumber(item?.retryAt)
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
    while (Date.now() < pin.expiresAt) {
        const data = await request(
            transport,
            state,
            "GET",
            pinPath(state, pin.userCode),
            null,
            Date.now()
        );
        const item = getRecord(data);
        const accessToken = getString(item?.access_token);
        // Simkl answers `result: "KO"` for a code nobody has approved yet.
        if (isOk(item) && accessToken) {
            return { ...state, accessToken, lastError: "", retryAt: 0 };
        }
        if (Date.now() + pin.intervalMs >= pin.expiresAt) break;
        await wait(pin.intervalMs);
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
