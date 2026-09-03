import type { WatchedCour, WatchedShowPatch, WatchHistoryEntry } from "../shared/history";
import type { PlaybackContext } from "../shared/messages";
import type { AnimeCourEpisode } from "../shared/simkl";
import type { Episode } from "../shared/stremio";
import { buildCinemetaSeriesUrl, isImdbId, parseMediaMetadata } from "../shared/stremio";
import { createJsonClient, safeJson } from "./http";
import {
    mapAnimeEpisode,
    mapCourEpisode,
    parseAniListRoot,
    parseAniListSequel,
    parseKitsuMalId,
    seasonEpisodeCounts,
    type AnimeEntry
} from "./intro";
import { formatError, logDebug } from "./utils";

const ANILIST_URL = "https://graphql.anilist.co";
const ANILIST_ROOT_QUERY = "query ($search: String) { Page(perPage: 25) { media(search: $search, " +
    "type: ANIME, sort: SEARCH_MATCH) { id idMal format episodes startDate { year month } " +
    "synonyms title { romaji english } } } }";
const ANILIST_SEQUEL_QUERY = "query ($id: Int) { Media(id: $id) { relations { edges { relationType " +
    "node { id idMal format episodes startDate { year month } } } } } }";
/** Longer runs exist, but past this a chain is more likely a loop in the relation data. */
const MAX_SEQUEL_HOPS = 12;

type SeasonCounts = Array<{ season: number; count: number }>;

export interface AnimeChainClient {
    /**
     * The cour and in-cour episode number for what is playing, which is what both AniSkip and
     * Simkl address. Null for live action and for anime the chain cannot place.
     */
    resolveEpisode(context: PlaybackContext, episode: Episode): Promise<AnimeCourEpisode | null>;
    /**
     * Watched episodes Simkl reported per anime cour, placed back onto the seasons the sidebar
     * draws. Only shows already in the local history are considered: a cour carries no id that
     * leads to the series Popcorn shows, so its chain is the only way to recognise it.
     */
    resolveWatchedCours(
        cours: WatchedCour[],
        history: WatchHistoryEntry[]
    ): Promise<WatchedShowPatch[]>;
}

export function createAnimeChainClient(http: IINA.API.HTTP): AnimeChainClient {
    const json = createJsonClient(http);
    const chains = new Map<string, AnimeEntry[] | null>();
    const kitsuMalIds = new Map<string, string>();
    const seasonCounts = new Map<string, SeasonCounts | null>();

    /**
     * The franchise's cours in airing order, found from the title. One request finds the first
     * cour and one more per sequel, so the chain is cached for the session; a title AniList does
     * not know is cached as null so live action stops asking. A failed request is not cached: a
     * rate limit must not read as "not anime" until restart.
     */
    async function loadChain(name: string): Promise<AnimeEntry[] | null> {
        if (chains.has(name)) return chains.get(name) ?? null;
        const root = parseAniListRoot(
            await json.postJson(ANILIST_URL, {
                query: ANILIST_ROOT_QUERY,
                variables: { search: name }
            }),
            name
        );
        if (!root) {
            chains.set(name, null);
            return null;
        }
        const chain = [root];
        for (let hop = 0; hop < MAX_SEQUEL_HOPS; hop += 1) {
            const next = parseAniListSequel(await json.postJson(ANILIST_URL, {
                query: ANILIST_SEQUEL_QUERY,
                variables: { id: chain[chain.length - 1].anilistId }
            }));
            if (!next || chain.some((entry) => entry.anilistId === next.anilistId)) break;
            chain.push(next);
        }
        chains.set(name, chain);
        return chain;
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
        // A successful answer without a mapping is a real "no MAL id"; a failed request is
        // transient and must not be cached, or AniSkip stays broken until restart.
        if (response.statusCode < 200 || response.statusCode >= 300) return "";
        const malId = parseKitsuMalId(response.data ?? safeJson(response.text));
        kitsuMalIds.set(kitsuId, malId);
        return malId;
    }

    /** How many episodes Cinemeta gives each season, which is what the chain is laid against. */
    async function loadSeasonCounts(imdbId: string, preview: {
        id: string; imdbId: string; type: "series"; name: string; releaseInfo: string; poster: string;
    }): Promise<SeasonCounts | null> {
        const cached = seasonCounts.get(imdbId);
        if (cached !== undefined) return cached;
        const details = parseMediaMetadata(
            await json.getJson(buildCinemetaSeriesUrl(imdbId)),
            { manifestUrl: "" },
            preview
        );
        const counts = seasonEpisodeCounts(details.episodes);
        const value = counts.length > 0 ? counts : null;
        seasonCounts.set(imdbId, value);
        return value;
    }

    return {
        async resolveEpisode(context, episode) {
            const providerId = context.media.providerId || context.media.id || "";
            // A catalogue id that is already per cour numbers its episodes within the cour.
            const known = context.media.malId ||
                (providerId.startsWith("kitsu:") ? await loadKitsuMalId(providerId) : "");
            if (known) return { malId: known, episode: episode.episode };
            const chain = await loadChain(context.media.name);
            if (!chain) return null;
            return mapAnimeEpisode(
                seasonEpisodeCounts(context.episodes),
                chain,
                episode.season,
                episode.episode
            );
        },

        async resolveWatchedCours(cours, history) {
            const byMal = new Map(cours.map((cour) => [cour.malId, cour.episodes]));
            if (byMal.size === 0) return [];
            const patches: WatchedShowPatch[] = [];
            const seen = new Set<string>();
            for (const entry of history) {
                // History runs newest first, so the shows being watched are reached before the
                // chain lookups have to walk the rest of it.
                if (byMal.size === 0) break;
                const media = entry.media;
                if (media.type !== "series" || !isImdbId(media.imdbId)) continue;
                if (seen.has(media.imdbId)) continue;
                seen.add(media.imdbId);
                try {
                    const chain = await loadChain(media.name);
                    // Nothing watched on Simkl belongs to this show, so it costs no more lookups.
                    if (!chain || !chain.some((cour) => byMal.has(cour.malId))) continue;
                    const seasons = await loadSeasonCounts(media.imdbId, {
                        id: media.id,
                        imdbId: media.imdbId,
                        type: "series",
                        name: media.name,
                        releaseInfo: media.releaseInfo,
                        poster: media.poster
                    });
                    if (!seasons) continue;
                    const episodes = new Set<string>();
                    for (const cour of chain) {
                        for (const number of byMal.get(cour.malId) ?? []) {
                            const placed = mapCourEpisode(seasons, chain, cour.malId, number);
                            if (placed) episodes.add(`${placed.season}:${placed.episode}`);
                        }
                        byMal.delete(cour.malId);
                    }
                    if (episodes.size > 0) patches.push({ id: media.imdbId, episodes: [...episodes] });
                } catch (error) {
                    logDebug("Popcorn: Anime cour placement failed:", formatError(error));
                }
            }
            return patches;
        }
    };
}
