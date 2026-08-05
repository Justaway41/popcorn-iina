# Merged Catalogs and Playback Controls Design

**Date:** 2026-08-05

## Goal

Expand Popcorn for IINA beyond Cinemeta search while keeping playback explicit and predictable. Search will merge Cinemeta, TMDB, Anime Kitsu, and compatible custom Stremio catalog addons. Playback will add verified intro skipping, a confirmation-only next-episode action that preserves the current quality when possible, file-size stream sorting, and a fix for the sidebar remaining on its loading screen after playback starts.

## Non-goals

- Do not call the TMDB API directly or require a TMDB API token.
- Do not autoplay the next episode.
- Do not guess intro timestamps or automatically skip intros.
- Do not merge multiple providers' popularity rankings on the home screen.
- Do not hide streams whose size, quality, IMDb mapping, or Trakt mapping is unknown.

## Addon capabilities and settings

The existing manifest manager will accept addons that provide at least one supported Stremio resource: `catalog`, `meta`, `stream`, or `subtitles`. Stream-only, catalog-only, and combined addons share the same stored addon shape and enabled toggle. Manifest capabilities are fetched and parsed at runtime rather than persisted, so existing stored preferences require no migration and provider manifest changes take effect on the next session.

The settings page will add one-click presets for:

- TMDB: `https://94c8cb9f702d-tmdb-addon.baby-beamup.club/manifest.json`
- Anime Kitsu: `https://anime-kitsu.strem.fun/manifest.json`

Cinemeta remains an implicit built-in catalog and is not removable. Presets use the same duplicate URL validation as custom manifests and show an `Added` state when already present. Addon rows show compact capability badges for Catalog, Metadata, Streams, and Subtitles. Private and custom manifest URLs retain the current blur, reveal, and refocus behavior.

An addon that provides no supported resources is rejected with a capability-specific message. Catalog-only addons are no longer rejected for lacking streams.

## Catalog discovery and merged search

The home Trending grid remains Cinemeta-only. This avoids mixing unrelated popularity rankings and keeps initial load latency unchanged.

For a submitted search:

1. Fetch Cinemeta results and the manifests for enabled addons concurrently.
2. Select every catalog whose `extra` declaration supports `search` and whose type matches the active Movies or TV mode.
3. Movies query `movie` catalogs. TV queries both `series` and `anime` catalogs.
4. Fetch selected catalog endpoints concurrently with the original query.
5. Parse every response into a shared media preview containing its originating manifest URL, resource type, provider ID, display type, title, year, poster, and optional IMDb ID.
6. Merge results in source order: Cinemeta, then enabled addons in preference order.
7. Deduplicate by valid IMDb ID when available; otherwise use normalized display type, title, and release year. The first result wins so Cinemeta remains the preferred metadata source for duplicates.

Requests use `Promise.allSettled`. One unavailable catalog produces a compact warning but does not discard successful results. Show the normal empty state only when all successful sources return no items. Show an error with retry only when every source fails.

## Metadata, IDs, episodes, and streams

Selecting a result loads its full metadata from the originating addon when it provides `meta`; Cinemeta items continue using Cinemeta directly. Provider metadata is normalized into the existing media and episode models while retaining source information. If an addon lacks `meta`, movies proceed from their catalog preview, while series fall back to Cinemeta only when they have a valid IMDb ID. A series with neither provider metadata nor an IMDb fallback shows `Episode metadata unavailable` instead of an empty episode list.

Media identity must keep these concepts distinct:

- Provider ID and type identify the metadata resource.
- Display type remains `movie` or `series`; `anime` displays as TV.
- A valid IMDb ID is optional and is used for stream compatibility, poster fallback, OpenSubtitles, and Trakt.
- The provider ID remains the stable fallback when no IMDb mapping exists.

For Kitsu episodes, prefer `imdb_id`, `imdbSeason`, and `imdbEpisode` from the episode metadata to build the canonical Stremio series video ID. Otherwise use the provider video ID. TMDB metadata follows the same rule when it exposes an IMDb mapping. Stream requests use the canonical IMDb ID when available and the provider ID otherwise.

