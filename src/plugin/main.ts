import type {
    PlaybackContext,
    PlayItemPayload,
    RemoveHistoryEntryPayload,
    SetEpisodeOrderPayload,
    SetMediaTypePayload
} from "../shared/messages";
import type { AddonManifest, StremioAddon } from "../shared/addons";

import { MESSAGE_NAMES } from "../shared/messages";
import { loadEnabledAddonStreams, parseAddonManifest, parseAddons } from "../shared/addons";
import { parseWatchHistory, recordPlayback, removeHistoryEntry } from "../shared/history";
import {
    buildStremioStreamUrl,
    findClosestQualityStream,
    findNextEpisode,
    isImdbId,
    parseEpisodeOrder,
    parseMediaTypePreference,
    parsePlayableStreams,
    parseSkipSegments,
    type Episode
} from "../shared/stremio";
import { mergeWatchHistory, type TraktScrobbleAction } from "../shared/trakt";
import {
    PLAYBACK_TICK_INTERVAL_MS,
    PROGRESS_SAVE_INTERVAL_MS,
    SHOW_SIDEBAR_DELAY_MS,
    SPLASH_URL_MARKER
} from "./constants";
import {
    isCurrentRequest,
    shouldOfferNextEpisode,
    shouldSaveProgress,
    shouldSendWatchedStop
} from "./playback";
import { keepAwakeTick, startKeepAwake, stopKeepAwake } from "./sleep";
import { createIinaSimklClient } from "./simkl";
import { createIinaTraktClient } from "./trakt";
import {
    findChapterCredits,
    findChapterIntro,
    getOverlayAction,
    parseAniSkipInterval,
    parseIntroDbSegment,
    parseKitsuMalId,
    type IntroInterval,
    type OverlayAction
} from "./intro";
import { formatError, isHttpUrl, logDebug, sanitizeMediaTitle } from "./utils";

const { core, event, global, http, mpv, overlay, preferences, sidebar, utils } = iina;
const trakt = createIinaTraktClient(http, preferences, (error) => {
    logDebug("Popcorn: Trakt request failed:", formatError(error));
});
const simkl = createIinaSimklClient(http, preferences, (error) => {
    logDebug("Popcorn: Simkl request failed:", formatError(error));
});

let windowReady = false;
let pendingShowSidebar = false;
let sidebarVisible = false;
let lastPlaybackTickAt = 0;
let savedImageDisplayDuration: string | null = null;
let savedPositionOnQuitFlag: boolean | null = null;
let activePlaybackContext: PlaybackContext | null = null;
let pendingResumePercent: number | null = null;
let lastProgressSavedAt = 0;
let isReplacingPlayback = false;
let reachedNaturalEof = false;
let scrobbleStopSent = false;
let watchHistory = parseWatchHistory(preferences.get("watchHistory"));
let introInterval: IntroInterval | null = null;
let recapInterval: IntroInterval | null = null;
let creditsInterval: IntroInterval | null = null;
let playbackRevision = 0;
let overlayAction: OverlayAction | null = null;
let overlayVisible = false;
let overlayLabel = "";
let overlayHandlerRegistered = false;
let prefetchedNextEpisode: PlayItemPayload | null = null;
const kitsuMalIds = new Map<string, string>();
const addonManifests = new Map<string, AddonManifest>();

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
    lastPlaybackTickAt = 0;
    startKeepAwake();
}

function updatePlaybackMonitoring(): void {
    const now = Date.now();
    if (now - lastPlaybackTickAt < PLAYBACK_TICK_INTERVAL_MS) return;
    lastPlaybackTickAt = now;
    const playing = !mpv.getFlag("pause");
    keepAwakeTick(playing);
    const percent = mpv.getNumber("percent-pos");
    if (playing && shouldSendWatchedStop(percent, scrobbleStopSent)) {
        sendScrobble("stop", percent);
    }
    if (playing && shouldSaveProgress(now, lastProgressSavedAt, PROGRESS_SAVE_INTERVAL_MS)) {
        savePlaybackProgress();
    }
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

function sendScrobble(action: TraktScrobbleAction, percent: number): void {
    const context = activePlaybackContext;
    if (!context || !Number.isFinite(percent) || scrobbleStopSent) return;
    if (action === "stop") scrobbleStopSent = true;
    void trakt.sendPlayback(action, context, percent);
    void simkl.sendPlayback(action, context, percent);
}

function checkpointPlayback(forceStop = false): void {
    const context = activePlaybackContext;
    if (!context) return;
    const percent = forceStop ? 100 : mpv.getNumber("percent-pos");
    if (!Number.isFinite(percent)) return;
    savePlaybackProgress(percent);
    sendScrobble(
        forceStop || percent >= 90 ? "stop" : "pause",
        percent
    );
}

function stopPlaybackMonitoring(): void {
    lastPlaybackTickAt = 0;
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
    scrobbleStopSent = false;
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
        resolution: context.resolution
    });
}

