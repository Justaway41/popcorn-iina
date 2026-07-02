import { SLEEP_CAFFEINATE_TIMEOUT_SEC, SLEEP_REFRESH_INTERVAL_SEC } from "./constants";
import { formatError, logDebug } from "./utils";

// IINA's own SleepPreventer never fires for plugin-created players: they live in
// JavascriptAPIGlobal's `instances` dict and are never appended to the static
// PlayerCore.playerCores that SleepPreventer iterates, so plugin playback lets
// the display sleep. Prevent it ourselves with `caffeinate -d`, refreshed while
// playing. Each process carries a `-t` timeout so a crashed plugin leaves no
// orphan assertion holding the display awake forever.

// IINA's utils.exec does NOT resolve bare binary names against PATH (fileInPath
// confirms bare="caffeinate" is not found while the absolute path is), so it
// must be the absolute path or the process silently fails to launch.
const CAFFEINATE_PATH = "/usr/bin/caffeinate";

let ticksSinceSpawn = 0;
let active = false;

function spawnCaffeinate(): void {
    const { utils } = iina;
    try {
        utils.exec(CAFFEINATE_PATH, ["-d", "-t", String(SLEEP_CAFFEINATE_TIMEOUT_SEC)])
            .then((result) => {
                if (result.status !== 0) {
                    logDebug("Popcorn: caffeinate exited non-zero:", result.status, result.stderr);
                }
            })
            .catch((error) => {
                logDebug("Popcorn: caffeinate exec failed:", formatError(error));
            });
    } catch (error) {
        logDebug("Popcorn: caffeinate spawn failed:", formatError(error));
    }
}

// Start preventing display sleep: spawn immediately and arm periodic refresh.
export function startKeepAwake(): void {
    active = true;
    ticksSinceSpawn = 0;
    spawnCaffeinate();
}

// Call once per playback tick (1s). Refreshes the caffeinate assertion while the
// player is actively playing; when paused it lets the last process lapse so the
// display may sleep, matching IINA's own "prevent only while playing" behaviour.
export function keepAwakeTick(isPlaying: boolean): void {
    if (!active || !isPlaying) {
        return;
    }
    ticksSinceSpawn += 1;
    if (ticksSinceSpawn >= SLEEP_REFRESH_INTERVAL_SEC) {
        ticksSinceSpawn = 0;
        spawnCaffeinate();
    }
}

// Stop refreshing; the last caffeinate process self-expires within its timeout.
export function stopKeepAwake(): void {
    active = false;
    ticksSinceSpawn = 0;
}
