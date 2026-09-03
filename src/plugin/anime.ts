import type { WatchedCour, WatchedShowPatch, WatchHistoryEntry } from "../shared/history";
import type { PlaybackContext } from "../shared/messages";
import type { AnimeCourEpisode, SimklUploadEpisode } from "../shared/simkl";
import type { Episode, Media } from "../shared/stremio";
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
/** New titles looked up per sync, so a first run cannot burst through AniList's rate limit. */
const MAX_CHAIN_LOOKUPS_PER_PASS = 6;

type SeasonCounts = Array<{ season: number; count: number }>;
type Coordinate = { season: number; episode: number };

export interface PlacedCours {
    patches: WatchedShowPatch[];
    entries: WatchHistoryEntry[];
}

interface SeriesDetails {
    media: Media;
    episodes: Episode[];
    seasons: SeasonCounts;
}

interface ShowCandidate {
    imdbId: string;
    name: string;
    preview: Media;
}

interface ShowPlacement {
    details: SeriesDetails;
    episodes: Set<string>;
    watched?: { at: Coordinate; playedAt: string };
    paused?: { at: Coordinate; playedAt: string; progress: number };
}

function showCandidate(media: Media): ShowCandidate {
    return { imdbId: media.imdbId, name: media.name, preview: media };
}

function courCandidate(cour: WatchedCour): ShowCandidate {
    return {
        imdbId: cour.imdbId,
        name: cour.name,
        preview: {
            id: cour.imdbId,
            imdbId: cour.imdbId,
            type: "series",
            name: cour.name,
            releaseInfo: cour.year,
            poster: ""
        }
    };
}

function isLater(candidate: Coordinate, current: Coordinate | undefined): boolean {
    if (!current) return true;
    return candidate.season !== current.season
        ? candidate.season > current.season
        : candidate.episode > current.episode;
}

function buildEntry(
    details: SeriesDetails,
    at: Coordinate,
    playedAt: string,
    watched: boolean,
    progress: number
): WatchHistoryEntry {
    const id = `${details.media.imdbId}:${at.season}:${at.episode}`;
    const known = details.episodes.find(
        (episode) => episode.season === at.season && episode.episode === at.episode
    );
    return {
        id,
        media: details.media,
        episode: known ?? {
            id,
            name: `Episode ${at.season}x${at.episode}`,
            season: at.season,
            episode: at.episode,
            aired: "",
            description: "",
            thumbnail: ""
        },
        lastPlayedAt: playedAt,
        watched,
        progress
    };
}

export interface AnimeChainClient {
    /**
     * The cour and in-cour episode number for what is playing, which is what both AniSkip and
     * Simkl address. Null for live action and for anime the chain cannot place.
     */
    resolveEpisode(context: PlaybackContext, episode: Episode): Promise<AnimeCourEpisode | null>;
    /**
     * Everything Simkl reported per anime cour, placed back onto the seasons the sidebar draws:
     * the watched marks, and the Continue Watching entry for the furthest episode of each show.
     * A cour carries no id that leads to the series Popcorn shows, so the chain is the only way
     * to recognise it and anything it cannot place is left out rather than guessed at.
     */
    placeWatchedCours(
        cours: WatchedCour[],
        history: WatchHistoryEntry[]
    ): Promise<PlacedCours>;
    /**
     * Locally watched episodes in the numbering Simkl accepts for their show: a cour's MAL id
     * for anime, the IMDb id otherwise. Episodes the chain cannot place are left out.
     */
    uploadEpisodes(
        media: Media,
        coordinates: Coordinate[]
    ): Promise<SimklUploadEpisode[]>;
}