function clearIntro(): void {
    playbackRevision += 1;
    introInterval = null;
    recapInterval = null;
    creditsInterval = null;
    prefetchedNextEpisode = null;
    overlayAction = null;
    // Force the hide through rather than trusting the cached flag: the overlay belongs to the
    // window, and a file change must never leave a stale control from the previous one.
    overlayVisible = true;
    applyOverlayState();
}

const OVERLAY_LABELS: Record<OverlayAction, string> = {
    recap: "Skip Recap",
    intro: "Skip Intro",
    next: "Next Episode"
};

// Sized in vmin so the control tracks the smaller window dimension and stays proportional in a
// small window as well as fullscreen. The bottom inset never drops below the height of IINA's
// playback controls, which would otherwise cover the button in a short window.
const OVERLAY_STYLE = `
    .skip-overlay {
        position: fixed;
        right: clamp(12px, 6vmin, 120px);
        bottom: clamp(64px, 12vmin, 120px);
        z-index: 1000;
    }
    .skip-button {
        padding: clamp(7px, 1.6vmin, 13px) clamp(13px, 3vmin, 24px);
        border: none;
        border-radius: 999px;
        background: #ffffff;
        color: #000000;
        font: 600 clamp(12px, 2.6vmin, 20px) -apple-system, BlinkMacSystemFont, sans-serif;
        white-space: nowrap;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
        cursor: pointer;
    }
    .skip-button:active { transform: scale(0.98); }
`;

/**
 * Simple mode rather than `loadFile`: loading a page is asynchronous, so clickability set while
 * it is still loading is lost, which silently breaks any interval starting near zero. Simple mode
 * has no load to race. The click is an inline handler for the same reason - it is evaluated when
 * the button is pressed rather than bound during a parse that may precede the bridge.
 */
function renderOverlayButton(action: OverlayAction, label: string): string {
    return `<div class="skip-overlay">` +
        `<button class="skip-button" data-clickable type="button" ` +
        `onclick="iina.postMessage('overlayAction', { action: '${action}' })">${label}</button>` +
        `</div>`;
}

function handleOverlayAction(data: unknown): void {
    // The click carries the action it was showing. A message that lands just after the
    // interval elapsed still does what the user clicked, rather than being discarded.
    const requested = (data as { action?: OverlayAction } | undefined)?.action || overlayAction;
    // The interval is kept, not discarded: seeking back into it must offer the skip again.
    // Hiding now only keeps the click responsive; the next position update recomputes from
    // the real time, and the seek target already sits outside the interval.
    if (requested === "recap" && recapInterval) {
        const end = recapInterval.end;
        overlayAction = null;
        applyOverlayState();
        seekToSeconds(end);
        return;
    }
    if (requested === "intro" && introInterval) {
        const end = introInterval.end;
        overlayAction = null;
        applyOverlayState();
        seekToSeconds(end);
        return;
    }
    if (requested === "next" && prefetchedNextEpisode) {
        const next = prefetchedNextEpisode;
        prefetchedNextEpisode = null;
        playItem(next);
    }
}

/**
 * Activating a mode clears the overlay, which discards any message handler registered before it.
 * So the mode is activated exactly once and the handler registered immediately afterwards; later
 * updates only replace content. Registering in `window-loaded`, before any `simpleMode()` call,
 * left the button rendering and clickable with nothing listening for its message.
 */
function ensureOverlayInitialized(): void {
    if (overlayHandlerRegistered) return;
    overlay.simpleMode();
    overlay.setStyle(OVERLAY_STYLE);
    overlay.onMessage("overlayAction", handleOverlayAction);
    overlayHandlerRegistered = true;
}

function applyOverlayState(): void {
    if (!overlayAction) {
        if (!overlayVisible) return;
        overlay.hide();
        overlay.setClickable(false);
        overlayVisible = false;
        overlayLabel = "";
        return;
    }
    ensureOverlayInitialized();
    const label = OVERLAY_LABELS[overlayAction];
    if (label !== overlayLabel) {
        overlay.setContent(renderOverlayButton(overlayAction, label));
        overlayLabel = label;
    }
    if (overlayVisible) return;
    // Clickable before visible, matching the ordering that is known to work in practice.
    overlay.setClickable(true);
    overlay.show();
    overlayVisible = true;
}

function updateIntroOverlay(): void {
    const action = getOverlayAction(
        mpv.getNumber("time-pos"),
        { intro: introInterval, recap: recapInterval, credits: creditsInterval },
        prefetchedNextEpisode !== null,
        mpv.getNumber("duration")
    );
    if (action === overlayAction) return;
    overlayAction = action;
    applyOverlayState();
}

