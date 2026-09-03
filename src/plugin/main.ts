import type {
    NowPlaying,
    PlaybackContext,
    PlayItemPayload,
    RemoveHistoryEntryPayload,
    SetEpisodeOrderPayload,
    SetMediaTypePayload
} from "../shared/messages";
import type { AddonManifest, StremioAddon } from "../shared/addons";

import { MESSAGE_NAMES } from "../shared/messages";
import { loadEnabledAddonStreams, parseAddonManifest, parseAddons } from "../shared/addons";
import {
    addSimklWatchedEpisodes,
    applySimklWatchedPatches,
    mergeSimklCours,
    getHistoryEntry,
    historyContextId,
    markEpisodeWatched,
    parseEpisodeWatchState,
    parseWatchHistory,
    recordPlayback,
    removeHistoryEntry
} from "../shared/history";
import {
    buildStremioStreamUrl,
    findNextEpisode,
    isImdbId,
    parseEpisodeOrder,
    parseMediaTypePreference,
    parsePlayableStreams,
    normalizeLanguage,
    parseSkipSegments,
    type Episode
} from "../shared/stremio";
import { pickNextEpisodeStream } from "../shared/stream-choice";
import { mergeWatchHistory, type TraktScrobbleAction } from "../shared/trakt";
import {
    HISTORY_SYNC_INTERVAL_MS,
    PLAYBACK_TICK_INTERVAL_MS,
    PROGRESS_SAVE_INTERVAL_MS,
    SHOW_SIDEBAR_DELAY_MS,
    SPLASH_URL_MARKER
} from "./constants";
import {
    isCurrentRequest,
    isPrefetchFresh,
    shouldOfferNextEpisode,
    shouldSaveProgress,
    shouldSendWatchedStop
} from "./playback";
import { keepAwakeTick, startKeepAwake, stopKeepAwake } from "./sleep";
import { createAnimeChainClient } from "./anime";
import { createJsonClient, safeJson } from "./http";
import { createIinaSimklClient } from "./simkl";
import type { AnimeCourEpisode } from "../shared/simkl";
import { createIinaTraktClient } from "./trakt";
import {
    findChapterCredits,
    findChapterIntro,
    getOverlayAction,
    parseAniSkipInterval,
    parseIntroDbSegment,
    sanitizeSegments,
    seasonEpisodeCounts,
    type IntroInterval,
    type OverlayAction
} from "./intro";
import { parseLanguagePreference } from "./preferences";
import { formatError, isHttpUrl, logDebug, sanitizeMediaTitle } from "./utils";

const { core, event, global, http, mpv, overlay, preferences, sidebar, utils } = iina;
const json = createJsonClient(http);
const anime = createAnimeChainClient(http);
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
/** The stream playing now, reported to the sidebar so it can mark that row. */
let activeStreamUrl = "";
let activeStreamRelease = "";
let lastHistorySyncAt = 0;
let historySyncInFlight = false;
let watchHistory = parseWatchHistory(preferences.get("watchHistory"));
let episodeWatchState = parseEpisodeWatchState(
    preferences.get("episodeWatchState"),
    watchHistory
);
let introInterval: IntroInterval | null = null;
let recapInterval: IntroInterval | null = null;
let creditsInterval: IntroInterval | null = null;
let playbackRevision = 0;
let activeCour: Promise<AnimeCourEpisode | null> = Promise.resolve(null);
let overlayAction: OverlayAction | null = null;
let overlayVisible = false;
let overlayLabel = "";
let overlayHandlerRegistered = false;
let prefetchedNextEpisode: PlayItemPayload | null = null;
let prefetchedNextEpisodeAt = 0;
/** Debrid links can expire within the hour; past this the sidebar picks a fresh one instead. */
const PREFETCH_FRESH_MS = 30 * 60_000;
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
    const storedHistory = parseWatchHistory(preferences.get("watchHistory"));
    watchHistory = recordPlayback(
        storedHistory,
        context,
        percent,
        new Date().toISOString()
    );
    episodeWatchState = parseEpisodeWatchState(
        preferences.get("episodeWatchState"),
        storedHistory
    );
    if (context.episode && getHistoryEntry(watchHistory, context)?.watched) {
        episodeWatchState = markEpisodeWatched(episodeWatchState, context);
    }
    preferences.set("watchHistory", watchHistory);
    preferences.set("episodeWatchState", episodeWatchState);
    preferences.sync();
    sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, { history: watchHistory, episodeWatchState });
    lastProgressSavedAt = Date.now();
}

