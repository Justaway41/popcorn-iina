import type { AddonManifest, StremioAddon } from "../shared/addons";
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
    parseSimklExternalLinkRequest,
    parseSimklState,
    pollSimklPin,
    requestSimklPin,
    type SimklState
} from "../shared/simkl";
import { parseSkipSegments } from "../shared/stremio";
import {
    mergeWatchHistory,
    parseTraktExternalLinkRequest,
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
let simkl = parseSimklState(null);
let simklRevision = 0;
const manifests = new Map<string, AddonManifest>();

document.documentElement.dataset.version = CLIENT_VERSION;
const preferences = window.iina.preferences as unknown as WebviewPreferences;
const form = element<HTMLFormElement>("addon-form");
const input = element<HTMLInputElement>("addon-url");
const addButton = element<HTMLButtonElement>("add-addon");
const errorMessage = element<HTMLParagraphElement>("addon-error");
const list = element<HTMLDivElement>("addon-list");
const empty = element<HTMLParagraphElement>("addon-empty");
const template = element<HTMLTemplateElement>("addon-row-template");
const presetButtons = [...document.querySelectorAll<HTMLButtonElement>(".addon-preset")];
const skipSegments = element<HTMLInputElement>("skip-segments");
const traktClientId = element<HTMLInputElement>("trakt-client-id");
const traktClientSecret = element<HTMLInputElement>("trakt-client-secret");
const traktConnect = element<HTMLButtonElement>("trakt-connect");
const traktSync = element<HTMLButtonElement>("trakt-sync");
const traktDisconnect = element<HTMLButtonElement>("trakt-disconnect");
const traktDevice = element<HTMLParagraphElement>("trakt-device");
const traktStatus = element<HTMLParagraphElement>("trakt-status");
const traktError = element<HTMLParagraphElement>("trakt-error");
const externalLinks = [...document.querySelectorAll<HTMLAnchorElement>("[data-external-url]")];
const simklClientId = element<HTMLInputElement>("simkl-client-id");
const simklConnect = element<HTMLButtonElement>("simkl-connect");
const simklDisconnect = element<HTMLButtonElement>("simkl-disconnect");
const simklPin = element<HTMLParagraphElement>("simkl-pin");
const simklStatus = element<HTMLParagraphElement>("simkl-status");
const simklError = element<HTMLParagraphElement>("simkl-error");
const simklLinks = [...document.querySelectorAll<HTMLAnchorElement>("[data-simkl-url]")];

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
presetButtons.forEach((button) => {
    button.addEventListener("click", () => void addAddon(button.dataset.url || "", button));
});
traktClientId.addEventListener("change", saveTraktCredentials);
traktClientSecret.addEventListener("change", saveTraktCredentials);
traktConnect.addEventListener("click", () => void connectTrakt());
traktSync.addEventListener("click", () => void syncTraktNow());
traktDisconnect.addEventListener("click", disconnectTrakt);
externalLinks.forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    void copyExternalLink(link.href).then((copied) => {
        traktStatus.textContent = copied
            ? "Link copied. Paste it into your browser."
            : "Could not copy the link. Right-click it and choose Copy Link.";
    });
}));

simklClientId.addEventListener("change", saveSimklClientId);
simklConnect.addEventListener("click", () => void connectSimkl());
simklDisconnect.addEventListener("click", disconnectSimkl);
simklLinks.forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    void copyExternalLink(link.href).then((copied) => {
        simklStatus.textContent = copied
            ? "Link copied. Paste it into your browser."
            : "Could not copy the link. Right-click it and choose Copy Link.";
    });
}));

skipSegments.addEventListener("change", () => {
    preferences.set("skipSegments", skipSegments.checked);
});

void loadPreferences();

async function loadPreferences(): Promise<void> {
    const [stored, legacy, storedTrakt, storedSkipSegments, storedSimkl] = await Promise.all([
        getPreference("addons"),
        getPreference("addonManifestUrl"),
        getPreference("trakt"),
        getPreference("skipSegments"),
        getPreference("simkl")
    ]);
    const storedAddons = parseAddons(stored);
    addons = parseAddons(stored, legacy);
    skipSegments.checked = parseSkipSegments(storedSkipSegments);
    trakt = parseTraktState(storedTrakt);
    traktClientId.value = trakt.clientId;
    traktClientSecret.value = trakt.clientSecret;
    simkl = parseSimklState(storedSimkl);
    simklClientId.value = simkl.clientId;
    render();
    renderTrakt();
    renderSimkl();

    const loaded = await Promise.allSettled(addons.map(async (addon) => {
        const manifest = await fetchManifest(addon.manifestUrl);
        manifests.set(addon.manifestUrl, manifest);
        return { addon, manifest };
    }));
    let changed = false;
    loaded.forEach((result) => {
        if (result.status !== "fulfilled" || result.value.addon.name === result.value.manifest.name) return;
        const index = addons.indexOf(result.value.addon);
        if (index !== -1) addons[index] = { ...addons[index], name: result.value.manifest.name };
        changed = true;
    });
    if (changed) save();
    else render();

    if (storedAddons.length === 0 && addons.length === 1) {
        try {
            const manifest = await fetchManifest(addons[0].manifestUrl);
            addons[0] = { ...addons[0], name: manifest.name };
            save();
        } catch {
            // The legacy addon remains usable and can be replaced from this page.
        }
    }
}