function handleTimePositionChanged(): void {
    updateIntroOverlay();
    updatePlaybackMonitoring();
}

interface SegmentSources {
    intro: IntroInterval | null;
    recap: IntroInterval | null;
    credits: IntroInterval | null;
}

/**
 * Sources are consulted in order of trustworthiness and only fill what the previous one left
 * missing: chapters come from the file itself, AniSkip covers anime, IntroDB covers live action.
 */
async function resolvePlaybackIntervals(revision: number): Promise<void> {
    const duration = mpv.getNumber("duration");
    const chapters = core.getChapters();
    const found: SegmentSources = {
        intro: findChapterIntro(chapters),
        recap: null,
        credits: findChapterCredits(chapters, duration)
    };
    if (!isCurrentRequest(revision, playbackRevision)) return;
    applySegments(found, duration);
    if (found.intro && found.credits) return;

    const context = activePlaybackContext;
    const episode = context?.episode;
    if (!context || !episode) return;
    if (!parseSkipSegments(preferences.get("skipSegments"))) return;

    const providerId = context.media.providerId || context.media.id || "";
    if (context.media.providerType === "anime" || providerId.startsWith("kitsu:")) {
        const anime = await loadAniSkipSegments(revision, context.media.malId || "", providerId, episode, duration);
        if (!isCurrentRequest(revision, playbackRevision)) return;
        if (anime) {
            found.intro = found.intro || anime.intro;
            found.credits = found.credits || anime.credits;
            applySegments(found, duration);
        }
    }
    if (found.intro && found.recap && found.credits) return;

    const db = await loadIntroDbSegments(revision, context.media.imdbId, episode);
    if (!db || !isCurrentRequest(revision, playbackRevision)) return;
    found.intro = found.intro || db.intro;
    found.recap = found.recap || db.recap;
    found.credits = found.credits || db.credits;
    applySegments(found, duration);
}

/**
 * Sets `time-pos` directly rather than using `core.seekTo` or the mpv `seek` command; this is the
 * form that works reliably from an overlay click. The half second lands past the boundary so the
 * control does not immediately re-appear on the last frame of the interval it just skipped.
 */
function seekToSeconds(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    try {
        mpv.set("time-pos", Math.max(0, seconds + 0.5));
    } catch (error) {
        logDebug("Popcorn: Seek failed:", formatError(error));
    }
}

/** An interval running past the end of the file is bad data, whatever supplied it. */
function applySegments(found: SegmentSources, duration: number): void {
    const known = Number.isFinite(duration) && duration > 0;
    const within = (interval: IntroInterval | null) =>
        interval && (!known || interval.end <= duration) ? interval : null;
    introInterval = within(found.intro);
    recapInterval = within(found.recap);
    creditsInterval = within(found.credits);
    updateIntroOverlay();
}

async function loadAniSkipSegments(
    revision: number,
    knownMalId: string,
    providerId: string,
    episode: Episode,
    duration: number
): Promise<{ intro: IntroInterval | null; credits: IntroInterval | null } | null> {
    try {
        const malId = knownMalId || await loadKitsuMalId(providerId);
        if (!malId || !Number.isFinite(duration) || duration <= 0 ||
            !isCurrentRequest(revision, playbackRevision)) return null;
        const response = await http.get(
            `https://api.aniskip.com/v2/skip-times/${encodeURIComponent(malId)}/${episode.episode}` +
                `?types=op&types=ed&episodeLength=${encodeURIComponent(String(duration))}`,
            { params: {}, headers: { Accept: "application/json" }, data: {} }
        );
        if (response.statusCode < 200 || response.statusCode >= 300) return null;
        const data = safeJson(response.data ?? response.text);
        return { intro: parseAniSkipInterval(data), credits: parseAniSkipInterval(data, "ed") };
    } catch (error) {
        logDebug("Popcorn: Skip interval lookup failed:", formatError(error));
        return null;
    }
}

/**
 * IntroDB is keyed on the series IMDb id plus season and episode, and answers 200 with null
 * segments when it holds nothing, so an empty answer is not an error.
 */
async function loadIntroDbSegments(
    revision: number,
    imdbId: string,
    episode: Episode
): Promise<SegmentSources | null> {
    if (!isImdbId(imdbId) || !(episode.season >= 1) || !(episode.episode >= 1)) return null;
    try {
        const data = await requestJson(
            `https://api.introdb.app/segments?imdb_id=${encodeURIComponent(imdbId)}` +
                `&season=${encodeURIComponent(String(episode.season))}` +
                `&episode=${encodeURIComponent(String(episode.episode))}`
        );
        if (!isCurrentRequest(revision, playbackRevision)) return null;
        return {
            intro: parseIntroDbSegment(data, "intro"),
            recap: parseIntroDbSegment(data, "recap"),
            credits: parseIntroDbSegment(data, "outro")
        };
    } catch (error) {
        // Log the failure only; the id and URL identify what is being watched.
        logDebug("Popcorn: Segment lookup failed:", formatError(error));
        return null;
    }
}

