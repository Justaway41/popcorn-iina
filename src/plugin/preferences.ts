import { parseAddons } from "../shared/addons";
import { parseWatchHistory } from "../shared/history";
import { parseTraktState } from "../shared/trakt";

interface PreferenceStore {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    sync(): void;
}

/**
 * IINA writes a plugin's preferences as a property list, and a property list has no null: a
 * single `null` or `undefined` anywhere in the value makes the whole write fail with "the data
 * couldn't be written because of an error in the destination for the data", and everything the
 * flush carried is lost. A movie's history entry holds `episode: null`, so every sync wrote
 * nothing at all and watched state stayed as it was for days.
 *
 * Dropping the key is what the parsers already expect: each reads a missing field as absent.
 */
export const UNWRITABLE = Symbol("unwritable");

export function plistSafe(value: unknown): unknown {
    if (value === null || typeof value === "undefined") return UNWRITABLE;
    if (Array.isArray(value)) {
        // An array cannot hold a hole, so an unwritable element is left out of it.
        return value.map(plistSafe).filter((item) => item !== UNWRITABLE);
    }
    if (typeof value === "object") {
        const safe: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            const cleaned = plistSafe(item);
            if (cleaned !== UNWRITABLE) safe[key] = cleaned;
        }
        return safe;
    }
    // A number a property list cannot hold would fail the same write.
    if (typeof value === "number" && !Number.isFinite(value)) return UNWRITABLE;
    return value;
}

/**
 * The preference store every write in the plugin goes through, so nothing a property list
 * cannot hold ever reaches a flush.
 */
export function createPlistSafeStore(preferences: PreferenceStore): PreferenceStore {
    return {
        get(key) { return preferences.get(key); },
        set(key, value) {
            const safe = plistSafe(value);
            // A value that is nothing but null has no property list form; leave what is stored.
            if (safe !== UNWRITABLE) preferences.set(key, safe);
        },
        sync() { preferences.sync(); }
    };
}

export function migrateStructuredPreferences(preferences: PreferenceStore): void {
    const storedAddons = preferences.get("addons");
    const addons = parseAddons(storedAddons, preferences.get("addonManifestUrl"));
    let changed = false;

    if (typeof storedAddons === "string" || addons.length > parseAddons(storedAddons).length) {
        preferences.set("addons", addons);
        changed = true;
    }

    const watchHistory = preferences.get("watchHistory");
    if (typeof watchHistory === "string") {
        preferences.set("watchHistory", plistSafe(parseWatchHistory(watchHistory)));
        changed = true;
    }

    const trakt = preferences.get("trakt");
    if (typeof trakt === "string") {
        preferences.set("trakt", parseTraktState(trakt));
        changed = true;
    }

    if (changed) preferences.sync();
}

/** A language preference is a free string; anything else reads as no preference. */
export function parseLanguagePreference(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}