async function addAddon(value = input.value, trigger = addButton): Promise<void> {
    setError("");
    trigger.disabled = true;
    const originalLabel = trigger.textContent;
    trigger.textContent = "Adding…";
    try {
        const manifestUrl = canonicalizeManifestUrl(value);
        if (addons.some((addon) => addon.manifestUrl === manifestUrl)) {
            throw new Error("This addon is already added.");
        }
        const manifest = await fetchManifest(manifestUrl);
        manifests.set(manifestUrl, manifest);
        addons.push({ name: manifest.name, manifestUrl, enabled: true });
        if (trigger === addButton) input.value = "";
        save();
    } catch (error) {
        setError(error instanceof Error ? error.message : "Could not add this addon.");
    } finally {
        trigger.disabled = false;
        trigger.textContent = originalLabel;
        renderPresetButtons();
    }
}

async function fetchManifest(manifestUrl: string): Promise<AddonManifest> {
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
        const capabilities = row.querySelector<HTMLElement>(".addon-capabilities");
        const reveal = row.querySelector<HTMLButtonElement>(".addon-reveal");
        const remove = row.querySelector<HTMLButtonElement>(".addon-remove");
        if (!toggle || !name || !host || !url || !capabilities || !reveal || !remove) {
            throw new Error("Invalid addon row template.");
        }

        toggle.checked = addon.enabled;
        toggle.setAttribute("aria-label", `Enable ${addon.name}`);
        name.textContent = addon.name;
        host.textContent = getAddonHostname(addon.manifestUrl);
        url.textContent = addon.manifestUrl;
        const manifest = manifests.get(addon.manifestUrl);
        capabilities.replaceChildren(...(manifest?.resources || []).map((resource) => {
            const badge = document.createElement("span");
            badge.textContent = resource === "meta"
                ? "Metadata"
                : resource[0].toUpperCase() + resource.slice(1);
            return badge;
        }));
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
    renderPresetButtons();
}

function renderPresetButtons(): void {
    presetButtons.forEach((button) => {
        const presetUrl = canonicalizeManifestUrl(button.dataset.url || "");
        const added = addons.some((addon) => addon.manifestUrl === presetUrl);
        button.disabled = added;
        button.textContent = added ? "Added" : `Add ${button.dataset.name}`;
    });
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

function setSimklError(message: string): void {
    simklError.textContent = message;
    simklError.hidden = !message;
}

function renderSimkl(): void {
    const connected = simkl.accessToken !== "";
    simklConnect.hidden = connected;
    simklDisconnect.hidden = !connected;
    simklStatus.textContent = connected
        ? simkl.lastError ? "Connected · Last scrobble failed" : "Connected"
        : "Not connected";
    if (simkl.lastError) setSimklError(simkl.lastError);
}

function saveSimkl(next: SimklState): void {
    simkl = next;
    preferences.set("simkl", next);
    preferences.sync?.();
    if (!next.lastError) setSimklError("");
    renderSimkl();
}

function saveSimklClientId(): void {
    const clientId = simklClientId.value.trim();
    if (clientId === simkl.clientId) return;
    // A different application means the stored token no longer belongs to it.
    simklRevision += 1;
    simklPin.hidden = true;
    saveSimkl({ clientId, accessToken: "", lastError: "", retryAt: 0 });
}

async function connectSimkl(): Promise<void> {
    setSimklError("");
    const clientId = simklClientId.value.trim();
    if (!clientId) {
        setSimklError("Enter the Simkl Client ID.");
        return;
    }

    const revision = ++simklRevision;
    simklConnect.disabled = true;
    try {
        saveSimkl({ clientId, accessToken: "", lastError: "", retryAt: 0 });
        simklStatus.textContent = "Requesting a PIN…";
        const pin = await requestSimklPin(browserTransport, simkl);
        if (revision !== simklRevision) return;
        simklPin.hidden = false;
        const copied = await copyExternalLink(pin.verificationUrl);
        simklPin.textContent = copied
            ? `Enter ${pin.userCode} at simkl.com/pin · Link copied`
            : `Open ${pin.verificationUrl} and enter ${pin.userCode}`;
        simklStatus.textContent = "Waiting for Simkl authorization…";
        const connected = await pollSimklPin(
            browserTransport,
            simkl,
            pin,
            (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))
        );
        if (revision !== simklRevision) return;
        saveSimkl(connected);
        simklPin.hidden = true;
    } catch (error) {
        if (revision === simklRevision) {
            setSimklError(error instanceof Error ? error.message : "Could not connect Simkl.");
        }
    } finally {
        simklConnect.disabled = false;
        if (revision === simklRevision) renderSimkl();
    }
}

function disconnectSimkl(): void {
    simklRevision += 1;
    simklPin.hidden = true;
    setSimklError("");
    saveSimkl({ ...simkl, accessToken: "", lastError: "", retryAt: 0 });
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
        const activation = `${code.verificationUrl.replace(/\/$/, "")}/${encodeURIComponent(code.userCode)}`;
        const copied = await copyExternalLink(activation);
        traktDevice.textContent = copied
            ? `Enter ${code.userCode} at trakt.tv/activate · Link copied`
            : `Open ${activation} in your browser`;
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

async function copyExternalLink(url: string): Promise<boolean> {
    const safeUrl = parseTraktExternalLinkRequest({ url }) || parseSimklExternalLinkRequest({ url });
    if (!safeUrl) return false;
    try {
        await navigator.clipboard.writeText(safeUrl);
        return true;
    } catch {
        return false;
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
