import type { Episode, Media } from "./stremio";

export const MESSAGE_NAMES = {
    PlayItem: "playItem",
    RequestConfiguration: "requestConfiguration",
    Configuration: "configuration",
    ShowNextEpisode: "showNextEpisode"
} as const;

export interface EpisodePlaybackContext {
    media: Media;
    episode: Episode;
    episodes: Episode[];
}

export interface PlayItemPayload {
    url: string;
    title: string;
    episodeContext?: EpisodePlaybackContext;
}

export interface ConfigurationPayload {
    addonManifestUrl: string;
}

export interface ShowNextEpisodePayload {
    media: Media;
    episode: Episode;
    episodes: Episode[];
}
