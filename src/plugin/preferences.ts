import { parseAddons } from "../shared/addons";
import { parseWatchHistory } from "../shared/history";
import { parseTraktState } from "../shared/trakt";

interface PreferenceStore {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    sync(): void;
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
        preferences.set("watchHistory", parseWatchHistory(watchHistory));
        changed = true;
    }

    const trakt = preferences.get("trakt");
    if (typeof trakt === "string") {
        preferences.set("trakt", parseTraktState(trakt));
        changed = true;
    }

    if (changed) preferences.sync();
}
