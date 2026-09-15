export { CLIENT_VERSION } from "../shared/version";
export { DEBUG_LOGS } from "../shared/constants";

export const SHOW_SIDEBAR_DELAY_MS = 300;
export const SPLASH_URL_MARKER = "assets/Popcorn";
export const PLAYBACK_TICK_INTERVAL_MS = 1000;
export const PROGRESS_SAVE_INTERVAL_MS = 30_000;
export const HISTORY_SYNC_INTERVAL_MS = 300_000;
export const SLEEP_CAFFEINATE_TIMEOUT_SEC = 30;
export const SLEEP_REFRESH_INTERVAL_SEC = 20;

const PLUGINS_DIR = "~/Library/Application Support/com.colliderli.iina/plugins";
export const POPCORN_SPLASH_CANDIDATES = [
    `${PLUGINS_DIR}/xyz.brbc.popcorn.iinaplugin/assets/Popcorn`,
    `${PLUGINS_DIR}/xyz.brbc.popcorn.iinaplugin-dev/assets/Popcorn`
];

/** Names the Popcorn window, so its own entry can tell it apart from other players. */
export const POPCORN_PLAYER_LABEL = "popcorn";
/** Preference the Popcorn window keeps true while it is open; see `global.ts` for why. */
export const POPCORN_WINDOW_OPEN = "popcornWindowOpen";
