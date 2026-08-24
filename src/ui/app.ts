import type { ConfigurationPayload, HistoryPayload, ShowNextEpisodePayload } from "../shared/messages";
import type { AddonManifest, AddonStream, StremioAddon } from "../shared/addons";
import type { WatchHistoryEntry } from "../shared/history";
import type { Episode, EpisodeOrder, Media, MediaType, SizeOrder } from "../shared/stremio";

import { loadEnabledAddonStreams, parseAddonManifest, parseAddons } from "../shared/addons";
import { getResumePercent, historyTitleId, latestPerTitle, parseWatchHistory } from "../shared/history";
import { MESSAGE_NAMES } from "../shared/messages";
import { CLIENT_VERSION } from "../shared/version";
import {
    buildCinemetaPosterUrl,
    buildCinemetaSearchUrl,
    buildCinemetaSeriesUrl,
    buildCinemetaTrendingUrl,
    buildOpenSubtitlesUrl,
    buildStremioStreamUrl,
    buildStremioResourceUrl,
    getSearchableCatalogs,
    isCompatibleSubtitleId,
    isImdbId,
    findClosestQualityStream,
    findNextEpisode,
    isEpisodeAvailable,
    parseEnglishSubtitleAvailability,
    parseEpisodeOrder,
    parseMediaResponse,
    parseMediaMetadata,
    parseMediaTypePreference,
    parsePlayableStreams,
    sortEpisodes,
    sortStreamsForPlayback,
    groupStreamsByResolution,
    mergeMediaResults
} from "../shared/stremio";

type View =
    | { kind: "home"; query: string }
    | { kind: "history" }
    | { kind: "episodes"; media: Media }
    | { kind: "streams"; media: Media; episode?: Episode; episodes: Episode[] };

interface Elements {
    back: HTMLButtonElement;
    content: HTMLDivElement;
    error: HTMLDivElement;
    errorMessage: HTMLParagraphElement;
    loading: HTMLDivElement;
    movies: HTMLButtonElement;
    retry: HTMLButtonElement;
    searchClear: HTMLButtonElement;
    searchForm: HTMLFormElement;
    searchInput: HTMLInputElement;
    title: HTMLHeadingElement;
    tv: HTMLButtonElement;
}

let ui: Elements;
let mediaType: MediaType = "movie";
/** A type switch not yet echoed back by the plugin; incoming configuration must not undo it. */
let pendingMediaType: MediaType | null = null;
let episodeOrder: EpisodeOrder = "oldest";
let addons: StremioAddon[] = [];
let watchHistory: WatchHistoryEntry[] = [];
const seriesEpisodes = new Map<string, Promise<{ media: Media; episodes: Episode[] } | null>>();
let homeQuery = "";
let view: View = { kind: "home", query: "" };
let retryAction: (() => Promise<void>) | null = null;
let pendingConfigurationResolvers: Array<() => void> = [];
let activeRequest: AbortController | null = null;
const addonManifests = new Map<string, AddonManifest>();

export function replaceRequest(previous: AbortController | null): AbortController {
    previous?.abort();
    return new AbortController();
}

export function mergeSettledCatalogResults(
    results: PromiseSettledResult<Media[]>[]
): { items: Media[]; failedSources: number; successfulSources: number } {
    const groups = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    return {
        items: mergeMediaResults(groups),
        failedSources: results.length - groups.length,
        successfulSources: groups.length
    };
}

export function getProgressDisplay(
    progress: number | null,
    watched: boolean
): { percent: number; label: string } | null {
    if (watched || progress === null || progress < 5 || progress >= 90) return null;
    const percent = Math.round(progress);
    return { percent, label: `${percent}% watched` };
}

export function getEpisodeOrderLabel(order: EpisodeOrder): string {
    return order === "newest" ? "Newest First" : "Oldest First";
}

export function getEpisodeOrderButtonId(order: EpisodeOrder): string {
    return `episode-order-${order}`;
}

export function getSizeSortControl(
    order: SizeOrder
): { label: string; next: SizeOrder } {
    return order === "largest"
        ? { label: "Largest File", next: "smallest" }
        : { label: "Smallest File", next: "largest" };
}

export function initApp(): void {
    iina.onMessage(MESSAGE_NAMES.Configuration, (data) => {
        applyConfiguration(data);
        const resolvers = pendingConfigurationResolvers;
        pendingConfigurationResolvers = [];
        resolvers.forEach((resolve) => resolve());
    });
    iina.onMessage(MESSAGE_NAMES.HistoryUpdated, (data) => {
        watchHistory = parseWatchHistory((data as HistoryPayload)?.history);
        if (view.kind === "history") renderHistory();
    });
    iina.onMessage(MESSAGE_NAMES.ShowNextEpisode, (data) => {
        const payload = data as ShowNextEpisodePayload;
        if (!payload?.media || !payload?.episode || !Array.isArray(payload?.episodes)) {
            return;
        }
        void loadStreams(payload.media, payload.episode, payload.episodes, payload.resolution, true);
    });

    document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.dataset.version = CLIENT_VERSION;
        ui = {
            back: element("back-btn"),
            content: element("content"),
            error: element("error-state"),
            errorMessage: element("error-message"),
            loading: element("loading"),
            movies: element("movies-btn"),
            retry: element("retry-btn"),
            searchClear: element("search-clear"),
            searchForm: element("search-form"),
            searchInput: element("search-input"),
            title: element("section-title"),
            tv: element("tv-btn")
        };

        ui.searchForm.addEventListener("submit", (event) => {
            event.preventDefault();
            void loadHome(ui.searchInput.value.trim());
        });
        ui.searchInput.addEventListener("input", updateSearchClear);
        ui.searchClear.addEventListener("click", () => {
            ui.searchInput.value = "";
            updateSearchClear();
            ui.searchInput.focus();
            // Only reload when a search was actually showing; typing then clearing without
            // submitting should not throw away the browse results already on screen.
            if (homeQuery) void loadHome("");
        });
        ui.movies.addEventListener("click", () => switchType("movie"));
        ui.tv.addEventListener("click", () => switchType("series"));
        ui.back.addEventListener("click", () => void goBack());
        ui.retry.addEventListener("click", () => retryAction && void retryAction());

        updateTypeButtons();
        void refreshConfiguration().then(() => loadHome(""));
    });
}