function sendScrobble(action: TraktScrobbleAction, percent: number): void {
    const context = activePlaybackContext;
    if (!context || !Number.isFinite(percent) || scrobbleStopSent) return;
    if (action === "stop") scrobbleStopSent = true;
    void trakt.sendPlayback(action, context, percent);
    // Simkl files anime one cour per show, so the episode has to be placed in the sequel chain
    // before it can be addressed at all. The lookup is cached per show and the promise is
    // shared by every scrobble of this file, so only the first one waits.
    void activeCour.then((cour) => simkl.sendPlayback(action, context, percent, cour));
}

/**
 * The cour the playing episode belongs to, resolved once per file. Null for live action and
 * for anime the chain cannot place, which leaves the scrobble addressed by IMDb id as before.
 */
async function resolveActiveCour(revision: number): Promise<AnimeCourEpisode | null> {
    const context = activePlaybackContext;
    const episode = context?.episode;
    if (!context || !episode) return null;
    try {
        const target = await anime.resolveEpisode(context, episode);
        return isCurrentRequest(revision, playbackRevision) ? target : null;
    } catch (error) {
        logDebug("Popcorn: Anime cour lookup failed:", formatError(error));
        return null;
    }
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
    const previousContext = activePlaybackContext;
    const previousStreamUrl = activeStreamUrl;
    const previousStreamRelease = activeStreamRelease;
    const previousScrobbleStopSent = scrobbleStopSent;
    activePlaybackContext = payload.playbackContext || null;
    activeStreamUrl = url;
    activeStreamRelease = String(payload?.releaseName || "");
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
    try {
        mpv.command("loadfile", [url, "replace", "-1", `force-media-title=${title}`]);
    } catch (error) {
        // The old file is still playing, so hand state back or progress and
        // scrobbles would be recorded under the item we just failed to load.
        activePlaybackContext = previousContext;
        activeStreamUrl = previousStreamUrl;
        activeStreamRelease = previousStreamRelease;
        scrobbleStopSent = previousScrobbleStopSent;
        pendingResumePercent = null;
        isReplacingPlayback = false;
        logDebug("Popcorn: Failed to start stream:", formatError(error));
        utils.ask("Popcorn could not start this stream.");
    }
}

/**
 * The sidebar is told as playback changes, not only when it asks. A viewer starts a stream from
 * a list that is already on screen and never reloaded, so a value delivered with the
 * configuration reply would always predate the playback it describes.
 *
 * Posted from mpv events only, never from inside `playItem`. `playItem` runs inside a sidebar or
 * overlay message callback, and posting back into the webview from there is re-entrant.
 */
function postNowPlaying(): void {
    if (!windowReady) return;
    sidebar.postMessage(MESSAGE_NAMES.NowPlaying, nowPlayingState());
}

function nowPlayingState(): NowPlaying {
    return {
        videoId: activePlaybackContext ? historyContextId(activePlaybackContext) : "",
        url: activePlaybackContext ? activeStreamUrl : "",
        releaseName: activePlaybackContext ? activeStreamRelease : ""
    };
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
    activeStreamUrl = "";
    activeStreamRelease = "";
    postNowPlaying();
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
    activeCour = Promise.resolve(null);
    introInterval = null;
    recapInterval = null;
    creditsInterval = null;
    prefetchedNextEpisode = null;
    prefetchedNextEpisodeAt = 0;
    overlayAction = null;
    // Force the hide through rather than trusting the cached flag: the overlay belongs to the
    // window, and a file change must never leave a stale control from the previous one.
    overlayVisible = true;
    applyOverlayState();
}

