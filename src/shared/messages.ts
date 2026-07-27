import type { Episode, Media, MediaType } from "./stremio";
import type { WatchHistoryEntry } from "./history";
import type { StremioAddon } from "./addons";

export const MESSAGE_NAMES = {
    PlayItem: "playItem",
    RequestConfiguration: "requestConfiguration",
    Configuration: "configuration",
    SetMediaType: "setMediaType",
    HistoryUpdated: "historyUpdated",
    ShowNextEpisode: "showNextEpisode"
} as const;

export interface PlaybackContext {
    media: Media;
    episode?: Episode;
    episodes: Episode[];
}

export interface PlayItemPayload {
    url: string;
    title: string;
    playbackContext: PlaybackContext;
}

export interface ConfigurationPayload {
    addons: StremioAddon[];
    mediaType: MediaType;
    history: WatchHistoryEntry[];
}

export interface SetMediaTypePayload {
    mediaType: MediaType;
}

export interface HistoryPayload {
    history: WatchHistoryEntry[];
}

export interface ShowNextEpisodePayload {
    media: Media;
    episode: Episode;
    episodes: Episode[];
}
