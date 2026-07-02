import { CLIENT_NAME, DEBUG_LOGS } from "../shared/constants";

export { CLIENT_VERSION } from "../shared/version";
export { CLIENT_NAME, DEBUG_LOGS };

export const SHOW_SIDEBAR_DELAY_MS = 300;
export const SPLASH_URL_MARKER = "assets/Popcorn";
export const PLAYBACK_TICK_INTERVAL_MS = 1000;
export const SLEEP_CAFFEINATE_TIMEOUT_SEC = 30;
export const SLEEP_REFRESH_INTERVAL_SEC = 20;

const PLUGINS_DIR = "~/Library/Application Support/com.colliderli.iina/plugins";
export const POPCORN_SPLASH_CANDIDATES = [
    `${PLUGINS_DIR}/xyz.brbc.popcorn.iinaplugin/assets/Popcorn`,
    `${PLUGINS_DIR}/xyz.brbc.popcorn.iinaplugin-dev/assets/Popcorn`
];
