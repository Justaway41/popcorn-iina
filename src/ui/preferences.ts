import type { StremioAddon } from "../shared/addons";

import {
    canonicalizeManifestUrl,
    getAddonHostname,
    parseAddonManifest,
    parseAddons
} from "../shared/addons";
import { CLIENT_VERSION } from "../shared/version";

interface WebviewPreferences {
    get(key: string, callback: (value: unknown) => void): void;
    set(key: string, value: unknown): void;
    sync?(): void;
}

let addons: StremioAddon[] = [];

document.documentElement.dataset.version = CLIENT_VERSION;
const preferences = iina.preferences as unknown as WebviewPreferences;
const form = element<HTMLFormElement>("addon-form");
const input = element<HTMLInputElement>("addon-url");
const addButton = element<HTMLButtonElement>("add-addon");
const errorMessage = element<HTMLParagraphElement>("addon-error");
const list = element<HTMLDivElement>("addon-list");
const empty = element<HTMLParagraphElement>("addon-empty");
const template = element<HTMLTemplateElement>("addon-row-template");

form.addEventListener("submit", (event) => {
    event.preventDefault();
    void addAddon();
});

void loadPreferences();

async function loadPreferences(): Promise<void> {
    const [stored, legacy] = await Promise.all([
        getPreference("addons"),
        getPreference("addonManifestUrl")
    ]);
    const storedAddons = parseAddons(stored);
    addons = parseAddons(stored, legacy);
    render();

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
        const remove = row.querySelector<HTMLButtonElement>(".addon-remove");
        if (!toggle || !name || !host || !remove) throw new Error("Invalid addon row template.");

        toggle.checked = addon.enabled;
        toggle.setAttribute("aria-label", `Enable ${addon.name}`);
        name.textContent = addon.name;
        host.textContent = getAddonHostname(addon.manifestUrl);
        remove.setAttribute("aria-label", `Remove ${addon.name}`);

        toggle.addEventListener("change", () => {
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
    preferences.set("addons", JSON.stringify(addons));
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

function element<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing element: ${id}`);
    return value as T;
}
