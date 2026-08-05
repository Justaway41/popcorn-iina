import type {
    PlaybackContext,
    PlayItemPayload,
    SetEpisodeOrderPayload,
    SetMediaTypePayload
} from "../shared/messages";

import { MESSAGE_NAMES } from "../shared/messages";
import { parseAddons } from "../shared/addons";
import { parseWatchHistory, recordPlayback } from "../shared/history";
import { findNextEpisode, parseEpisodeOrder, parseMediaTypePreference } from "../shared/stremio";
import { mergeWatchHistory, type TraktScrobbleAction } from "../shared/trakt";
import {
    PLAYBACK_TICK_INTERVAL_MS,
    PROGRESS_SAVE_INTERVAL_MS,
    SHOW_SIDEBAR_DELAY_MS,
    SPLASH_URL_MARKER
} from "./constants";
import {
    shouldOfferNextEpisode,
    shouldSaveProgress,
    shouldSendWatchedStop
} from "./playback";
import { keepAwakeTick, startKeepAwake, stopKeepAwake } from "./sleep";
import { createIinaTraktClient } from "./trakt";
import {
    findChapterIntro,
    isInsideIntro,
    parseAniSkipInterval,
    parseKitsuMalId,
    type IntroInterval
} from "./intro";
import { formatError, isHttpUrl, logDebug, sanitizeMediaTitle } from "./utils";

const { core, event, global, http, mpv, overlay, preferences, sidebar, utils } = iina;
const trakt = createIinaTraktClient(http, preferences, (error) => {
    logDebug("Popcorn: Trakt request failed:", formatError(error));
});

let windowReady = false;
let pendingShowSidebar = false;
let sidebarVisible = false;
let playbackTimer: ReturnType<typeof setInterval> | null = null;
let savedImageDisplayDuration: string | null = null;
let savedPositionOnQuitFlag: boolean | null = null;
let activePlaybackContext: PlaybackContext | null = null;
let pendingResumePercent: number | null = null;
let lastProgressSavedAt = 0;
let isReplacingPlayback = false;
let reachedNaturalEof = false;
let traktStopSent = false;
let watchHistory = parseWatchHistory(preferences.get("watchHistory"));
let introInterval: IntroInterval | null = null;
let introRevision = 0;
const kitsuMalIds = new Map<string, string>();

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
    playbackTimer = setInterval(() => {
        const playing = !mpv.getFlag("pause");
        keepAwakeTick(playing);
        const percent = mpv.getNumber("percent-pos");
        if (playing && shouldSendWatchedStop(percent, traktStopSent)) {
            sendTrakt("stop", percent);
        }
        if (playing && shouldSaveProgress(
            Date.now(),
            lastProgressSavedAt,
            PROGRESS_SAVE_INTERVAL_MS
        )) {
            savePlaybackProgress();
        }
    }, PLAYBACK_TICK_INTERVAL_MS);
}

function savePlaybackProgress(percent = mpv.getNumber("percent-pos")): void {
    const context = activePlaybackContext;
    if (!context || !Number.isFinite(percent)) return;
    watchHistory = recordPlayback(
        parseWatchHistory(preferences.get("watchHistory")),
        context,
        percent,
        new Date().toISOString()
    );
    preferences.set("watchHistory", watchHistory);
    preferences.sync();
    sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, { history: watchHistory });
    lastProgressSavedAt = Date.now();
}

function sendTrakt(action: TraktScrobbleAction, percent: number): void {
    const context = activePlaybackContext;
    if (!context || !Number.isFinite(percent) || traktStopSent) return;
    if (action === "stop") traktStopSent = true;
    void trakt.sendPlayback(action, context, percent);
}

