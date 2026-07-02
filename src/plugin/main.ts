import type { EpisodePlaybackContext, PlayItemPayload } from "../shared/messages";

import { MESSAGE_NAMES } from "../shared/messages";
import { findNextEpisode } from "../shared/stremio";
import { PLAYBACK_TICK_INTERVAL_MS, SHOW_SIDEBAR_DELAY_MS, SPLASH_URL_MARKER } from "./constants";
import { keepAwakeTick, startKeepAwake, stopKeepAwake } from "./sleep";
import { formatError, isHttpUrl, logDebug, sanitizeMediaTitle } from "./utils";

const { core, event, global, mpv, preferences, sidebar, utils } = iina;

let windowReady = false;
let pendingShowSidebar = false;
let sidebarVisible = false;
let playbackTimer: ReturnType<typeof setInterval> | null = null;
let savedImageDisplayDuration: string | null = null;
let savedPositionOnQuitFlag: boolean | null = null;
let activeEpisodeContext: EpisodePlaybackContext | null = null;
let isReplacingPlayback = false;

function setPlayerUIHidden(hidden: boolean): void {
    const api = core as typeof core & { setUIVisibility?: (hidden: boolean) => void };
    api.setUIVisibility?.(hidden);
}

function showSidebar(): void {
    sidebar.show();
    sidebarVisible = true;
}

function showSidebarWithDelay(): void {
    setTimeout(showSidebar, SHOW_SIDEBAR_DELAY_MS);
}

function hideSidebar(): void {
    sidebar.hide();
    sidebarVisible = false;
}

function isSidebarVisible(): boolean {
    const api = sidebar as typeof sidebar & { isVisible?: () => boolean };
    if (api.isVisible) return api.isVisible();
    try {
        const current = core.window.sidebar;
        if (current !== undefined) return typeof current === "string" && current.includes("popcorn");
    } catch (error) {
        logDebug("Popcorn: Could not read sidebar state:", formatError(error));
    }
    return sidebarVisible;
}

function toggleSidebar(): void {
    if (!windowReady) pendingShowSidebar = true;
    else if (isSidebarVisible()) hideSidebar();
    else showSidebarWithDelay();
}

function setWindowTitle(title: string): void {
    const safeTitle = sanitizeMediaTitle(title);
    const api = mpv as typeof mpv & { setString?: (name: string, value: string) => void };
    if (api.setString) api.setString("force-media-title", safeTitle);
    else mpv.set("force-media-title", safeTitle);
}

function startPlaybackMonitoring(): void {
    stopPlaybackMonitoring();
    startKeepAwake();
    playbackTimer = setInterval(() => keepAwakeTick(!mpv.getFlag("pause")), PLAYBACK_TICK_INTERVAL_MS);
}

function stopPlaybackMonitoring(): void {
    if (playbackTimer) {
        clearInterval(playbackTimer);
        playbackTimer = null;
    }
    stopKeepAwake();
}

function prepareSplash(): void {
    try {
        if (savedImageDisplayDuration === null) savedImageDisplayDuration = mpv.getString("image-display-duration") || "1";
        mpv.set("image-display-duration", "inf");
        if (savedPositionOnQuitFlag === null) savedPositionOnQuitFlag = mpv.getFlag("save-position-on-quit");
        mpv.set("save-position-on-quit", false);
    } catch (error) {
        logDebug("Popcorn: Splash setup failed:", formatError(error));
    }
}

function restorePlayerOptions(): void {
    try {
        if (savedImageDisplayDuration !== null) {
            mpv.set("image-display-duration", savedImageDisplayDuration);
            savedImageDisplayDuration = null;
        }
        if (savedPositionOnQuitFlag !== null) {
            mpv.set("save-position-on-quit", savedPositionOnQuitFlag);
            savedPositionOnQuitFlag = null;
        }
    } catch (error) {
        logDebug("Popcorn: Player option restore failed:", formatError(error));
    }
}

function playItem(payload: PlayItemPayload): void {
    const url = String(payload?.url || "");
    if (!isHttpUrl(url)) {
        utils.ask("Popcorn can only play direct http:// or https:// streams.");
        return;
    }
    const title = sanitizeMediaTitle(payload.title || "Popcorn");
    activeEpisodeContext = payload.episodeContext || null;
    isReplacingPlayback = true;
    mpv.command("loadfile", [url, "replace", "-1", `force-media-title=${title}`]);
    hideSidebar();
}

function handleEndFile(): void {
    stopPlaybackMonitoring();
    if (isReplacingPlayback) {
        return;
    }

    const context = activeEpisodeContext;
    activeEpisodeContext = null;
    if (!context) {
        return;
    }

    const nextEpisode = findNextEpisode(context.episodes, context.episode);
    if (!nextEpisode) {
        return;
    }

    showSidebar();
    sidebar.postMessage(MESSAGE_NAMES.ShowNextEpisode, {
        media: context.media,
        episode: nextEpisode,
        episodes: context.episodes
    });
}

prepareSplash();
global.onMessage("showPopcornSidebar", toggleSidebar);

event.on("iina.window-loaded", () => {
    sidebar.loadFile("ui/sidebar.html");
    sidebar.onMessage(MESSAGE_NAMES.PlayItem, playItem);
    sidebar.onMessage(MESSAGE_NAMES.RequestConfiguration, () => {
        sidebar.postMessage(MESSAGE_NAMES.Configuration, {
            addonManifestUrl: String(preferences.get("addonManifestUrl") || "")
        });
    });
    windowReady = true;
    global.postMessage("playerReady", {});
    if (pendingShowSidebar) {
        pendingShowSidebar = false;
        showSidebarWithDelay();
    }
});

event.on("mpv.file-loaded", () => {
    const path = mpv.getString("path") || "";
    isReplacingPlayback = false;
    if (path.includes(SPLASH_URL_MARKER)) {
        stopPlaybackMonitoring();
        activeEpisodeContext = null;
        setPlayerUIHidden(true);
        setWindowTitle("Popcorn");
        showSidebar();
        return;
    }
    restorePlayerOptions();
    setPlayerUIHidden(false);
    startPlaybackMonitoring();
});

event.on("mpv.end-file", handleEndFile);
event.on("iina.window-will-close", () => {
    stopPlaybackMonitoring();
    windowReady = false;
    sidebarVisible = false;
    activeEpisodeContext = null;
    isReplacingPlayback = false;
    global.postMessage("playerClosed", {});
});

logDebug("Popcorn: Main entry loaded");
