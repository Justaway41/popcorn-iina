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
    RemoveHistoryEntry: "removeHistoryEntry",
    ShowNextEpisode: "showNextEpisode",
    NowPlaying: "nowPlaying"
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
    /** Release name of the chosen stream, which outlives the URL it was played from. */
    releaseName?: string;
}

/** What the player is playing right now, so a stream list can mark the row it came from. */
export interface NowPlaying {
    /** Episode or movie id, empty when nothing is playing. */
    videoId: string;
    /** Stream URL, matched against the rows of a stream list. */
    url: string;
    /**
     * Release name of the stream being played. A debrid addon mints a fresh URL on every
     * request, so a list reloaded after playback started holds the same file under a different
     * URL; the name is what survives.
     */
    releaseName: string;
}

export interface ConfigurationPayload {
    addons: StremioAddon[];
    mediaType: MediaType;
    episodeOrder: EpisodeOrder;
    history: WatchHistoryEntry[];
    nowPlaying: NowPlaying;
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

export interface RemoveHistoryEntryPayload {
    id: string;
}

export interface ShowNextEpisodePayload {
    media: Media;
    episode: Episode;
    episodes: Episode[];
    resolution?: string;
}
