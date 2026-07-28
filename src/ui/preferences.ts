import type { StremioAddon } from "../shared/addons";
import type { TraktState, TraktTransport } from "../shared/trakt";

import {
    bindAddonUrlVisibility,
    createAddonUrlVisibilityController
} from "./addon-url-visibility";

import {
    canonicalizeManifestUrl,
    getAddonHostname,
    parseAddonManifest,
    parseAddons
} from "../shared/addons";
import { parseWatchHistory } from "../shared/history";
import {
    mergeWatchHistory,
    parseTraktState,
    pollDeviceToken,
    requestDeviceCode,
    syncTraktHistory
} from "../shared/trakt";
import { CLIENT_VERSION } from "../shared/version";

interface WebviewPreferences {
    get(key: string, callback: (value: unknown) => void): void;
    set(key: string, value: unknown): void;
    sync?(): void;
}

declare global {
    interface Window {
        iina: { preferences: WebviewPreferences };
    }
}

let addons: StremioAddon[] = [];
let trakt = parseTraktState(null);
let traktRevision = 0;

document.documentElement.dataset.version = CLIENT_VERSION;
const preferences = window.iina.preferences as unknown as WebviewPreferences;
const form = element<HTMLFormElement>("addon-form");
const input = element<HTMLInputElement>("addon-url");
const addButton = element<HTMLButtonElement>("add-addon");
const errorMessage = element<HTMLParagraphElement>("addon-error");
const list = element<HTMLDivElement>("addon-list");
const empty = element<HTMLParagraphElement>("addon-empty");
const template = element<HTMLTemplateElement>("addon-row-template");
const traktClientId = element<HTMLInputElement>("trakt-client-id");
const traktClientSecret = element<HTMLInputElement>("trakt-client-secret");
const traktConnect = element<HTMLButtonElement>("trakt-connect");
const traktSync = element<HTMLButtonElement>("trakt-sync");
const traktDisconnect = element<HTMLButtonElement>("trakt-disconnect");
const traktDevice = element<HTMLParagraphElement>("trakt-device");
const traktStatus = element<HTMLParagraphElement>("trakt-status");
const traktError = element<HTMLParagraphElement>("trakt-error");

