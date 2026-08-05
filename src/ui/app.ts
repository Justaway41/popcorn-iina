import type { ConfigurationPayload, HistoryPayload, ShowNextEpisodePayload } from "../shared/messages";
import type { AddonManifest, AddonStream, StremioAddon } from "../shared/addons";
import type { WatchHistoryEntry } from "../shared/history";
import type { Episode, EpisodeOrder, Media, MediaType, QualityOrder } from "../shared/stremio";

import { loadAddonStreams, parseAddonManifest, parseAddons } from "../shared/addons";
import { getResumePercent, parseWatchHistory } from "../shared/history";
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
    isEpisodeAvailable,
    parseEnglishSubtitleAvailability,
    parseEpisodeOrder,
    parseMediaResponse,
    parseMediaMetadata,
    parseMediaTypePreference,
    parsePlayableStreams,
    sortEpisodes,
    sortStreamsByQuality,
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
    searchForm: HTMLFormElement;
    searchInput: HTMLInputElement;
    title: HTMLHeadingElement;
    tv: HTMLButtonElement;
}

let ui: Elements;
let mediaType: MediaType = "movie";
let episodeOrder: EpisodeOrder = "oldest";
let addons: StremioAddon[] = [];
let watchHistory: WatchHistoryEntry[] = [];
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

export function getQualitySortControl(
    order: QualityOrder
): { label: string; next: QualityOrder } {
    return order === "highest"
        ? { label: "Highest First", next: "lowest" }
        : { label: "Lowest First", next: "highest" };
}