function applyConfiguration(data: unknown): void {
    const payload = data as ConfigurationPayload;
    addons = parseAddons(payload?.addons);
    // Setting the type and requesting configuration are separate messages, so a reply can arrive
    // still carrying the old type. Hold the local choice until the plugin reports it back, or
    // switching type during a search would silently flip straight back.
    const incoming = parseMediaTypePreference(payload?.mediaType);
    if (pendingMediaType === null || incoming === pendingMediaType) {
        pendingMediaType = null;
        mediaType = incoming;
    }
    episodeOrder = parseEpisodeOrder(payload?.episodeOrder);
    watchHistory = parseWatchHistory(payload?.history);
    updateTypeButtons();
}

function refreshConfiguration(): Promise<void> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            pendingConfigurationResolvers = pendingConfigurationResolvers.filter((item) => item !== finish);
            resolve();
        };
        const timeout = window.setTimeout(finish, 1000);
        pendingConfigurationResolvers.push(finish);
        iina.postMessage(MESSAGE_NAMES.RequestConfiguration, {});
    });
}

function element<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing element: ${id}`);
    return value as T;
}

function switchType(type: MediaType): void {
    if (mediaType === type && view.kind === "home") return;
    mediaType = type;
    pendingMediaType = type;
    updateTypeButtons();
    iina.postMessage(MESSAGE_NAMES.SetMediaType, { mediaType });
    // Keep whatever was searched: switching type is usually "same title, other kind",
    // so re-run the query against the new type rather than throwing it away.
    void loadHome(ui.searchInput.value.trim());
}

function updateTypeButtons(): void {
    ui.movies.classList.toggle("active", mediaType === "movie");
    ui.tv.classList.toggle("active", mediaType === "series");
}

function updateSearchClear(): void {
    ui.searchClear.classList.toggle("hidden", ui.searchInput.value.length === 0);
}

async function loadHome(query: string): Promise<void> {
    const request = replaceRequest(activeRequest);
    activeRequest = request;
    homeQuery = query;
    view = { kind: "home", query };
    ui.searchInput.value = query;
    updateSearchClear();
    ui.back.classList.add("hidden");
    ui.title.textContent = query ? "Search Results" : watchHistory.length > 0 ? "Browse" : "Trending";
    setLoading("grid");
    retryAction = () => loadHome(query);

    try {
        if (!query) {
            const items = parseMediaResponse(await fetchJson(
                buildCinemetaTrendingUrl(mediaType),
                request.signal
            ));
            renderMedia(items, query);
            return;
        }
        const result = await searchCatalogs(query, request.signal);
        if (result.successfulSources === 0) {
            throw new Error("Could not search any catalog.");
        }
        renderMedia(result.items, query, result.failedSources);
    } catch (error) {
        if (!request.signal.aborted) showError(readError(error, "Could not load Cinemeta."));
    }
}

async function searchCatalogs(
    query: string,
    signal: AbortSignal
): Promise<{ items: Media[]; failedSources: number; successfulSources: number }> {
    await refreshConfiguration();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const enabledAddons = addons.filter((addon) => addon.enabled);
    const [cinemetaResults, manifestResults] = await Promise.all([
        Promise.allSettled([
            fetchJson(buildCinemetaSearchUrl(mediaType, query), signal).then(parseMediaResponse)
        ]),
        Promise.allSettled(enabledAddons.map(async (addon) => ({
            addon,
            manifest: await loadAddonManifest(addon, signal)
        })))
    ]);
    const sources = manifestResults.flatMap((result) => result.status === "fulfilled"
        ? getSearchableCatalogs(result.value.manifest, mediaType).map((catalog) => ({
            addon: result.value.addon,
            catalog
        }))
        : []
    );
    const catalogResults = await Promise.allSettled(sources.map(({ addon, catalog }) => (
        fetchJson(buildStremioResourceUrl(
            addon.manifestUrl,
            "catalog",
            catalog.type,
            catalog.id,
            { search: query }
        ), signal).then((value) => parseMediaResponse(value, { manifestUrl: addon.manifestUrl }))
    )));
    const result = mergeSettledCatalogResults([...cinemetaResults, ...catalogResults]);
    return {
        ...result,
        failedSources: result.failedSources + manifestResults.filter((item) => item.status === "rejected").length
    };
}

async function loadAddonManifest(addon: StremioAddon, signal: AbortSignal): Promise<AddonManifest> {
    const cached = addonManifests.get(addon.manifestUrl);
    if (cached) return cached;
    const manifest = parseAddonManifest(await fetchJson(addon.manifestUrl, signal));
    addonManifests.set(addon.manifestUrl, manifest);
    return manifest;
}

async function loadMediaDetails(
    media: Media,
    signal: AbortSignal
): Promise<{ media: Media; episodes: Episode[]; metadataAvailable: boolean }> {
    const sourceUrl = media.sourceManifestUrl || "";
    const providerId = media.providerId || media.id;
    const providerType = media.providerType || media.type;
    if (!sourceUrl || sourceUrl.includes("v3-cinemeta.strem.io")) {
        if (media.type === "movie") return { media, episodes: [], metadataAvailable: true };
        const value = await fetchJson(buildCinemetaSeriesUrl(media.imdbId || providerId), signal);
        const details = parseMediaMetadata(value, { manifestUrl: sourceUrl }, media);
        return { ...details, metadataAvailable: true };
    }

    const addon = addons.find((item) => item.manifestUrl === sourceUrl) || {
        name: media.name,
        manifestUrl: sourceUrl,
        enabled: true
    };
    const manifest = await loadAddonManifest(addon, signal);
    if (manifest.resources.includes("meta")) {
        const value = await fetchJson(buildStremioResourceUrl(
            sourceUrl,
            "meta",
            providerType,
            providerId
        ), signal);
        const details = parseMediaMetadata(value, { manifestUrl: sourceUrl }, media);
        return { ...details, metadataAvailable: true };
    }
    if (media.type === "movie") return { media, episodes: [], metadataAvailable: true };
    if (!isImdbId(media.imdbId)) return { media, episodes: [], metadataAvailable: false };
    const value = await fetchJson(buildCinemetaSeriesUrl(media.imdbId), signal);
    const details = parseMediaMetadata(value, { manifestUrl: sourceUrl }, media);
    return { ...details, metadataAvailable: true };
}

async function loadEpisodes(media: Media, season?: number): Promise<void> {
    const request = replaceRequest(activeRequest);
    activeRequest = request;
    view = { kind: "episodes", media };
    ui.back.classList.remove("hidden");
    ui.title.textContent = media.name;
    setLoading("episodes");
    retryAction = () => loadEpisodes(media, season);

    try {
        const details = await loadMediaDetails(media, request.signal);
        if (!details.metadataAvailable) {
            renderEmpty("Episode metadata unavailable.");
            return;
        }
        renderEpisodes(details.media, details.episodes, undefined, season);
    } catch (error) {
        if (!request.signal.aborted) showError(readError(error, "Could not load episodes."));
    }
}

async function loadMovie(media: Media): Promise<void> {
    const request = replaceRequest(activeRequest);
    activeRequest = request;
    ui.back.classList.remove("hidden");
    ui.title.textContent = media.name;
    setLoading();
    retryAction = () => loadMovie(media);
    try {
        const details = await loadMediaDetails(media, request.signal);
        if (!request.signal.aborted) await loadStreams(details.media);
    } catch (error) {
        if (!request.signal.aborted) showError(readError(error, "Could not load metadata."));
    }
}

async function loadStreams(
    media: Media,
    episode?: Episode,
    episodes: Episode[] = [],
    preferredQuality?: string,
    recommendNext = false
): Promise<void> {
    const request = replaceRequest(activeRequest);
    activeRequest = request;
    view = { kind: "streams", media, episode, episodes };
    ui.back.classList.remove("hidden");
    ui.title.textContent = episode ? formatEpisodeTitle(media, episode) : media.name;
    setLoading("rows", recommendNext);
    retryAction = () => loadStreams(media, episode, episodes, preferredQuality, recommendNext);

    try {
        await refreshConfiguration();
        if (request.signal.aborted) return;
        const videoId = episode?.id || media.imdbId || media.providerId || media.id;
        const [result, englishSubtitles] = await Promise.all([
            loadEnabledAddonStreams(
                addons,
                (addon) => loadAddonManifest(addon, request.signal),
                async (addon) => parsePlayableStreams(await fetchJson(
                    buildStremioStreamUrl(addon.manifestUrl, media.type, videoId),
                    request.signal
                ))
            ),
            isCompatibleSubtitleId(videoId)
                ? fetchJson(buildOpenSubtitlesUrl(media.type, videoId), request.signal)
                    .then(parseEnglishSubtitleAvailability)
                    .catch(() => null)
                : Promise.resolve(null)
        ]);
        if (request.signal.aborted) return;
        if (result.successfulAddons === 0) {
            throw new Error("Enable a stream addon in IINA Settings → Plugins → Popcorn for IINA.");
        }
        renderStreams(
            media,
            episode,
            episodes,
            result.streams,
            result.failedAddons,
            englishSubtitles,
            preferredQuality,
            recommendNext
        );
    } catch (error) {
        if (!request.signal.aborted) showError(readError(error, "Could not load streams."));
    }
}

async function goBack(): Promise<void> {
    if (view.kind === "episodes") {
        await loadHome(homeQuery);
    } else if (view.kind === "streams" && view.episode) {
        // The episode that was opened names the season to return to, so going back does not
        // snap to whichever season the default would have picked.
        await loadEpisodes(view.media, view.episode.season);
    } else if (view.kind === "streams") {
        await loadHome(homeQuery);
    } else if (view.kind === "history") {
        await loadHome(homeQuery);
    }
}

function renderMedia(items: Media[], query: string, failedSources = 0): void {
    if (items.length === 0) {
        renderEmpty("No titles found.");
        return;
    }
    const fragment = document.createDocumentFragment();
    if (failedSources > 0) fragment.appendChild(addonWarning(failedSources, "catalog"));
    if (!query && watchHistory.length > 0) {
        // Both only exist because history is non-empty, so both go when the last entry is removed.
        const history = historySection(continueWatching(), true);
        const heading = contentHeading("Trending");
        history.dataset.historyChrome = "";
        heading.dataset.historyChrome = "";
        fragment.append(history, heading);
    }
    fragment.appendChild(mediaGrid(items.map((media) => mediaCard(
        media,
        media.name,
        media.releaseInfo,
        () => {
            if (media.type === "series") void loadEpisodes(media);
            else void loadMovie(media);
        },
        isWatched(mediaIdentity(media)),
        null
    ))));
    showContent(fragment);
}

function renderHistory(): void {
    view = { kind: "history" };
    ui.back.classList.remove("hidden");
    ui.title.textContent = "Recently Watched";
    retryAction = null;
    if (watchHistory.length === 0) {
        renderEmpty("Nothing watched yet.");
        return;
    }
    showContent(historySection(latestPerTitle(watchHistory), false));
}

/**
 * One card per title, each with something left to do: an episode or film part way through, or a
 * show whose last episode is finished and whose next one is still ahead. A finished film has
 * nothing to continue, so it waits in See all.
 */
function continueWatching(): WatchHistoryEntry[] {
    return latestPerTitle(watchHistory).filter((entry) =>
        Boolean(entry.episode) || getResumePercent(entry.progress, entry.watched) !== null);
}

/**
 * The episode list is not in history, so a finished show cannot name its next episode here
 * without a lookup per card. Opening the show does it instead: the episode view already lands
 * on the first unwatched episode.
 */
function isUpNext(entry: WatchHistoryEntry): boolean {
    return Boolean(entry.episode) && getResumePercent(entry.progress, entry.watched) === null;
}

/** How many cards the home strip holds. See all carries the rest. */
const HOME_HISTORY_CARDS = 6;

function historySection(entries: WatchHistoryEntry[], home: boolean): HTMLElement {
    const section = document.createElement("section");
    section.className = "history-section";
    if (!home) {
        section.appendChild(mediaGrid(entries.map((entry) => historySlot(entry, false))));
        return section;
    }
    section.appendChild(contentHeading("Continue Watching", renderHistory));
    const grid = mediaGrid([]);
    section.appendChild(grid);

    let next = 0;
    // A card whose show turns out to have nothing airing leaves, and the title behind it takes
    // the free space, so the strip stays six wide as long as there are titles to fill it.
    const fill = (): void => {
        while (grid.childElementCount < HOME_HISTORY_CARDS && next < entries.length) {
            const entry = entries[next];
            next += 1;
            const upNext = isUpNext(entry);
            const slot = historySlot(entry, upNext);
            grid.appendChild(slot);
            if (upNext) void resolveUpNext(entry, slot).then(fill);
        }
    };
    fill();
    return section;
}

function historySlot(entry: WatchHistoryEntry, upNext: boolean): HTMLElement {
    // See all is a record of what was watched, so the watched mark stays there; the home strip
    // is a list of things to do, where it would only read as already handled.
    const episode = entry.episode;
    return removableSlot(entry, mediaCard(
        entry.media,
        entry.media.name,
        !episode
            ? entry.media.releaseInfo
            : upNext
                ? `After S${pad(episode.season)}E${pad(episode.episode)}`
                : `S${pad(episode.season)}E${pad(episode.episode)} · ${episode.name}`,
        () => upNext ? void loadEpisodes(entry.media) : void openHistoryEntry(entry),
        upNext ? false : entry.watched,
        upNext ? null : entry.progress
    ));
}

/**
 * A card offering the next episode has to mean it, and history carries no episode list to check
 * against. So the strip paints first, then each up-next card names the episode that actually
 * exists and has aired - or drops out, because the show has nothing left to watch right now.
 * A lookup that fails leaves the card as it was rather than removing something watchable.
 */
async function resolveUpNext(entry: WatchHistoryEntry, slot: HTMLElement): Promise<void> {
    const current = entry.episode;
    if (!current) return;
    const details = await loadSeriesEpisodes(entry.media);
    if (!details || details.episodes.length === 0 || !slot.isConnected) return;
    const next = findNextEpisode(details.episodes, current);
    if (!next) {
        slot.remove();
        return;
    }
    slot.replaceWith(removableSlot(entry, mediaCard(
        entry.media,
        entry.media.name,
        `Next · S${pad(next.season)}E${pad(next.episode)} · ${next.name}`,
        () => void loadStreams(details.media, next, details.episodes),
        false,
        null
    )));
}

/** The strip rebuilds on every return to home, and an episode list does not move that often. */
function loadSeriesEpisodes(media: Media): Promise<{ media: Media; episodes: Episode[] } | null> {
    const key = mediaIdentity(media);
    const cached = seriesEpisodes.get(key);
    if (cached) return cached;
    const request = loadMediaDetails(media, new AbortController().signal)
        .then((details) => ({ media: details.media, episodes: details.episodes }))
        .catch(() => {
            // Forget the failure so the next render tries again instead of inheriting it.
            seriesEpisodes.delete(key);
            return null;
        });
    seriesEpisodes.set(key, request);
    return request;
}

/**
 * The card itself is a button, so the remove control cannot nest inside it; it rides alongside
 * in a positioned slot instead.
 */
function removableSlot(entry: WatchHistoryEntry, card: HTMLButtonElement): HTMLElement {
    const slot = document.createElement("div");
    slot.className = "card-slot";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "card-remove";
    remove.textContent = "×";
    remove.title = `Remove ${entry.media.name} from Recently Watched`;
    remove.setAttribute("aria-label", remove.title);
    remove.setAttribute("data-clickable", "");
    remove.addEventListener("click", () => removeFromHistory(entry, slot));
    slot.append(card, remove);
    return slot;
}

function removeFromHistory(entry: WatchHistoryEntry, slot: HTMLElement): void {
    // The card stands for the whole title, so every episode of it goes with the one shown.
    watchHistory = watchHistory.filter((item) => historyTitleId(item) !== historyTitleId(entry));
    iina.postMessage(MESSAGE_NAMES.RemoveHistoryEntry, { id: entry.id });
    // Drop the one node rather than re-rendering, so the home view keeps its loaded catalogs.
    slot.remove();
    if (watchHistory.length > 0) return;
    if (view.kind === "history") {
        renderEmpty("Nothing watched yet.");
        return;
    }
    // Leave the home view looking exactly as it would have rendered with no history at all.
    ui.content.querySelectorAll("[data-history-chrome]").forEach((node) => node.remove());
    if (view.kind === "home" && !view.query) ui.title.textContent = "Trending";
}

function contentHeading(title: string, action?: () => void): HTMLElement {
    const heading = document.createElement("div");
    heading.className = "content-heading";
    const label = document.createElement("h3");
    label.textContent = title;
    heading.appendChild(label);
    if (action) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "See all";
        button.setAttribute("data-clickable", "");
        button.addEventListener("click", action);
        heading.appendChild(button);
    }
    return heading;
}

function mediaGrid(cards: HTMLElement[]): HTMLElement {
    const grid = document.createElement("div");
    grid.className = "media-grid";
    grid.append(...cards);
    return grid;
}

function mediaCard(
    media: Media,
    title: string,
    subtitle: string,
    action: () => void,
    watched: boolean,
    progress: number | null = null
): HTMLButtonElement {
    const card = document.createElement("button");
    card.className = "media-card";
    card.type = "button";
    card.setAttribute("data-clickable", "");
    card.setAttribute("aria-label", watched ? `${title}, watched` : title);
    card.addEventListener("click", action);

    const poster = document.createElement("div");
    poster.className = "poster";
    const posterUrl = media.poster || (isImdbId(media.imdbId) ? buildCinemetaPosterUrl(media.imdbId) : "");
    if (posterUrl) {
        const image = document.createElement("img");
        image.src = posterUrl;
        image.alt = "";
        image.loading = "lazy";
        image.addEventListener("error", () => image.remove(), { once: true });
        poster.appendChild(image);
    }
    if (watched) {
        const badge = document.createElement("span");
        badge.className = "watched-badge";
        badge.textContent = "✓";
        badge.title = "Watched";
        poster.appendChild(badge);
    }
    const progressDisplay = getProgressDisplay(progress, watched);
    if (progressDisplay) {
        const track = document.createElement("span");
        track.className = "poster-progress";
        track.title = progressDisplay.label;
        track.setAttribute("role", "progressbar");
        track.setAttribute("aria-valuemin", "0");
        track.setAttribute("aria-valuemax", "100");
        track.setAttribute("aria-valuenow", String(progressDisplay.percent));
        const fill = document.createElement("span");
        fill.style.width = `${progressDisplay.percent}%`;
        track.appendChild(fill);
        poster.appendChild(track);
    }

    const name = document.createElement("span");
    name.className = "media-name";
    name.textContent = title;
    const detail = document.createElement("span");
    detail.className = "media-year";
    detail.textContent = subtitle;
    card.append(poster, name, detail);
    return card;
}

async function openHistoryEntry(entry: WatchHistoryEntry): Promise<void> {
    if (!entry.episode) {
        await loadStreams(entry.media);
        return;
    }
    ui.back.classList.remove("hidden");
    ui.title.textContent = entry.media.name;
    setLoading();
    retryAction = () => openHistoryEntry(entry);
    const request = replaceRequest(activeRequest);
    activeRequest = request;
    try {
        const details = await loadMediaDetails(entry.media, request.signal);
        const episode = details.episodes.find((item) => item.id === entry.episode?.id) || entry.episode;
        await loadStreams(details.media, episode, details.episodes);
    } catch (error) {
        if (!request.signal.aborted) showError(readError(error, "Could not open this episode."));
    }
}

function addonWarning(count: number, subject: string): HTMLElement {
    const warning = document.createElement("div");
    warning.className = "addon-warning";
    warning.textContent = `${count} ${subject}${count === 1 ? "" : "s"} unavailable`;
    return warning;
}

function isWatched(id: string): boolean {
    return watchHistory.some((entry) => entry.id === id && entry.watched);
}

function getEntryProgress(id: string): number | null {
    const entry = watchHistory.find((item) => item.id === id);
    return entry ? getResumePercent(entry.progress, entry.watched) : null;
}

function mediaIdentity(media: Media): string {
    return media.imdbId || media.providerId || media.id;
}

/**
 * Season holding the next episode still to watch, so arriving at a show lands on
 * something actionable instead of the first season of a series already finished.
 */
export function getDefaultSeason(
    episodes: Episode[],
    watched: (episode: Episode) => boolean,
    available: (episode: Episode) => boolean = isEpisodeAvailable
): number {
    const ordered = sortEpisodes(episodes, "oldest");
    const next = ordered.find((episode) => available(episode) && !watched(episode));
    return (next || ordered[0])?.season ?? 0;
}

function renderEpisodes(
    media: Media,
    episodes: Episode[],
    focusOrder?: EpisodeOrder,
    selectedSeason?: number
): void {
    if (episodes.length === 0) {
        renderEmpty("No episodes found.");
        return;
    }
    const seasons = new Map<number, Episode[]>();
    sortEpisodes(episodes, episodeOrder).forEach((episode) => {
        seasons.set(episode.season, [...(seasons.get(episode.season) || []), episode]);
    });
    const numbers = [...seasons.keys()].sort((a, b) => a - b);
    const nextSeason = getDefaultSeason(episodes, (episode) => isWatched(episode.id));
    const active = selectedSeason !== undefined && seasons.has(selectedSeason)
        ? selectedSeason
        : seasons.has(nextSeason) ? nextSeason : numbers[0];

    const fragment = document.createDocumentFragment();
    const nav = document.createElement("div");
    nav.className = "season-nav";
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", "Seasons");
    numbers.forEach((season) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "season-chip";
        chip.textContent = season === 0 ? "Specials" : `S${season}`;
        chip.title = season === 0 ? "Specials" : `Season ${season}`;
        chip.setAttribute("role", "tab");
        chip.setAttribute("aria-selected", String(season === active));
        chip.classList.toggle("active", season === active);
        if (season === nextSeason) chip.dataset.next = "";
        chip.setAttribute("data-clickable", "");
        chip.addEventListener("click", () => {
            if (season === active) return;
            renderEpisodes(media, episodes, undefined, season);
        });
        nav.appendChild(chip);
    });

    const order = episodeOrder === "newest" ? "oldest" : "newest";
    const orderButton = document.createElement("button");
    orderButton.type = "button";
    orderButton.className = "season-order";
    orderButton.id = getEpisodeOrderButtonId(episodeOrder);
    orderButton.textContent = episodeOrder === "newest" ? "NEWEST ↑" : "OLDEST ↓";
    orderButton.title = `Sort ${getEpisodeOrderLabel(order)}`;
    orderButton.setAttribute("data-clickable", "");
    orderButton.addEventListener("click", () => {
        episodeOrder = order;
        iina.postMessage(MESSAGE_NAMES.SetEpisodeOrder, { episodeOrder });
        renderEpisodes(media, episodes, order, active);
    });
    nav.appendChild(orderButton);
    fragment.appendChild(nav);

    const list = document.createElement("div");
    list.className = "episode-list";
    (seasons.get(active) || []).forEach((episode) => {
        list.appendChild(episodeRow(media, episode, episodes));
    });
    fragment.appendChild(list);
    showContent(fragment);
    if (focusOrder) document.getElementById(getEpisodeOrderButtonId(focusOrder))?.focus();
}

function episodeRow(media: Media, episode: Episode, episodes: Episode[]): HTMLButtonElement {
    const available = isEpisodeAvailable(episode);
    const watched = available && isWatched(episode.id);
    const progress = available && !watched ? getEntryProgress(episode.id) : null;
    const resume = getProgressDisplay(progress, watched);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "erow";
    button.disabled = !available;
    button.classList.toggle("erow--watched", watched);
    if (available) {
        button.setAttribute("data-clickable", "");
        button.addEventListener("click", () => void loadStreams(media, episode, episodes));
    }

    const number = document.createElement("span");
    number.className = "erow-num";
    number.textContent = pad(episode.episode);
    const name = document.createElement("span");
    name.className = "erow-name";
    name.textContent = episode.name;
    name.title = episode.name;
    button.append(number, name);

    // Aired dates are noise on episodes already out; only a future date informs anything.
    if (!available) {
        const airs = document.createElement("span");
        airs.className = "erow-airs";
        const date = formatDate(episode.aired);
        airs.textContent = date ? `Airs ${date}` : "Unaired";
        button.appendChild(airs);
    } else if (watched) {
        const mark = document.createElement("span");
        mark.className = "erow-mark";
        mark.textContent = "✓";
        mark.title = "Watched";
        button.appendChild(mark);
    } else {
        button.appendChild(document.createElement("span"));
    }

    if (resume) {
        const track = document.createElement("span");
        track.className = "erow-bar";
        track.title = resume.label;
        track.setAttribute("role", "progressbar");
        track.setAttribute("aria-valuemin", "0");
        track.setAttribute("aria-valuemax", "100");
        track.setAttribute("aria-valuenow", String(resume.percent));
        const fill = document.createElement("span");
        fill.style.width = `${resume.percent}%`;
        track.appendChild(fill);
        button.appendChild(track);
        button.classList.add("erow--resuming");
    }
    return button;
}

function renderStreams(
    media: Media,
    episode: Episode | undefined,
    episodes: Episode[],
    streams: AddonStream[],
    failedAddons: number,
    englishSubtitles: boolean | null,
    preferredQuality?: string,
    recommendNext = false
): void {
    if (streams.length === 0) {
        renderEmpty("No direct HTTP streams. The enabled addons may only return torrent entries.");
        return;
    }
    const content = document.createDocumentFragment();
    if (failedAddons > 0) content.appendChild(addonWarning(failedAddons, "addon"));
    const playStream = (stream: AddonStream) => {
        const resumePercent = getEntryProgress(episode?.id || mediaIdentity(media));
        iina.postMessage(MESSAGE_NAMES.PlayItem, {
            url: stream.url,
            title: episode ? formatEpisodeTitle(media, episode) : media.name,
            playbackContext: {
                media,
                ...(episode ? { episode } : {}),
                episodes,
                resolution: stream.resolution
            },
            ...(resumePercent === null ? {} : { resumePercent })
        });
    };
    const varying = getVaryingStreamFields(streams);
    if (recommendNext) {
        const recommendation = findClosestQualityStream(streams, preferredQuality || "");
        if (recommendation) {
            const button = rowButton(
                "Play Next Episode",
                buildNextEpisodeDetail(recommendation),
                () => playStream(recommendation),
                false,
                false,
                recommendation.rawTitle
            );
            button.classList.add("next-episode");
            content.appendChild(button);
        }
    }
    const seriesPrefix = episode ? buildSeriesPrefixPattern(media, episode) : null;

    let sizeOrder: SizeOrder = "largest";
    const summary = document.createElement("div");
    summary.className = "stream-summary";
    const summaryText = document.createElement("span");
    const sortButton = document.createElement("button");
    sortButton.type = "button";
    sortButton.className = "stream-sort-toggle";
    sortButton.title = "Toggle file-size sorting";
    sortButton.setAttribute("data-clickable", "");
    summary.append(summaryText, sortButton);

    const list = document.createElement("div");
    const renderList = () => {
        sortButton.textContent = getSizeSortControl(sizeOrder).label;
        summaryText.textContent = buildStreamSummary(streams, varying, englishSubtitles);
        list.replaceChildren(...buildStreamTiers(
            streams,
            sizeOrder,
            varying,
            seriesPrefix,
            playStream
        ));
    };
    sortButton.addEventListener("click", () => {
        sizeOrder = getSizeSortControl(sizeOrder).next;
        renderList();
    });
    renderList();
    content.append(summary, list);
    showContent(content);
}

/** The next-episode row stands alone, so it states everything rather than hoisting. */
export function buildNextEpisodeDetail(
    stream: { resolution: string; source: string; size: string; cached: boolean | null; audioLanguages: string[] }
): string {
    return [
        stream.resolution,
        stream.source,
        stream.audioLanguages.length > 0 ? getAudioBadge(stream.audioLanguages).label : "",
        stream.size,
        stream.cached === true ? "Ready" : stream.cached === false ? "Not cached" : ""
    ].filter(Boolean).join(" · ");
}

/** Which per-stream facts actually differ. Anything identical on every row is chrome. */
export function getVaryingStreamFields(
    streams: Array<{ addonName: string; cached: boolean | null; source: string }>
): { addon: boolean; cache: boolean; source: boolean } {
    const differs = <T>(read: (stream: typeof streams[number]) => T) =>
        new Set(streams.map(read)).size > 1;
    return {
        addon: differs((stream) => stream.addonName),
        cache: differs((stream) => stream.cached),
        source: differs((stream) => stream.source)
    };
}

export function buildStreamSummary(
    streams: Array<{ addonName: string; cached: boolean | null; source: string }>,
    varying: { addon: boolean; cache: boolean; source: boolean },
    englishSubtitles: boolean | null
): string {
    const first = streams[0];
    const parts = [`${streams.length} ${streams.length === 1 ? "stream" : "streams"}`];
    if (!varying.addon && first) parts.push(first.addonName);
    // Unknown must stay distinct from a negative: absent, not silently equal to "no".
    if (englishSubtitles === true) parts.push("EN subs");
    else if (englishSubtitles === false) parts.push("no EN subs");
    if (!varying.source && first?.source) parts.push(first.source);
    if (!varying.cache && first) {
        parts.push(first.cached === null
            ? "cache unknown"
            : first.cached ? "all ready" : "none cached");
    }
    return parts.join(" · ");
}

/**
 * Rows visible before "show more". Follows the ready count so every instantly playable
 * stream stays visible, with a floor for context and a ceiling to avoid a scroll wall.
 */
export function getTierRowCap(readyCount: number): number {
    return Math.min(Math.max(readyCount, 5), 15);
}

/** Season/episode prefix the header already shows, so rows need not repeat it. */
function buildSeriesPrefixPattern(media: Media, episode: Episode): RegExp | null {
    const name = media.name.trim();
    if (!name) return null;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const season = String(episode.season);
    const number = String(episode.episode);
    return new RegExp(
        `^\\s*${escaped}[\\s(]*(?:\\d{4}\\)?)?[\\s\\-–·()]*` +
        `(?:s0?${season}\\s*[.\\s]?e0?${number}|s0?${season}|0?${season}x0?${number}` +
        `|season\\s*0?${season})?[\\s\\-–·]*`,
        "i"
    );
}

function buildStreamTiers(
    streams: AddonStream[],
    sizeOrder: SizeOrder,
    varying: { addon: boolean; cache: boolean; source: boolean },
    seriesPrefix: RegExp | null,
    playStream: (stream: AddonStream) => void
): HTMLElement[] {
    const tiers = groupStreamsByResolution(streams);
    const openTier = getDefaultTier(tiers);
    return tiers.map(({ resolution, streams: tierStreams }) => {
        const ordered = sortStreamsForPlayback(tierStreams, sizeOrder);
        const ready = ordered.filter((stream) => stream.cached === true).length;
        const cap = getTierRowCap(ready);

        const section = document.createElement("details");
        section.className = "tier";
        section.dataset.tier = resolution;
        section.open = resolution === openTier;

        const heading = document.createElement("summary");
        const name = document.createElement("span");
        name.className = "tier-name";
        name.textContent = resolution;
        heading.appendChild(name);
        if (ready > 0) {
            const readyLabel = document.createElement("span");
            readyLabel.className = "tier-ready";
            readyLabel.textContent = `${ready} ready`;
            readyLabel.title = `${ready} ready to play without downloading`;
            heading.appendChild(readyLabel);
        }
        const count = document.createElement("span");
        count.className = "tier-count";
        count.textContent = String(ordered.length);
        heading.appendChild(count);
        section.appendChild(heading);

        const body = document.createElement("div");
        body.className = "tier-body";
        const draw = (limit: number) => {
            body.replaceChildren(...ordered.slice(0, limit).map((stream) => (
                streamRow(stream, varying, seriesPrefix, () => playStream(stream))
            )));
            if (limit < ordered.length) {
                const more = document.createElement("button");
                more.type = "button";
                more.className = "show-more";
                more.textContent = `Show ${ordered.length - limit} more`;
                more.setAttribute("data-clickable", "");
                more.addEventListener("click", () => draw(ordered.length));
                body.appendChild(more);
            }
        };
        draw(cap);
        section.appendChild(body);
        section.addEventListener("toggle", () => {
            if (section.open) lastOpenTier = resolution;
        });
        return section;
    });
}

/**
 * Highest tier holding a ready stream, so the default lands on something playable now.
 * A tier the user opened earlier wins when it still has streams for this episode.
 */
export function getDefaultTier(
    tiers: Array<{ resolution: string; streams: Array<{ cached: boolean | null }> }>,
    remembered: string | null = lastOpenTier
): string {
    if (remembered && tiers.some(({ resolution }) => resolution === remembered)) return remembered;
    const withReady = tiers.find(({ streams }) => streams.some((stream) => stream.cached === true));
    if (withReady) return withReady.resolution;
    return tiers.reduce(
        (best, tier) => tier.streams.length > best.streams.length ? tier : best,
        tiers[0]
    )?.resolution || "";
}

function streamRow(
    stream: AddonStream,
    varying: { addon: boolean; cache: boolean; source: boolean },
    seriesPrefix: RegExp | null,
    action: () => void
): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "srow";
    button.setAttribute("data-clickable", "");
    button.addEventListener("click", action);

    if (varying.cache) {
        const dot = document.createElement("span");
        const state = stream.cached === true ? "ok" : stream.cached === false ? "warn" : "unknown";
        dot.className = `dot dot--${state}`;
        dot.title = getCacheBadge(stream.cached).title;
        button.appendChild(dot);
    } else {
        button.classList.add("srow--nodot");
    }

    const main = document.createElement("span");
    main.className = "srow-main";
    const title = document.createElement("span");
    title.className = "srow-title";
    title.textContent = stripSeriesPrefix(stream.title, seriesPrefix);
    title.title = stream.rawTitle;
    main.appendChild(title);

    const meta = buildRowMeta(stream, varying);
    if (meta) {
        const line = document.createElement("span");
        line.className = "srow-meta";
        line.textContent = meta;
        main.appendChild(line);
    }
    button.appendChild(main);

    const size = document.createElement("span");
    size.className = "srow-size";
    size.textContent = stream.size || "—";
    button.appendChild(size);
    if (stream.cached === false) button.classList.add("srow--uncached");
    return button;
}

export function stripSeriesPrefix(title: string, pattern: RegExp | null): string {
    if (!pattern) return title;
    // Removing the prefix can leave an orphaned separator or bracket behind.
    const stripped = title.replace(pattern, "").replace(/^[-–·(\s]+/, "").trim();
    return stripped || title;
}

/** Second line, rendered only when it carries something the summary line does not. */
export function buildRowMeta(
    stream: { source: string; addonName: string; audioLanguages: string[]; cached: boolean | null; seeders: number | null },
    varying: { addon: boolean; cache: boolean; source: boolean }
): string {
    const parts: string[] = [];
    if (varying.source && stream.source) parts.push(stream.source);
    if (stream.audioLanguages.length > 0) parts.push(getAudioBadge(stream.audioLanguages).label);
    if (varying.addon) parts.push(stream.addonName);
    // Seeders only predict a wait, so they matter only when the stream is not ready.
    if (stream.cached !== true && stream.seeders !== null) parts.push(`${stream.seeders} seeders`);
    return parts.join(" · ");
}

/** Remembered across episodes so a binge does not reset the chosen tier every time. */
let lastOpenTier: string | null = null;

export function getAudioBadge(languages: string[]): { label: string; title: string } {
    if (languages.length === 0) {
        return { label: "Audio ?", title: "Audio language not provided" };
    }
    if (languages.length === 1) {
        const language = languages[0];
        const title = language === "Multi" || language === "Dual Audio"
            ? "Multiple audio languages (not specified)"
            : `Audio: ${language}`;
        return { label: language, title };
    }
    return {
        label: `Multi (${languages.length})`,
        title: `Audio: ${languages.map((language) => (
            language === "Other" ? "other languages" : language
        )).join(", ")}`
    };
}

export function getCacheBadge(cached: boolean | null): {
    label: string;
    title: string;
    state: "cached" | "uncached" | "unknown";
} {
    if (cached === true) {
        return { label: "Cached", title: "Ready to play from debrid cache", state: "cached" };
    }
    if (cached === false) {
        return { label: "Uncached", title: "Not currently available in debrid cache", state: "uncached" };
    }
    return { label: "Cache ?", title: "Cache status not provided", state: "unknown" };
}


function rowButton(
    title: string,
    subtitle: string | Node,
    action: () => void,
    disabled = false,
    watched = false,
    titleTooltip = ""
): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "row";
    button.disabled = disabled;
    if (!disabled) button.setAttribute("data-clickable", "");
    const body = document.createElement("span");
    body.className = "row-body";
    const heading = document.createElement("span");
    heading.className = "row-title";
    heading.textContent = title;
    if (titleTooltip) heading.title = titleTooltip;
    const detail = document.createElement("span");
    detail.className = "row-detail";
    if (typeof subtitle === "string") {
        detail.textContent = subtitle;
    } else {
        detail.appendChild(subtitle);
    }
    const play = document.createElement("span");
    play.className = `row-play${watched ? " row-play--watched" : ""}`;
    play.textContent = watched ? "✓" : disabled ? "" : "▶";
    if (watched) play.title = "Watched";
    body.append(heading, detail);
    button.append(body, play);
    if (!disabled) button.addEventListener("click", action);
    return button;
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal });
    if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}.`);
    return await response.json() as unknown;
}

