import type { Episode, EpisodeOrder, Media, MediaType } from "./stremio";
import type { WatchHistoryEntry } from "./history";
import type { StremioAddon } from "./addons";

export const MESSAGE_NAMES = {
    PlayItem: "playItem",
    RequestConfiguration: "requestConfiguration",
    Configuration: "configuration",
    SetMediaType: "setMediaType",
    SetEpisodeOrder: "setEpisodeOrder",
    HistoryUpdated: "historyUpdated",
    ShowNextEpisode: "showNextEpisode"
} as const;

export interface PlaybackContext {
    media: Media;
    episode?: Episode;
    episodes: Episode[];
    /** Vertical resolution of the stream being played, used to match the next episode. */
    resolution?: string;
}

export interface PlayItemPayload {
    url: string;
    title: string;
    playbackContext: PlaybackContext;
    resumePercent?: number;
}

export interface ConfigurationPayload {
    addons: StremioAddon[];
    mediaType: MediaType;
    episodeOrder: EpisodeOrder;
    history: WatchHistoryEntry[];
}

export interface SetMediaTypePayload {
    mediaType: MediaType;
}

export interface SetEpisodeOrderPayload {
    episodeOrder: EpisodeOrder;
}

export interface HistoryPayload {
    history: WatchHistoryEntry[];
}

export interface ShowNextEpisodePayload {
    media: Media;
    episode: Episode;
    episodes: Episode[];
    resolution?: string;
}