function checkpointPlayback(forceStop = false): void {
    const context = activePlaybackContext;
    if (!context) return;
    const percent = forceStop ? 100 : mpv.getNumber("percent-pos");
    if (!Number.isFinite(percent)) return;
    savePlaybackProgress(percent);
    sendTrakt(
        forceStop || percent >= 90 ? "stop" : "pause",
        percent
    );
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
    checkpointPlayback();
    activePlaybackContext = payload.playbackContext || null;
    traktStopSent = false;
    pendingResumePercent = typeof payload.resumePercent === "number" &&
        Number.isFinite(payload.resumePercent) &&
        payload.resumePercent >= 0 &&
        payload.resumePercent <= 100
        ? payload.resumePercent
        : null;
    isReplacingPlayback = true;
    reachedNaturalEof = false;
    clearIntro();
    core.osd("Loading stream...");
    mpv.command("loadfile", [url, "replace", "-1", `force-media-title=${title}`]);
}

function handleEndFile(): void {
    stopPlaybackMonitoring();
    clearIntro();
    const offerNextEpisode = shouldOfferNextEpisode(isReplacingPlayback, reachedNaturalEof);
    const naturalEof = reachedNaturalEof;
    reachedNaturalEof = false;
    if (isReplacingPlayback) {
        return;
    }

    checkpointPlayback(naturalEof);
    const context = activePlaybackContext;
    activePlaybackContext = null;
    if (!offerNextEpisode || !context?.episode) {
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
        episodes: context.episodes,
        quality: context.quality
    });
}

function clearIntro(): void {
    introRevision += 1;
    introInterval = null;
    overlay.hide();
}

function updateIntroOverlay(): void {
    if (isInsideIntro(mpv.getNumber("time-pos"), introInterval)) overlay.show();
    else overlay.hide();
}

async function resolveIntro(): Promise<void> {
    const revision = ++introRevision;
    introInterval = null;
    overlay.hide();
    const chapterInterval = findChapterIntro(core.getChapters());
    if (chapterInterval) {
        if (revision === introRevision) {
            introInterval = chapterInterval;
            updateIntroOverlay();
        }
        return;
    }

    const context = activePlaybackContext;
    const episode = context?.episode;
    const providerId = context?.media.providerId || context?.media.id || "";
    if (!context || !episode || !(context.media.providerType === "anime" || providerId.startsWith("kitsu:"))) {
        return;
    }
    try {
        const malId = context.media.malId || await loadKitsuMalId(providerId);
        const duration = mpv.getNumber("duration");
        if (!malId || !Number.isFinite(duration) || duration <= 0 || revision !== introRevision) return;
        const response = await http.get(
            `https://api.aniskip.com/v2/skip-times/${encodeURIComponent(malId)}/${episode.episode}` +
                `?types=op&episodeLength=${encodeURIComponent(String(duration))}`,
            { params: {}, headers: { Accept: "application/json" }, data: {} }
        );
        if (response.statusCode < 200 || response.statusCode >= 300 || revision !== introRevision) return;
        const interval = parseAniSkipInterval(response.data ?? safeJson(response.text));
        if (!interval || interval.end > duration) return;
        introInterval = interval;
        updateIntroOverlay();
    } catch (error) {
        logDebug("Popcorn: Skip Intro lookup failed:", formatError(error));
    }
}

async function loadKitsuMalId(providerId: string): Promise<string> {
    const kitsuId = providerId.match(/^kitsu:(\d+)$/i)?.[1] || "";
    if (!kitsuId) return "";
    const cached = kitsuMalIds.get(kitsuId);
    if (cached !== undefined) return cached;
    const response = await http.get(
        `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}/mappings`,
        { params: {}, headers: { Accept: "application/vnd.api+json" }, data: {} }
    );
    const malId = response.statusCode >= 200 && response.statusCode < 300
        ? parseKitsuMalId(response.data ?? safeJson(response.text))
        : "";
    kitsuMalIds.set(kitsuId, malId);
    return malId;
}

function safeJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

prepareSplash();
global.onMessage("showPopcornSidebar", toggleSidebar);