/**
 * The skeleton has to predict the shape it resolves into, or the page lurches on arrival.
 * Only the home view returns posters; every other view resolves into the summary/tier/row stack.
 */
function setLoading(shape: SkeletonShape = "rows", leadCard = false): void {
    ui.loading.className = `loading loading--${shape}`;
    ui.loading.replaceChildren(...buildSkeleton(shape, leadCard));
    ui.content.classList.add("hidden");
    ui.error.classList.add("hidden");
}

/** Text runs per band, so a placeholder reads as text rather than as a solid slab. */
const SKELETON_RUNS: Record<string, number> = {
    "sk-tile": 0,
    "sk-lead": 2,
    "sk-summary": 2,
    "sk-tier": 2,
    "sk-row": 3,
    "sk-chips": 4,
    "sk-erow": 2
};

type SkeletonShape = "grid" | "rows" | "episodes";

/**
 * The band stack the skeleton stands in for. Heights live in the stylesheet and are matched to
 * the real elements, so this order is what keeps content from moving when the fetch resolves.
 * The lead card is reserved only when a next-episode recommendation was requested; it can still
 * turn out to have no matching stream, in which case the list settles up by that one band.
 */
export function getSkeletonCells(shape: SkeletonShape, leadCard = false): string[] {
    if (shape === "grid") return Array.from({ length: 6 }, () => "sk-tile");
    if (shape === "episodes") {
        return ["sk-chips", ...Array.from({ length: 8 }, () => "sk-erow")];
    }
    return [
        ...(leadCard ? ["sk-lead"] : []),
        "sk-summary",
        "sk-tier",
        ...Array.from({ length: 6 }, () => "sk-row")
    ];
}

function buildSkeleton(shape: SkeletonShape, leadCard: boolean): HTMLElement[] {
    return getSkeletonCells(shape, leadCard).map((className) => {
        const node = document.createElement("div");
        node.className = className;
        for (let index = 0; index < (SKELETON_RUNS[className] || 0); index += 1) {
            node.appendChild(document.createElement("span"));
        }
        return node;
    });
}

function showContent(content: Node): void {
    ui.loading.classList.add("hidden");
    ui.error.classList.add("hidden");
    ui.content.classList.remove("hidden");
    ui.content.replaceChildren(content);
}

function renderEmpty(message: string): void {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = message;
    showContent(empty);
}

function showError(message: string): void {
    ui.loading.classList.add("hidden");
    ui.content.classList.add("hidden");
    ui.error.classList.remove("hidden");
    ui.errorMessage.textContent = message;
}

function readError(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

function formatEpisodeTitle(media: Media, episode: Episode): string {
    return `${media.name} · S${pad(episode.season)}E${pad(episode.episode)} · ${episode.name}`;
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

function formatDate(value: string): string {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleDateString() : "";
}
