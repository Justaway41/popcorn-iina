import type { ConfigurationPayload, ShowNextEpisodePayload } from "../shared/messages";
import type { Episode, Media, MediaType, PlayableStream } from "../shared/stremio";

import { MESSAGE_NAMES } from "../shared/messages";
import { CLIENT_VERSION } from "../shared/version";
import {
    buildCinemetaSearchUrl,
    buildCinemetaSeriesUrl,
    buildCinemetaTrendingUrl,
    buildStremioStreamUrl,
    normalizeAddonManifestUrl,
    parseMediaResponse,
    parsePlayableStreams,
    parseSeriesEpisodes
} from "../shared/stremio";

type View =
    | { kind: "home"; query: string }
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
let addonManifestUrl = "";
let view: View = { kind: "home", query: "" };
let retryAction: (() => Promise<void>) | null = null;
let pendingConfigurationResolvers: Array<() => void> = [];

export function initApp(): void {
    iina.onMessage(MESSAGE_NAMES.Configuration, (data) => {
        applyConfiguration(data);
        const resolvers = pendingConfigurationResolvers;
        pendingConfigurationResolvers = [];
        resolvers.forEach((resolve) => resolve());
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

        void refreshConfiguration();
        updateTypeButtons();
        void loadHome("");
    });
}

function applyConfiguration(data: unknown): void {
    const payload = data as ConfigurationPayload;
    addonManifestUrl = typeof payload?.addonManifestUrl === "string" ? payload.addonManifestUrl : "";
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
    void loadHome("");
}

function updateTypeButtons(): void {
    ui.movies.classList.toggle("active", mediaType === "movie");
    ui.tv.classList.toggle("active", mediaType === "series");
}

async function loadHome(query: string): Promise<void> {
    view = { kind: "home", query };
    ui.back.classList.add("hidden");
    ui.title.textContent = query ? "Search Results" : "Trending";
    setLoading();
    retryAction = () => loadHome(query);

    try {
        const url = query
            ? buildCinemetaSearchUrl(mediaType, query)
            : buildCinemetaTrendingUrl(mediaType);
        const items = parseMediaResponse(await fetchJson(url));
        renderMedia(items);
    } catch (error) {
        showError(readError(error, "Could not load Cinemeta."));
    }
}

async function loadEpisodes(media: Media): Promise<void> {
    view = { kind: "episodes", media };
    ui.back.classList.remove("hidden");
    ui.title.textContent = media.name;
    setLoading();
    retryAction = () => loadEpisodes(media);

    try {
        const episodes = parseSeriesEpisodes(await fetchJson(buildCinemetaSeriesUrl(media.imdbId)));
        renderEpisodes(media, episodes);
    } catch (error) {
        showError(readError(error, "Could not load episodes."));
    }
}

async function loadStreams(media: Media, episode?: Episode, episodes: Episode[] = []): Promise<void> {
    view = { kind: "streams", media, episode, episodes };
    ui.back.classList.remove("hidden");
    ui.title.textContent = episode ? formatEpisodeTitle(media, episode) : media.name;
    setLoading();
    retryAction = () => loadStreams(media, episode, episodes);

    try {
        await refreshConfiguration();
        if (!addonManifestUrl.trim()) {
            throw new Error("Add a Stremio addon manifest URL in IINA Settings → Plugins → Popcorn for IINA.");
        }
        const baseUrl = normalizeAddonManifestUrl(addonManifestUrl);
        const videoId = episode?.id || media.imdbId;
        const streams = parsePlayableStreams(await fetchJson(buildStremioStreamUrl(baseUrl, media.type, videoId)));
        renderStreams(media, episode, episodes, streams);
    } catch (error) {
        showError(readError(error, "Could not load streams."));
    }
}

async function goBack(): Promise<void> {
    if (view.kind === "episodes") {
        await loadHome("");
    } else if (view.kind === "streams" && view.episode) {
        await loadEpisodes(view.media);
    } else if (view.kind === "streams") {
        await loadHome("");
    }
}

function renderMedia(items: Media[]): void {
    if (items.length === 0) {
        renderEmpty("No titles found.");
        return;
    }
    const list = document.createElement("div");
    list.className = "media-grid";
    items.forEach((media) => {
        const card = document.createElement("button");
        card.className = "media-card";
        card.type = "button";
        card.setAttribute("data-clickable", "");
        card.addEventListener("click", () => {
            if (media.type === "series") void loadEpisodes(media);
            else void loadStreams(media);
        });

        const poster = document.createElement("div");
        poster.className = "poster";
        if (media.poster) {
            const image = document.createElement("img");
            image.src = media.poster;
            image.alt = "";
            image.loading = "lazy";
            image.addEventListener("error", () => image.remove(), { once: true });
            poster.appendChild(image);
        }

        const name = document.createElement("span");
        name.className = "media-name";
        name.textContent = media.name;
        const year = document.createElement("span");
        year.className = "media-year";
        year.textContent = media.releaseInfo;

        card.append(poster, name, year);
        list.appendChild(card);
    });
    showContent(list);
}

function renderEpisodes(media: Media, episodes: Episode[]): void {
    if (episodes.length === 0) {
        renderEmpty("No episodes found.");
        return;
    }
    const fragment = document.createDocumentFragment();
    const seasons = new Map<number, Episode[]>();
    episodes.forEach((episode) => {
        const values = seasons.get(episode.season) || [];
        values.push(episode);
        seasons.set(episode.season, values);
    });

    [...seasons.entries()].sort(([a], [b]) => a - b).forEach(([season, values]) => {
        const section = document.createElement("section");
        const heading = document.createElement("h3");
        heading.textContent = `Season ${season}`;
        section.appendChild(heading);
        const list = document.createElement("div");
        list.className = "row-list";
        values.sort((a, b) => a.episode - b.episode).forEach((episode) => {
            list.appendChild(rowButton(
                `S${pad(episode.season)}E${pad(episode.episode)} · ${episode.name}`,
                episode.aired ? new Date(episode.aired).toLocaleDateString() : "",
                () => void loadStreams(media, episode, episodes)
            ));
        });
        section.appendChild(list);
        fragment.appendChild(section);
    });
    showContent(fragment);
}

function renderStreams(
    media: Media,
    episode: Episode | undefined,
    episodes: Episode[],
    streams: PlayableStream[]
): void {
    if (streams.length === 0) {
        renderEmpty("No direct HTTP streams. This addon may only return torrent entries.");
        return;
    }
    const list = document.createElement("div");
    list.className = "row-list";
    streams.forEach((stream) => {
        const details = [stream.quality, stream.size].filter(Boolean).join(" · ");
        list.appendChild(rowButton(stream.title, details, () => {
            iina.postMessage(MESSAGE_NAMES.PlayItem, {
                url: stream.url,
                title: episode ? formatEpisodeTitle(media, episode) : media.name,
                episodeContext: episode ? { media, episode, episodes } : undefined
            });
        }));
    });
    showContent(list);
}

function rowButton(title: string, subtitle: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "row";
    button.setAttribute("data-clickable", "");
    const body = document.createElement("span");
    body.className = "row-body";
    const heading = document.createElement("span");
    heading.className = "row-title";
    heading.textContent = title;
    const detail = document.createElement("span");
    detail.className = "row-detail";
    detail.textContent = subtitle;
    const play = document.createElement("span");
    play.className = "row-play";
    play.textContent = "▶";
    body.append(heading, detail);
    button.append(body, play);
    button.addEventListener("click", action);
    return button;
}

async function fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
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