export function getOpenSeasonNumbers(
    sections: ArrayLike<{ open: boolean; dataset: { season?: string } }>
): Set<number> {
    const openSeasons = new Set<number>();
    Array.from(sections).forEach((section) => {
        const season = Number(section.dataset.season);
        if (section.open && Number.isFinite(season)) openSeasons.add(season);
    });
    return openSeasons;
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
        void loadStreams(payload.media, payload.episode, payload.episodes);
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
            searchForm: element("search-form"),
            searchInput: element("search-input"),
            title: element("section-title"),
            tv: element("tv-btn")
        };

        ui.searchForm.addEventListener("submit", (event) => {
            event.preventDefault();
            void loadHome(ui.searchInput.value.trim());
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
    mediaType = parseMediaTypePreference(payload?.mediaType);
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
    ui.searchInput.value = "";
    updateTypeButtons();
    iina.postMessage(MESSAGE_NAMES.SetMediaType, { mediaType });
    void loadHome("");
}

function updateTypeButtons(): void {
    ui.movies.classList.toggle("active", mediaType === "movie");
    ui.tv.classList.toggle("active", mediaType === "series");
}

async function loadHome(query: string): Promise<void> {
    const request = replaceRequest(activeRequest);
    activeRequest = request;
    homeQuery = query;
    view = { kind: "home", query };
    ui.searchInput.value = query;
    ui.back.classList.add("hidden");
    ui.title.textContent = query ? "Search Results" : watchHistory.length > 0 ? "Browse" : "Trending";
    setLoading();
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

async function loadEpisodes(media: Media): Promise<void> {
    const request = replaceRequest(activeRequest);
    activeRequest = request;
    view = { kind: "episodes", media };
    ui.back.classList.remove("hidden");
    ui.title.textContent = media.name;
    setLoading();
    retryAction = () => loadEpisodes(media);

    try {
        const details = await loadMediaDetails(media, request.signal);
        if (!details.metadataAvailable) {
            renderEmpty("Episode metadata unavailable.");
            return;
        }
        renderEpisodes(details.media, details.episodes);
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

async function loadStreams(media: Media, episode?: Episode, episodes: Episode[] = []): Promise<void> {
    const request = replaceRequest(activeRequest);
    activeRequest = request;
    view = { kind: "streams", media, episode, episodes };
    ui.back.classList.remove("hidden");
    ui.title.textContent = episode ? formatEpisodeTitle(media, episode) : media.name;
    setLoading();
    retryAction = () => loadStreams(media, episode, episodes);

    try {
        await refreshConfiguration();
        if (request.signal.aborted) return;
        const enabledAddons = addons.filter((addon) => addon.enabled);
        const manifests = await Promise.allSettled(enabledAddons.map(async (addon) => ({
            addon,
            manifest: await loadAddonManifest(addon, request.signal)
        })));
        const streamAddons = manifests.flatMap((result) => (
            result.status === "fulfilled" && result.value.manifest.resources.includes("stream")
                ? [result.value.addon]
                : []
        ));
        const manifestFailures = manifests.filter((result) => result.status === "rejected").length;
        if (streamAddons.length === 0) {
            throw new Error("Enable a Stremio addon in IINA Settings → Plugins → Popcorn for IINA.");
        }
        const videoId = episode?.id || media.imdbId || media.providerId || media.id;
        const [result, englishSubtitles] = await Promise.all([
            loadAddonStreams(streamAddons, async (addon) => (
                parsePlayableStreams(await fetchJson(
                    buildStremioStreamUrl(addon.manifestUrl, media.type, videoId),
                    request.signal
                ))
            )),
            isCompatibleSubtitleId(videoId)
                ? fetchJson(buildOpenSubtitlesUrl(media.type, videoId), request.signal)
                    .then(parseEnglishSubtitleAvailability)
                    .catch(() => null)
                : Promise.resolve(null)
        ]);
        if (request.signal.aborted) return;
        if (result.successfulAddons === 0) {
            throw new Error("Could not load streams from any enabled addon.");
        }
        renderStreams(
            media,
            episode,
            episodes,
            result.streams,
            result.failedAddons + manifestFailures,
            englishSubtitles
        );
    } catch (error) {
        if (!request.signal.aborted) showError(readError(error, "Could not load streams."));
    }
}

async function goBack(): Promise<void> {
    if (view.kind === "episodes") {
        await loadHome(homeQuery);
    } else if (view.kind === "streams" && view.episode) {
        await loadEpisodes(view.media);
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
        fragment.appendChild(historySection(watchHistory.slice(0, 6), true));
        fragment.appendChild(contentHeading("Trending"));
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
    showContent(historySection(watchHistory, false));
}

function historySection(entries: WatchHistoryEntry[], showAll: boolean): HTMLElement {
    const section = document.createElement("section");
    section.className = "history-section";
    if (showAll) section.appendChild(contentHeading("Recently Watched", renderHistory));
    section.appendChild(mediaGrid(entries.map((entry) => mediaCard(
        entry.media,
        entry.media.name,
        entry.episode
            ? `S${pad(entry.episode.season)}E${pad(entry.episode.episode)} · ${entry.episode.name}`
            : entry.media.releaseInfo,
        () => void openHistoryEntry(entry),
        entry.watched,
        entry.progress
    ))));
    return section;
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

function mediaGrid(cards: HTMLButtonElement[]): HTMLElement {
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

function renderEpisodes(
    media: Media,
    episodes: Episode[],
    focusOrder?: EpisodeOrder,
    openSeasons: ReadonlySet<number> = new Set()
): void {
    if (episodes.length === 0) {
        renderEmpty("No episodes found.");
        return;
    }
    const fragment = document.createDocumentFragment();
    const orderControl = document.createElement("div");
    orderControl.className = "episode-order";
    ["oldest", "newest"].forEach((order) => {
        const value = order as EpisodeOrder;
        const button = document.createElement("button");
        button.type = "button";
        button.id = getEpisodeOrderButtonId(value);
        button.textContent = getEpisodeOrderLabel(value);
        button.classList.toggle("active", episodeOrder === value);
        button.setAttribute("aria-pressed", String(episodeOrder === value));
        button.addEventListener("click", () => {
            if (episodeOrder === value) return;
            const expanded = getOpenSeasonNumbers(
                ui.content.querySelectorAll<HTMLDetailsElement>("details.season")
            );
            episodeOrder = value;
            iina.postMessage(MESSAGE_NAMES.SetEpisodeOrder, { episodeOrder });
            renderEpisodes(media, episodes, value, expanded);
        });
        orderControl.appendChild(button);
    });
    fragment.appendChild(orderControl);
    const seasons = new Map<number, Episode[]>();
    sortEpisodes(episodes, episodeOrder).forEach((episode) => {
        const values = seasons.get(episode.season) || [];
        values.push(episode);
        seasons.set(episode.season, values);
    });

    seasons.forEach((values, season) => {
        const section = document.createElement("details");
        section.className = "season";
        section.dataset.season = String(season);
        section.open = openSeasons.has(season);
        const heading = document.createElement("summary");
        const seasonName = document.createElement("span");
        seasonName.textContent = `Season ${season}`;
        const count = document.createElement("span");
        count.className = "season-count";
        count.textContent = `${values.length} ${values.length === 1 ? "episode" : "episodes"}`;
        heading.append(seasonName, count);
        section.appendChild(heading);
        const list = document.createElement("div");
        list.className = "row-list";
        values.forEach((episode) => {
            const available = isEpisodeAvailable(episode);
            list.appendChild(rowButton(
                `S${pad(episode.season)}E${pad(episode.episode)} · ${episode.name}`,
                available
                    ? formatDate(episode.aired)
                    : `Available ${formatDate(episode.aired)}`,
                () => void loadStreams(media, episode, episodes),
                !available,
                available && isWatched(episode.id)
            ));
        });
        section.appendChild(list);
        fragment.appendChild(section);
    });
    showContent(fragment);
    if (focusOrder) document.getElementById(getEpisodeOrderButtonId(focusOrder))?.focus();
}

function renderStreams(
    media: Media,
    episode: Episode | undefined,
    episodes: Episode[],
    streams: AddonStream[],
    failedAddons: number,
    englishSubtitles: boolean | null
): void {
    if (streams.length === 0) {
        renderEmpty("No direct HTTP streams. The enabled addons may only return torrent entries.");
        return;
    }
    const content = document.createDocumentFragment();
    if (failedAddons > 0) content.appendChild(addonWarning(failedAddons, "addon"));
    let qualityOrder: QualityOrder = "highest";
    const sort = document.createElement("div");
    sort.className = "stream-sort";
    const sortButton = document.createElement("button");
    sortButton.type = "button";
    sortButton.className = "active";
    sortButton.title = "Toggle quality sorting";
    sortButton.setAttribute("data-clickable", "");
    sort.appendChild(sortButton);
    const list = document.createElement("div");
    list.className = "row-list";
    const renderList = () => {
        const control = getQualitySortControl(qualityOrder);
        sortButton.textContent = control.label;
        list.replaceChildren(...sortStreamsByQuality(streams, qualityOrder).map((stream) => (
            rowButton(stream.title, buildStreamDetails(stream, englishSubtitles), () => {
                showStreamLoading();
                const resumePercent = getEntryProgress(episode?.id || media.imdbId);
                iina.postMessage(MESSAGE_NAMES.PlayItem, {
                    url: stream.url,
                    title: episode ? formatEpisodeTitle(media, episode) : media.name,
                    playbackContext: { media, ...(episode ? { episode } : {}), episodes },
                    ...(resumePercent === null ? {} : { resumePercent })
                });
            })
        )));
    };
    sortButton.addEventListener("click", () => {
        qualityOrder = getQualitySortControl(qualityOrder).next;
        renderList();
    });
    renderList();
    content.append(sort, list);
    showContent(content);
}

function showStreamLoading(): void {
    ui.back.classList.remove("hidden");
    ui.title.textContent = "Loading Stream";
    const message = document.createElement("div");
    message.className = "stream-loading";
    const spinner = document.createElement("div");
    spinner.className = "stream-spinner";
    const text = document.createElement("p");
    text.textContent = "Opening stream in IINA...";
    message.append(spinner, text);
    showContent(message);
}

function buildStreamDetails(stream: AddonStream, englishSubtitles: boolean | null): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const addon = document.createElement("span");
    addon.className = "stream-addon";
    addon.textContent = stream.addonName;
    fragment.appendChild(addon);
    if (stream.quality) {
        const quality = document.createElement("span");
        quality.className = `stream-quality ${getQualityClass(stream.quality)}`;
        quality.textContent = stream.quality;
        fragment.appendChild(quality);
    }
    const audioDetails = getAudioBadge(stream.audioLanguages);
    const audio = document.createElement("span");
    audio.className = "stream-meta-badge stream-audio";
    audio.textContent = audioDetails.label;
    audio.title = audioDetails.title;
    fragment.appendChild(audio);

    const subtitleDetails = getSubtitleBadge(stream.subtitleLanguages, englishSubtitles);
    const subtitles = document.createElement("span");
    subtitles.className = `stream-meta-badge stream-subtitles stream-subtitles--${subtitleDetails.state}`;
    subtitles.textContent = subtitleDetails.label;
    subtitles.title = subtitleDetails.title;
    fragment.appendChild(subtitles);
    if (stream.size) {
        const size = document.createElement("span");
        size.className = "stream-size";
        size.textContent = stream.size;
        fragment.appendChild(size);
    }
    return fragment;
}

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

export function getSubtitleBadge(
    streamLanguages: string[] | null,
    externalEnglishAvailable: boolean | null
): { label: string; title: string; state: "yes" | "no" | "unknown" } {
    if (streamLanguages?.includes("English") || externalEnglishAvailable === true) {
        return { label: "EN Subs", title: "English subtitles available", state: "yes" };
    }
    if (streamLanguages !== null || externalEnglishAvailable === false) {
        return { label: "No EN Subs", title: "English subtitles not found", state: "no" };
    }
    return { label: "Subs ?", title: "Subtitle availability unknown", state: "unknown" };
}

function getQualityClass(quality: string): string {
    const normalized = quality.toLowerCase();
    if (normalized === "4k" || normalized === "2160p" || normalized === "1440p") {
        return "stream-quality--uhd";
    }
    if (normalized === "1080p") return "stream-quality--fhd";
    if (normalized === "720p") return "stream-quality--hd";
    if (["576p", "480p", "360p", "240p"].includes(normalized)) return "stream-quality--sd";
    return "stream-quality--other";
}

function rowButton(
    title: string,
    subtitle: string | Node,
    action: () => void,
    disabled = false,
    watched = false
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

function setLoading(): void {
    ui.loading.classList.remove("hidden");
    ui.content.classList.add("hidden");
    ui.error.classList.add("hidden");
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
