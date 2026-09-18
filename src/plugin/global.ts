import { POPCORN_PLAYER_LABEL, POPCORN_WINDOW_OPEN } from "./constants";
import { formatError, getSplashUrl, logDebug } from "./utils";
import { createPlistSafeStore, migrateStructuredPreferences } from "./preferences";

const { console, global, menu } = iina;
// IINA's property list cannot hold a null, and one in a value fails the whole flush silently.
const preferences = createPlistSafeStore(iina.preferences);

migrateStructuredPreferences(preferences);
// Only the id of a window this entry created can be addressed on IINA 1.4.4.
let popcornPlayerId: number | null = null;
// A window left over from a previous run is gone; never trust a flag it could not clear.
preferences.set(POPCORN_WINDOW_OPEN, false);

/**
 * The global entry registers no message listeners. On IINA 1.4.4 under macOS 27 a
 * `global.onMessage` callback here runs outside the context it was written in: it cannot see a
 * function declared beside it, and when it declares the sender-id parameter the next garbage
 * collection aborts IINA in `SymbolTable::destroy` about eleven seconds after launch. Posting to
 * a window by its label is not delivered either. So this entry keeps the id `createPlayerInstance`
 * returns, and the window reports whether it is still open through a shared preference.
 */
async function showPopcorn(): Promise<void> {
    if (popcornPlayerId !== null && preferences.get(POPCORN_WINDOW_OPEN) === true) {
        global.postMessage(popcornPlayerId, "showPopcornSidebar", {});
        return;
    }
    popcornPlayerId = global.createPlayerInstance({
        url: getSplashUrl(),
        enablePlugins: true,
        disableUI: true,
        label: POPCORN_PLAYER_LABEL
    });
}

menu.addItem(menu.item("Popcorn", () => {
    showPopcorn().catch((error) => console.error(`Popcorn: Menu action failed: ${formatError(error)}`));
}, { keyBinding: "Shift+p" }));

logDebug("Popcorn: Global entry loaded");