export function createAnimeChainClient(http: IINA.API.HTTP): AnimeChainClient {
    const json = createJsonClient(http);
    const chains = new Map<string, AnimeEntry[] | null>();
    const kitsuMalIds = new Map<string, string>();
    const series = new Map<string, SeriesDetails | null>();
    // Shared by placement and uploads so one sync cannot burst through AniList's rate limit
    // between them. Reset when a pass begins; a title already looked up never spends from it.
    let lookupBudget = MAX_CHAIN_LOOKUPS_PER_PASS;

    async function loadChainWithinBudget(name: string): Promise<AnimeEntry[] | null> {
        if (chains.has(name)) return chains.get(name) ?? null;
        if (lookupBudget <= 0) return null;
        lookupBudget -= 1;
        return loadChain(name);
    }

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

    /**
     * Cinemeta's own view of the series: the seasons the chain is laid against, plus the media
     * and episode records a Continue Watching card is built from.
     */
    async function loadSeries(candidate: ShowCandidate): Promise<SeriesDetails | null> {
        const cached = series.get(candidate.imdbId);
        if (cached !== undefined) return cached;
        const parsed = parseMediaMetadata(
            await json.getJson(buildCinemetaSeriesUrl(candidate.imdbId)),
            { manifestUrl: "" },
            candidate.preview
        );
        const seasons = seasonEpisodeCounts(parsed.episodes);
        const details = seasons.length > 0
            ? { media: parsed.media, episodes: parsed.episodes, seasons }
            : null;
        series.set(candidate.imdbId, details);
        return details;
    }

    /**
     * Which show each cour belongs to. A cour carries no id that leads there on its own: the
     * IMDb id Simkl files a later cour under names the series it continues, so a show already
     * in the local history always wins over it. Candidates are ordered so that nearly every
     * chain lookup is one that matches - the shows a cour names first, then the rest of the
     * history, then the cour's own id for a show never played on this device.
     */
    async function indexCandidates(
        cours: WatchedCour[],
        history: WatchHistoryEntry[]
    ): Promise<Map<string, ShowCandidate>> {
        const named = new Set(cours.map((cour) => cour.imdbId).filter((id) => id));
        const known = history.flatMap((entry) =>
            entry.media.type === "series" ? [showCandidate(entry.media)] : []);
        const candidates = [
            ...known.filter((candidate) => named.has(candidate.imdbId)),
            ...known.filter((candidate) => !named.has(candidate.imdbId)),
            ...cours.flatMap((cour) => cour.imdbId ? [courCandidate(cour)] : [])
        ];

        const wanted = new Set(cours.map((cour) => cour.malId));
        const owners = new Map<string, ShowCandidate>();
        const seen = new Set<string>();
        for (const candidate of candidates) {
            if (wanted.size === 0) break;
            if (!isImdbId(candidate.imdbId) || seen.has(candidate.imdbId)) continue;
            seen.add(candidate.imdbId);
            try {
                const chain = await loadChainWithinBudget(candidate.name);
                if (!chain) continue;
                for (const cour of chain) {
                    if (!wanted.has(cour.malId) || owners.has(cour.malId)) continue;
                    owners.set(cour.malId, candidate);
                    wanted.delete(cour.malId);
                }
            } catch (error) {
                logDebug("Popcorn: Anime chain lookup failed:", formatError(error));
            }
        }
        return owners;
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

        async placeWatchedCours(cours, history) {
            const placed: PlacedCours = { patches: [], entries: [] };
            lookupBudget = MAX_CHAIN_LOOKUPS_PER_PASS;
            if (cours.length === 0) return placed;
            const owners = await indexCandidates(cours, history);
            const shows = new Map<string, ShowPlacement>();
            for (const cour of cours) {
                try {
                    const owner = owners.get(cour.malId);
                    let candidate = owner ?? null;
                    let details = owner ? await loadSeries(owner) : null;
                    let chain = owner && details ? await loadChain(owner.name) : null;
                    // A cour AniList cannot chain, or whose show Cinemeta has never seen because
                    // the season was given its own IMDb entry, still has one honest reading:
                    // when the id leads back to this cour, the cour is the show's first and its
                    // numbering is the show's season one. Anything else is left out rather than
                    // placed on a show it does not belong to.
                    if (!details && cour.ownsImdb && isImdbId(cour.imdbId)) {
                        candidate = courCandidate(cour);
                        details = await loadSeries(candidate) ??
                            { media: candidate.preview, episodes: [], seasons: [] };
                        chain = null;
                    }
                    if (!candidate || !details) continue;
                    const show = shows.get(candidate.imdbId) ?? { details, episodes: new Set<string>() };
                    shows.set(candidate.imdbId, show);
                    const place = (number: number): Coordinate | null => {
                        const at = chain
                            ? mapCourEpisode(details.seasons, chain, cour.malId, number)
                            : null;
                        if (at || chain) return at;
                        const first = details.seasons[0];
                        // With no seasons to check against, the cour's own numbering is all
                        // there is; with seasons, a number past the first is a later one the
                        // chain would have had to place.
                        if (!first) return { season: 1, episode: number };
                        return number <= first.count ? { season: first.season, episode: number } : null;
                    };
                    for (const number of cour.episodes) {
                        const at = place(number);
                        if (!at) continue;
                        show.episodes.add(`${at.season}:${at.episode}`);
                        if (isLater(at, show.watched?.at)) {
                            show.watched = { at, playedAt: cour.lastWatchedAt };
                        }
                    }
                    const session = cour.paused;
                    const pausedAt = session ? place(session.episode) : null;
                    if (session && pausedAt && isLater(pausedAt, show.paused?.at)) {
                        show.paused = { at: pausedAt, playedAt: session.at, progress: session.progress };
                    }
                } catch (error) {
                    logDebug("Popcorn: Anime cour placement failed:", formatError(error));
                }
            }
            for (const [imdbId, show] of shows) {
                if (show.episodes.size > 0) {
                    placed.patches.push({ id: imdbId, episodes: [...show.episodes] });
                }
                if (show.watched) {
                    placed.entries.push(buildEntry(show.details, show.watched.at, show.watched.playedAt, true, 100));
                }
                if (show.paused) {
                    placed.entries.push(
                        buildEntry(show.details, show.paused.at, show.paused.playedAt, false, show.paused.progress)
                    );
                }
            }
            return placed;
        },

        async uploadEpisodes(media, coordinates) {
            if (!isImdbId(media.imdbId) || coordinates.length === 0) return [];
            try {
                // Without a chain the show cannot be confirmed as anime, and sending it under
                // its IMDb id would be the very mistake this module exists to avoid. A title
                // the budget did not reach is left for the next sync instead.
                if (!chains.has(media.name) && lookupBudget <= 0) return [];
                const chain = await loadChainWithinBudget(media.name);
                if (!chain) {
                    return coordinates.map((at) => ({
                        imdbId: media.imdbId,
                        title: media.name,
                        season: at.season,
                        episode: at.episode
                    }));
                }
                const details = await loadSeries(showCandidate(media));
                if (!details) return [];
                return coordinates.flatMap((at) => {
                    const cour = mapAnimeEpisode(details.seasons, chain, at.season, at.episode);
                    // Simkl numbers every cour from one, so a placed episode is always season
                    // one of the show its MAL id names.
                    return cour
                        ? [{ malId: cour.malId, title: media.name, season: 1, episode: cour.episode }]
                        : [];
                });
            } catch (error) {
                logDebug("Popcorn: Anime upload mapping failed:", formatError(error));
                return [];
            }
        }
    };
}