event.on("iina.window-loaded", () => {
    sidebar.loadFile("ui/sidebar.html");
    overlay.loadFile("ui/overlay.html");
    overlay.setClickable(true);
    overlay.hide();
    overlay.onMessage("skipIntro", () => {
        const interval = introInterval;
        if (!interval) return;
        introInterval = null;
        overlay.hide();
        core.seekTo(interval.end);
    });
    sidebar.onMessage(MESSAGE_NAMES.PlayItem, playItem);
    sidebar.onMessage(MESSAGE_NAMES.SetMediaType, (data) => {
        const mediaType = parseMediaTypePreference((data as SetMediaTypePayload)?.mediaType);
        preferences.set("mediaType", mediaType);
        preferences.sync();
    });
    sidebar.onMessage(MESSAGE_NAMES.SetEpisodeOrder, (data) => {
        preferences.set(
            "episodeOrder",
            parseEpisodeOrder((data as SetEpisodeOrderPayload)?.episodeOrder)
        );
        preferences.sync();
    });
    sidebar.onMessage(MESSAGE_NAMES.RequestConfiguration, () => {
        watchHistory = parseWatchHistory(preferences.get("watchHistory"));
        sidebar.postMessage(MESSAGE_NAMES.Configuration, {
            addons: parseAddons(
                preferences.get("addons"),
                preferences.get("addonManifestUrl")
            ),
            mediaType: parseMediaTypePreference(preferences.get("mediaType")),
            episodeOrder: parseEpisodeOrder(preferences.get("episodeOrder")),
            history: watchHistory
        });
    });
    windowReady = true;
    global.postMessage("playerReady", {});
    void trakt.sync(watchHistory).then((synced) => {
        const history = mergeWatchHistory(
            parseWatchHistory(preferences.get("watchHistory")),
            synced
        );
        watchHistory = history;
        preferences.set("watchHistory", history);
        preferences.sync();
        sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, { history });
    });
    if (pendingShowSidebar) {
        pendingShowSidebar = false;
        showSidebarWithDelay();
    }
});

event.on("mpv.file-loaded", () => {
    const path = mpv.getString("path") || "";
    isReplacingPlayback = false;
    reachedNaturalEof = false;
    if (path.includes(SPLASH_URL_MARKER)) {
        clearIntro();
        stopPlaybackMonitoring();
        activePlaybackContext = null;
        traktStopSent = false;
        pendingResumePercent = null;
        setPlayerUIHidden(true);
        setWindowTitle("Popcorn");
        showSidebar();
        return;
    }
    restorePlayerOptions();
    setPlayerUIHidden(false);
    hideSidebar();
    startPlaybackMonitoring();
    if (pendingResumePercent !== null) {
        mpv.command("seek", [String(pendingResumePercent), "absolute-percent+exact"]);
        pendingResumePercent = null;
    }
    sendTrakt("start", mpv.getNumber("percent-pos"));
    void resolveIntro();
});

event.on("mpv.pause.changed", () => {
    if (isReplacingPlayback) return;
    if (mpv.getFlag("pause")) checkpointPlayback();
    else sendTrakt("start", mpv.getNumber("percent-pos"));
});
event.on("mpv.eof-reached.changed", () => {
    if (mpv.getFlag("eof-reached")) reachedNaturalEof = true;
});
event.on("mpv.time-pos.changed", updateIntroOverlay);
event.on("mpv.end-file", handleEndFile);
event.on("iina.window-will-close", () => {
    stopPlaybackMonitoring();
    clearIntro();
    checkpointPlayback();
    windowReady = false;
    sidebarVisible = false;
    activePlaybackContext = null;
    traktStopSent = false;
    pendingResumePercent = null;
    isReplacingPlayback = false;
    reachedNaturalEof = false;
    global.postMessage("playerClosed", {});
});

logDebug("Popcorn: Main entry loaded");