const OVERLAY_LABELS: Record<OverlayAction, string> = {
    recap: "Skip Recap",
    intro: "Skip Intro",
    credits: "Skip Outro",
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
    if (requested === "credits" && creditsInterval) {
        const end = creditsInterval.end;
        overlayAction = null;
        applyOverlayState();
        seekToSeconds(end);
        return;
    }
    if (requested === "next" && prefetchedNextEpisode) {
        const next = prefetchedNextEpisode;
        const fresh = isPrefetchFresh(prefetchedNextEpisodeAt, Date.now(), PREFETCH_FRESH_MS);
        prefetchedNextEpisode = null;
        prefetchedNextEpisodeAt = 0;
        // Move the sidebar with the player. Only the end of a file did this, so skipping ahead
        // from the overlay left the stream list on the episode that just finished, and the next
        // stream picked there would have been for the wrong episode.
        const context = next.playbackContext;
        if (context.episode) {
            sidebar.postMessage(MESSAGE_NAMES.ShowNextEpisode, {
                media: context.media,
                episode: context.episode,
                episodes: context.episodes,
                resolution: context.resolution
            });
        }
        if (!fresh) {
            // The link was generated when this episode started and may be long expired; playing
            // it blind fails in mpv. The sidebar is already opening the next episode's fresh
            // stream list, so hand the choice back to the user instead.
            core.osd("Stream link expired - pick a stream for the next episode.");
            return;
        }
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

    // AniSkip is not gated on the item looking like anime: Cinemeta reports every series as
    // `series`, so anime opened through it never reached AniSkip at all. The title lookup is
    // itself the anime test, since AniList knows no live-action title.
    //
    // The two run together rather than one after the other. Chained, a slow or unreachable anime
    // lookup withheld IntroDB's answer as well, and the Skip Intro it already had never appeared.
    const merge = (part: PartialSegments | null): void => {
        if (!part || !isCurrentRequest(revision, playbackRevision)) return;
        found.intro = found.intro || part.intro;
        found.recap = found.recap || (part.recap ?? null);
        found.credits = found.credits || part.credits;
        applySegments(found, duration);
    };
    await Promise.all([
        loadAniSkipSegments(revision, context, episode, duration).then(merge),
        loadIntroDbSegments(revision, context.media.imdbId, episode).then(merge)
    ]);
}

/** What a single source found; only IntroDB reports recaps. */
interface PartialSegments {
    intro: IntroInterval | null;
    recap?: IntroInterval | null;
    credits: IntroInterval | null;
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

function applySegments(found: SegmentSources, duration: number): void {
    const segments = sanitizeSegments(found, duration);
    introInterval = segments.intro;
    recapInterval = segments.recap;
    creditsInterval = segments.credits;
    updateIntroOverlay();
}

async function loadAniSkipSegments(
    revision: number,
    context: PlaybackContext,
    episode: Episode,
    duration: number
): Promise<{ intro: IntroInterval | null; credits: IntroInterval | null } | null> {
    try {
        const target = await anime.resolveEpisode(context, episode);
        if (!target || !isCurrentRequest(revision, playbackRevision)) return null;
        // Every submission is requested and the nearest runtime chosen here. AniSkip's own
        // `episodeLength` filter is tight enough that a rip cut differently from the
        // submitter's answered 404, and the episode looked as if it had no data at all.
        const response = await http.get(
            `https://api.aniskip.com/v2/skip-times/${encodeURIComponent(target.malId)}/${target.episode}` +
                "?types=op&types=ed&episodeLength=0",
            { params: {}, headers: { Accept: "application/json" }, data: {} }
        );
        if (response.statusCode < 200 || response.statusCode >= 300) return null;
        const data = safeJson(response.data ?? response.text);
        const runtime = Number.isFinite(duration) && duration > 0 ? duration : 0;
        return {
            intro: parseAniSkipInterval(data, "op", runtime),
            credits: parseAniSkipInterval(data, "ed", runtime)
        };
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
        const data = await json.getJson(
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

/**
 * The language of the track being played. A standing setting cannot know that this particular
 * show is being watched subbed rather than dubbed, so the next episode follows the file the
 * viewer is actually watching and falls back to the setting only when the file says nothing.
 */
function playingReleaseName(): string {
    try {
        // The file itself, not the title Popcorn wrote over it.
        return mpv.getString("filename") || "";
    } catch (error) {
        logDebug("Popcorn: Filename lookup failed:", formatError(error));
        return "";
    }
}

function playingTrackLanguage(track: "audio" | "sub"): string {
    try {
        const tag = (mpv.getString(`current-tracks/${track}/lang`) || "").trim();
        // An untagged track carries no preference; treating "und" as one would rank every
        // stream that does name a language as a mismatch.
        return /^(und|undetermined|unknown)$/i.test(tag) ? "" : normalizeLanguage(tag);
    } catch (error) {
        logDebug("Popcorn: Track language lookup failed:", formatError(error));
        return "";
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
            async (addon) => parsePlayableStreams(await json.getJson(
                buildStremioStreamUrl(addon.manifestUrl, context.media.type, next.id)
            ))
        );
        if (!isCurrentRequest(revision, playbackRevision)) return;
        // The overlay button plays this without asking, so it follows what is actually playing
        // first and the standing settings only where the file says nothing, and prefers streams
        // that can start now.
        const stream = pickNextEpisodeStream(result.streams, {
            previousResolution: context.resolution || "",
            previousRelease: playingReleaseName(),
            showTitle: context.media.name,
            preferredAudio: playingTrackLanguage("audio") ||
                parseLanguagePreference(preferences.get("preferredAudio")),
            preferredSubtitle: playingTrackLanguage("sub") ||
                parseLanguagePreference(preferences.get("preferredSubtitle"))
        });
        if (!stream) return;
        prefetchedNextEpisode = {
            url: stream.url,
            // Without this the overlay's own playback reports no release, and the sidebar has
            // nothing to match its rows against once the debrid link is reissued.
            releaseName: stream.rawTitle,
            title: `${context.media.name} · S${String(next.season).padStart(2, "0")}` +
                `E${String(next.episode).padStart(2, "0")} · ${next.name}`,
            playbackContext: {
                media: context.media,
                episode: next,
                episodes: context.episodes,
                resolution: stream.resolution
            }
        };
        prefetchedNextEpisodeAt = Date.now();
        updateIntroOverlay();
    } catch (error) {
        logDebug("Popcorn: Next episode prefetch failed:", formatError(error));
    }
}

async function loadAddonManifest(addon: StremioAddon): Promise<AddonManifest> {
    const cached = addonManifests.get(addon.manifestUrl);
    if (cached) return cached;
    const manifest = parseAddonManifest(await json.getJson(addon.manifestUrl));
    addonManifests.set(addon.manifestUrl, manifest);
    return manifest;
}

/**
 * Startup was the only trigger, so a window left open never learned what was watched on another
 * device, and a failed pull waited for the next window instead of retrying. The sidebar asks for
 * configuration on load, on every search, and on every stream list, which is a good enough
 * heartbeat once it is rate limited.
 */
function syncRemoteHistory(): void {
    const now = Date.now();
    if (historySyncInFlight || now - lastHistorySyncAt < HISTORY_SYNC_INTERVAL_MS) return;
    historySyncInFlight = true;
    lastHistorySyncAt = now;
    void trakt.sync(watchHistory)
        .then((synced) => simkl.sync(synced))
        .then(async (synced) => {
            const latestHistory = parseWatchHistory(preferences.get("watchHistory"));
            const merged = mergeWatchHistory(
                latestHistory,
                synced.history
            );
            // Anime arrives keyed by cour and has to be walked back onto Cinemeta's seasons
            // before it means anything to the sidebar. Reading preferences again afterwards
            // keeps progress recorded while the lookups ran.
            const stored = mergeSimklCours(
                applySimklWatchedPatches(
                    parseEpisodeWatchState(preferences.get("episodeWatchState"), merged),
                    synced.watchedPatches
                ),
                synced.watchedCours
            );
            // Every cour held so far, not only this pull's: an incremental pull carries just
            // the cours that changed, and a show's other cours must keep their marks. Anime
            // reaches the history only through here, since the IMDb id Simkl files a later cour
            // under names the series it continues rather than the one Popcorn shows.
            const placed = await anime.placeWatchedCours(stored.simklCours, merged);
            const watchedState = addSimklWatchedEpisodes(stored, placed.patches);
            const history = mergeWatchHistory(merged, placed.entries);
            watchHistory = history;
            episodeWatchState = watchedState;
            preferences.set("watchHistory", history);
            preferences.set("episodeWatchState", watchedState);
            preferences.sync();
            sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, {
                history,
                episodeWatchState: watchedState
            });
        })
        .catch((error) => logDebug(`History sync failed: ${formatError(error)}`))
        .then(() => {
            historySyncInFlight = false;
        });
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
        const storedHistory = parseWatchHistory(preferences.get("watchHistory"));
        episodeWatchState = parseEpisodeWatchState(
            preferences.get("episodeWatchState"),
            storedHistory
        );
        watchHistory = removeHistoryEntry(storedHistory, id);
        preferences.set("watchHistory", watchHistory);
        preferences.set("episodeWatchState", episodeWatchState);
        preferences.sync();
        sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, { history: watchHistory, episodeWatchState });
    });
    sidebar.onMessage(MESSAGE_NAMES.RequestConfiguration, () => {
        watchHistory = parseWatchHistory(preferences.get("watchHistory"));
        episodeWatchState = parseEpisodeWatchState(
            preferences.get("episodeWatchState"),
            watchHistory
        );
        sidebar.postMessage(MESSAGE_NAMES.Configuration, {
            addons: parseAddons(
                preferences.get("addons"),
                preferences.get("addonManifestUrl")
            ),
            mediaType: parseMediaTypePreference(preferences.get("mediaType")),
            episodeOrder: parseEpisodeOrder(preferences.get("episodeOrder")),
            history: watchHistory,
            episodeWatchState,
            // Covers a sidebar that loads while something is already playing; changes after
            // that arrive through the NowPlaying message.
            nowPlaying: nowPlayingState()
        });
        syncRemoteHistory();
    });
    windowReady = true;
    global.postMessage("playerReady", {});
    syncRemoteHistory();
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
        postNowPlaying();
        showSidebar();
        return;
    }
    clearIntro();
    postNowPlaying();
    restorePlayerOptions();
    setPlayerUIHidden(false);
    hideSidebar();
    startPlaybackMonitoring();
    if (pendingResumePercent !== null) {
        mpv.command("seek", [String(pendingResumePercent), "absolute-percent+exact"]);
        pendingResumePercent = null;
    }
    activeCour = resolveActiveCour(playbackRevision);
    sendScrobble("start", mpv.getNumber("percent-pos"));
    const revision = playbackRevision;
    // A file this plugin did not start belongs to whatever opened it, so no skip controls and no
    // next-episode prefetch: the overlay is Popcorn's and must not sit over another plugin's playback.
    if (!activePlaybackContext) return;
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
    activeStreamUrl = "";
    activeStreamRelease = "";
    scrobbleStopSent = false;
    pendingResumePercent = null;
    isReplacingPlayback = false;
    reachedNaturalEof = false;
    global.postMessage("playerClosed", {});
});

logDebug("Popcorn: Main entry loaded");