async function prefetchNextEpisode(revision: number): Promise<void> {
    const context = activePlaybackContext;
    const current = context?.episode;
    if (!context || !current) return;
    const next = findNextEpisode(context.episodes, current);
    if (!next) return;

    try {
        const result = await loadEnabledAddonStreams(
            parseAddons(preferences.get("addons"), preferences.get("addonManifestUrl")),
            loadAddonManifest,
            async (addon) => parsePlayableStreams(await requestJson(
                buildStremioStreamUrl(addon.manifestUrl, context.media.type, next.id)
            ))
        );
        if (!isCurrentRequest(revision, playbackRevision)) return;
        const stream = findClosestQualityStream(result.streams, context.resolution || "");
        if (!stream) return;
        prefetchedNextEpisode = {
            url: stream.url,
            title: `${context.media.name} · S${String(next.season).padStart(2, "0")}` +
                `E${String(next.episode).padStart(2, "0")} · ${next.name}`,
            playbackContext: {
                media: context.media,
                episode: next,
                episodes: context.episodes,
                resolution: stream.resolution
            }
        };
        updateIntroOverlay();
    } catch (error) {
        logDebug("Popcorn: Next episode prefetch failed:", formatError(error));
    }
}

async function loadAddonManifest(addon: StremioAddon): Promise<AddonManifest> {
    const cached = addonManifests.get(addon.manifestUrl);
    if (cached) return cached;
    const manifest = parseAddonManifest(await requestJson(addon.manifestUrl));
    addonManifests.set(addon.manifestUrl, manifest);
    return manifest;
}

async function requestJson(url: string): Promise<unknown> {
    const response = await http.get(url, {
        params: {},
        headers: { Accept: "application/json" },
        data: {}
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Request failed with HTTP ${response.statusCode}.`);
    }
    const data = safeJson(response.data ?? response.text);
    if (data === null) throw new Error("Response was not valid JSON.");
    return data;
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

function safeJson(value: unknown): unknown {
    if (typeof value !== "string") return value ?? null;
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
    overlay.setClickable(false);
    overlay.hide();
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
    sidebar.onMessage(MESSAGE_NAMES.RemoveHistoryEntry, (data) => {
        const id = (data as RemoveHistoryEntryPayload)?.id;
        if (typeof id !== "string" || !id) return;
        // Re-read rather than trusting the cached copy; a Trakt sync may have replaced it.
        watchHistory = removeHistoryEntry(parseWatchHistory(preferences.get("watchHistory")), id);
        preferences.set("watchHistory", watchHistory);
        preferences.sync();
        sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, { history: watchHistory });
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
    void trakt.sync(watchHistory)
        .then((synced) => simkl.sync(synced))
        .then((synced) => {
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
        scrobbleStopSent = false;
        pendingResumePercent = null;
        setPlayerUIHidden(true);
        setWindowTitle("Popcorn");
        showSidebar();
        return;
    }
    clearIntro();
    restorePlayerOptions();
    setPlayerUIHidden(false);
    hideSidebar();
    startPlaybackMonitoring();
    if (pendingResumePercent !== null) {
        mpv.command("seek", [String(pendingResumePercent), "absolute-percent+exact"]);
        pendingResumePercent = null;
    }
    sendScrobble("start", mpv.getNumber("percent-pos"));
    const revision = playbackRevision;
    void resolvePlaybackIntervals(revision);
    void prefetchNextEpisode(revision);
});

event.on("mpv.pause.changed", () => {
    if (isReplacingPlayback) return;
    if (mpv.getFlag("pause")) checkpointPlayback();
    else sendScrobble("start", mpv.getNumber("percent-pos"));
});
event.on("mpv.eof-reached.changed", () => {
    if (mpv.getFlag("eof-reached")) reachedNaturalEof = true;
});
event.on("mpv.time-pos.changed", handleTimePositionChanged);
event.on("mpv.end-file", handleEndFile);
event.on("iina.window-will-close", () => {
    stopPlaybackMonitoring();
    clearIntro();
    checkpointPlayback();
    windowReady = false;
    sidebarVisible = false;
    activePlaybackContext = null;
    scrobbleStopSent = false;
    pendingResumePercent = null;
    isReplacingPlayback = false;
    reachedNaturalEof = false;
    global.postMessage("playerClosed", {});
});

logDebug("Popcorn: Main entry loaded");