const browserTransport: TraktTransport = async (method, url, body, headers) => {
    const response = await fetch(url, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json().catch(() => null) as unknown;
    return {
        status: response.status,
        data,
        headers: Object.fromEntries(
            [...response.headers.entries()].map(([key, value]) => [key.toLowerCase(), value])
        )
    };
};

form.addEventListener("submit", (event) => {
    event.preventDefault();
    void addAddon();
});
traktClientId.addEventListener("change", saveTraktCredentials);
traktClientSecret.addEventListener("change", saveTraktCredentials);
traktConnect.addEventListener("click", () => void connectTrakt());
traktSync.addEventListener("click", () => void syncTraktNow());
traktDisconnect.addEventListener("click", disconnectTrakt);

void loadPreferences();

async function loadPreferences(): Promise<void> {
    const [stored, legacy, storedTrakt] = await Promise.all([
        getPreference("addons"),
        getPreference("addonManifestUrl"),
        getPreference("trakt")
    ]);
    const storedAddons = parseAddons(stored);
    addons = parseAddons(stored, legacy);
    trakt = parseTraktState(storedTrakt);
    traktClientId.value = trakt.clientId;
    traktClientSecret.value = trakt.clientSecret;
    render();
    renderTrakt();

    if (storedAddons.length === 0 && addons.length === 1) {
        try {
            const name = await fetchManifestName(addons[0].manifestUrl);
            addons[0] = { ...addons[0], name };
            save();
        } catch {
            // The legacy addon remains usable and can be replaced from this page.
        }
    }
}

async function addAddon(): Promise<void> {
    setError("");
    addButton.disabled = true;
    addButton.textContent = "Adding…";
    try {
        const manifestUrl = canonicalizeManifestUrl(input.value);
        if (addons.some((addon) => addon.manifestUrl === manifestUrl)) {
            throw new Error("This addon is already added.");
        }
        const name = await fetchManifestName(manifestUrl);
        addons.push({ name, manifestUrl, enabled: true });
        input.value = "";
        save();
    } catch (error) {
        setError(error instanceof Error ? error.message : "Could not add this addon.");
    } finally {
        addButton.disabled = false;
        addButton.textContent = "Add Addon";
    }
}

async function fetchManifestName(manifestUrl: string): Promise<string> {
    const response = await fetch(manifestUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Manifest request failed with HTTP ${response.status}.`);
    return parseAddonManifest(await response.json() as unknown);
}

function render(): void {
    list.replaceChildren(...addons.map((addon, index) => {
        const row = template.content.firstElementChild?.cloneNode(true) as HTMLElement | null;
        if (!row) throw new Error("Missing addon row template.");
        const toggle = row.querySelector<HTMLInputElement>(".addon-enabled");
        const name = row.querySelector<HTMLElement>(".addon-name");
        const host = row.querySelector<HTMLElement>(".addon-host");
        const url = row.querySelector<HTMLElement>(".addon-url");
        const reveal = row.querySelector<HTMLButtonElement>(".addon-reveal");
        const remove = row.querySelector<HTMLButtonElement>(".addon-remove");
        if (!toggle || !name || !host || !url || !reveal || !remove) {
            throw new Error("Invalid addon row template.");
        }

        toggle.checked = addon.enabled;
        toggle.setAttribute("aria-label", `Enable ${addon.name}`);
        name.textContent = addon.name;
        host.textContent = getAddonHostname(addon.manifestUrl);
        url.textContent = addon.manifestUrl;
        remove.setAttribute("aria-label", `Remove ${addon.name}`);
        const visibility = createAddonUrlVisibilityController(() => reveal.focus());
        const setVisibility = (state: ReturnType<typeof visibility.state>) => {
            url.className = state.className;
            url.setAttribute("aria-hidden", state.ariaHidden);
            reveal.textContent = state.label;
            reveal.setAttribute("aria-label", `${state.label} URL for ${addon.name}`);
        };
        setVisibility(visibility.state());

        bindAddonUrlVisibility(reveal, toggle, visibility, setVisibility, () => {
            addons[index] = { ...addon, enabled: toggle.checked };
            save(false);
        });
        remove.addEventListener("click", () => {
            addons.splice(index, 1);
            if (addons.length === 0) preferences.set("addonManifestUrl", "");
            save();
        });
        return row;
    }));
    empty.hidden = addons.length > 0;
}

function save(shouldRender = true): void {
    preferences.set("addons", addons);
    preferences.sync?.();
    if (shouldRender) render();
}

function getPreference(key: string): Promise<unknown> {
    return new Promise((resolve) => preferences.get(key, resolve));
}

function setError(message: string): void {
    errorMessage.textContent = message;
    errorMessage.hidden = !message;
}

function setTraktError(message: string): void {
    traktError.textContent = message;
    traktError.hidden = !message;
}

function renderTrakt(): void {
    const connected = trakt.tokens !== null;
    traktConnect.hidden = connected;
    traktSync.hidden = !connected;
    traktDisconnect.hidden = !connected;
    traktStatus.textContent = connected
        ? trakt.lastError
            ? "Connected · Sync failed"
            : `Connected${trakt.lastSyncAt ? ` · Last synced ${new Date(trakt.lastSyncAt).toLocaleString()}` : ""}`
        : trakt.reconnectRequired ? "Reconnect required" : "Not connected";
    if (trakt.lastError) setTraktError(trakt.lastError);
}

function saveTrakt(next: TraktState): void {
    trakt = next;
    preferences.set("trakt", next);
    preferences.sync?.();
    if (!next.lastError) setTraktError("");
    renderTrakt();
}

function saveTraktCredentials(): void {
    const clientId = traktClientId.value.trim();
    const clientSecret = traktClientSecret.value.trim();
    if (clientId === trakt.clientId && clientSecret === trakt.clientSecret) return;
    traktRevision += 1;
    traktDevice.hidden = true;
    saveTrakt({
        ...trakt,
        clientId,
        clientSecret,
        tokens: null,
        reconnectRequired: false,
        initialHistoryUploaded: false,
        lastSyncAt: "",
        lastError: "",
        retryAt: 0
    });
}

async function connectTrakt(): Promise<void> {
    setTraktError("");
    const clientId = traktClientId.value.trim();
    const clientSecret = traktClientSecret.value.trim();
    if (!clientId || !clientSecret) {
        setTraktError("Enter both the Trakt Client ID and Client Secret.");
        return;
    }

    const revision = ++traktRevision;
    traktConnect.disabled = true;
    try {
        saveTrakt({
            ...trakt,
            clientId,
            clientSecret,
            tokens: null,
            reconnectRequired: false,
            initialHistoryUploaded: false,
            lastSyncAt: "",
            lastError: "",
            retryAt: 0
        });
        traktStatus.textContent = "Requesting device code…";
        const code = await requestDeviceCode(browserTransport, trakt);
        if (revision !== traktRevision) return;
        traktDevice.hidden = false;
        traktDevice.textContent = `Enter ${code.userCode} at trakt.tv/activate`;
        const activation = `${code.verificationUrl.replace(/\/$/, "")}/${encodeURIComponent(code.userCode)}`;
        window.open(activation, "_blank");
        traktStatus.textContent = "Waiting for Trakt authorization…";
        const connected = await pollDeviceToken(
            browserTransport,
            trakt,
            code,
            (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))
        );
        if (revision !== traktRevision) return;
        saveTrakt(connected);

        const local = parseWatchHistory(await getPreference("watchHistory"));
        if (revision !== traktRevision) return;
        const result = await syncTraktHistory(browserTransport, connected, local);
        const latest = parseWatchHistory(await getPreference("watchHistory"));
        if (revision !== traktRevision) return;
        preferences.set("watchHistory", mergeWatchHistory(result.history, latest));
        preferences.sync?.();
        saveTrakt(result.state);
        traktDevice.hidden = true;
    } catch (error) {
        if (revision === traktRevision) {
            setTraktError(error instanceof Error ? error.message : "Could not connect Trakt.");
        }
    } finally {
        traktConnect.disabled = false;
        if (revision === traktRevision) renderTrakt();
    }
}

async function syncTraktNow(): Promise<void> {
    if (!trakt.tokens) return;
    const state = trakt;
    const revision = ++traktRevision;
    traktSync.disabled = true;
    setTraktError("");
    try {
        const local = parseWatchHistory(await getPreference("watchHistory"));
        if (revision !== traktRevision) return;
        const result = await syncTraktHistory(browserTransport, state, local);
        const latest = parseWatchHistory(await getPreference("watchHistory"));
        if (revision !== traktRevision) return;
        preferences.set("watchHistory", mergeWatchHistory(result.history, latest));
        preferences.sync?.();
        saveTrakt(result.state);
    } catch (error) {
        if (revision === traktRevision) {
            setTraktError(error instanceof Error ? error.message : "Could not sync Trakt.");
        }
    } finally {
        traktSync.disabled = false;
    }
}

function disconnectTrakt(): void {
    traktRevision += 1;
    saveTrakt({
        ...trakt,
        tokens: null,
        reconnectRequired: false,
        lastSyncAt: "",
        lastError: "",
        retryAt: 0
    });
    traktDevice.hidden = true;
}

function element<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing element: ${id}`);
    return value as T;
}