OpenSubtitles is queried only for a compatible movie or episode ID. Trakt calls are skipped when no valid IMDb ID exists; local playback and history remain available.

## Stream ordering

Replace the current Highest/Lowest control with Largest File/Smallest File. Ordering uses parsed byte size only:

- Largest File sorts known sizes descending.
- Smallest File sorts known sizes ascending.
- Equal sizes preserve provider response order.
- Streams without a parsed size always follow sized streams in either direction.

Quality badges remain visible but do not affect the stream list order.

## Playback loading state

Selecting a stream will no longer replace the sidebar content with a permanent `Opening stream in IINA...` screen. The existing IINA OSD provides immediate loading feedback while the stream list remains intact. On successful `mpv.file-loaded`, IINA hides the sidebar as it does today. If playback fails or the user reopens the Popcorn tab, the prior stream list is still available for retrying or choosing another stream.

## Next episode

The playback context records the chosen stream quality alongside the current media, episode, and episode list.

After a natural end of file:

1. Find the next released episode using the existing serial episode order.
2. Open the Popcorn sidebar and load the next episode's streams.
3. Rank playable streams against the previous stream's numeric resolution.
4. Show a single primary `Play Next Episode` button for the closest match while keeping the full stream list available below it.
5. Play only when the user clicks the button.

An exact resolution wins. Otherwise the smallest numeric resolution difference wins, with the higher resolution preferred on a tie. Equal-quality streams preserve addon and response order. If the previous quality is unknown, recommend the highest known quality. If no playable stream exists, show the ordinary next-episode stream page without a primary button. There is no countdown or autoplay.

## Skip Intro

Skip Intro is a clickable IINA overlay button shown only while playback is inside a verified intro interval. Clicking it seeks exactly to the interval end and hides the overlay. It never auto-skips.

Intro intervals are resolved in this order:

1. Inspect IINA chapters after `mpv.file-loaded`. Match case-insensitive chapter titles such as `intro`, `opening`, or `op`; use the next chapter start as the intro end.
2. For anime with a known MyAnimeList ID, query AniSkip for the current episode and use its opening interval.
3. If neither source yields a valid interval, do not show the button.

For Kitsu-backed media, query Kitsu's mapping relationship once to resolve a MyAnimeList ID. A missing mapping, unavailable AniSkip response, malformed interval, or chapter without a later boundary is ignored without affecting playback. Intro state is cleared on every file replacement and window close.

## Error handling and privacy

- Catalog, metadata, subtitle, mapping, and AniSkip requests validate HTTP status and response shape at their trust boundaries.
- Partial catalog and stream-addon failures remain visible as non-blocking warnings.
- Provider-specific failures never remove successful results from other providers.
- Manifest URLs remain local preferences and are never logged or displayed unblurred without user action.
- Failed optional IMDb, Trakt, OpenSubtitles, or intro mapping work degrades quietly to local playback.
- Aborted navigation requests do not update the current view.

## Testing and verification

Add focused tests for:

- Manifest capability parsing, catalog-only acceptance, and unsupported-manifest rejection.
- Searchable catalog selection and Stremio catalog/meta URL construction.
- Movies versus TV/anime type mapping.
- Concurrent result merging, source ordering, partial failures, and IMDb/title-year deduplication.
- Cinemeta, TMDB, and Kitsu preview, metadata, episode, and IMDb normalization.
- Trakt and OpenSubtitles guards for non-IMDb provider IDs.
- Byte-size parsing and largest/smallest ordering with stable unknown-size placement.
- Closest-quality next-episode selection, tie-breaking, unknown-quality fallback, and no-autoplay behavior.
- Chapter intro detection, AniSkip interval parsing, invalid interval rejection, and overlay visibility timing.
- The playback-loading regression: selecting a stream preserves the stream list.

Before local handoff, run the full test suite, both TypeScript typechecks, the production build, and a live local-plugin check covering one Cinemeta title, one TMDB-only result, one Kitsu anime, stream size sorting, next-episode confirmation, and Skip Intro when a verified interval exists.
