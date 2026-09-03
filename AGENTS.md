# Popcorn for IINA Agent Handbook

This is the single operational reference for agents working in this repository. Keep it current and compact enough to read at the start of every request.

## Mandatory Startup

Before inspecting or changing code:

1. Read this file completely.
2. Run `git status --short` and preserve every pre-existing change.
3. Use the repository map below to open only the files that own the requested behavior and their colocated tests.
4. Do not rescan the whole repository unless the request is repository-wide or this map is demonstrably stale.
5. Check recent commits only for the files in scope when history is needed.

Before finishing a change:

1. Run the smallest relevant test during development, then the verification appropriate to the risk.
2. Rebuild tracked bundles when source files affect runtime output.
3. Update this handbook if architecture, behavior, commands, ownership, constraints, or known issues changed.
4. Report anything that still requires manual IINA testing.

## Agent Delegation

- Agents may delegate concrete, bounded, independent investigation, implementation, or review
  tasks to subagents without asking the user first when parallel work is useful.
- The primary agent owns scope, integration, verification, and the final response. Avoid overlapping
  edits, and never let delegated work overwrite or stage pre-existing changes.
- Every subagent must read this handbook and run `git status --short`, then use the repository map
  to inspect only its assigned area. It does not need to rescan or reread the entire codebase.
- Do not delegate trivial work when coordination would cost more than doing it directly.

## Project Scope

Popcorn for IINA is an IINA JavaScript plugin (`xyz.brbc.popcorn`, currently version `2.5.0`) for discovering media and playing direct streams supplied by configured Stremio addons.

Supported behavior:

- movie, TV, and anime discovery and search;
- folded season and serial episode browsing;
- multiple enabled Stremio addon manifests;
- direct HTTP(S) stream selection grouped into resolution tiers, cached-first ordering, size sorting;
- cleaned AIOStreams/Comet-style titles with raw titles on hover, with the series/episode prefix
  the header already shows removed from each row;
- constants hoisting: facts identical on every stream move to one summary line, only what varies
  stays on the rows;
- tri-state cache state shown as a dot (ready / will download / not reported) and seeders when
  providers expose them;
- local recent/watch progress plus optional user-supplied Trakt and Simkl credentials, with
  history pulled back from both;
- a Continue Watching strip of what is unfinished, one card per title, each naming the next
  episode that has actually aired;
- skip recap, skip intro, skip outro, and the end-of-file next-episode control;
- a preferred audio and subtitle language (set in preferences) guiding the next-episode
  stream choice;
- IINA sidebar, overlay, menu shortcut (`Shift+P`), window title, and display-sleep prevention.

Out of scope:

- Popcorn is not a content provider, torrent client, debrid service, or proxy.
- Torrent-only Stremio results such as bare `infoHash` entries are ignored. A playable result must contain a direct `http://` or `https://` URL.
- Availability, cache state, seeders, audio, and subtitles can only be shown when provider responses expose usable metadata.

## Repository Map

Open the owner file and its test first. Follow imports only when the actual flow requires it.

| Area | Primary owner | Tests / related files |
| --- | --- | --- |
| Plugin manifest, permissions, defaults, version | `Info.json` | `scripts/verify-root-info.js`, `scripts/verify-built-client-version.js`, `src/shared/version.ts` |
| Global menu, `Shift+P`, managed player creation | `src/plugin/global.ts` | `src/plugin/global.test.ts` |
| Player lifecycle, sidebar messages, playback orchestration | `src/plugin/main.ts` | `src/plugin/playback.ts`, `src/plugin/playback.test.ts` |
| Skip intro/recap/credits intervals, next-episode tail | `src/plugin/intro.ts` | `src/plugin/intro.test.ts`, overlay rendering in `src/plugin/main.ts` |
| Display sleep prevention | `src/plugin/sleep.ts` | `src/plugin/constants.ts` |
| IINA-side Trakt transport and serialization | `src/plugin/trakt.ts` | `src/plugin/trakt.test.ts` |
| IINA preference migration | `src/plugin/preferences.ts` | `src/plugin/preferences.test.ts` |
| Shared Stremio URLs, metadata, episodes, streams, sorting | `src/shared/stremio.ts` | `src/shared/stremio.test.ts` |
| Which stream to play and which to show: ranking and show filtering | `src/shared/stream-choice.ts` | `src/shared/stream-choice.test.ts` |
| Multiple addon parsing, manifests, merged stream loading | `src/shared/addons.ts` | `src/shared/addons.test.ts` |
| Local watch history and progress | `src/shared/history.ts` | `src/shared/history.test.ts` |
| Trakt state, OAuth device flow, sync, scrobbling | `src/shared/trakt.ts` | `src/shared/trakt.test.ts` |
| Player/sidebar message contracts | `src/shared/messages.ts` | callers in `src/plugin/main.ts` and `src/ui/app.ts` |
| Sidebar discovery, season chips, episodes, stream tiers, recent UI | `src/ui/app.ts` | `src/ui/app.test.ts`, `src/ui/sidebar.ts` |
| Preferences UI for addons and Trakt | `src/ui/preferences.ts` | `src/ui/preferences.test.ts`, `ui/preferences.html` |
| Private addon URL reveal behavior | `src/ui/addon-url-visibility.ts` | `src/ui/preferences.test.ts` |
| Sidebar presentation | `ui/sidebar.css`, `ui/sidebar.html` | `src/ui/app.ts` |
| IINA webview bridge types | `src/ui/iina-webview.d.ts` | IINA runtime behavior |
| Generated plugin bundles | `dist/main.js`, `dist/global.js` | generated from `src/plugin/` |
| Generated webview bundles | `ui/dist/sidebar.js`, `ui/dist/preferences.js` | generated from `src/ui/` and `src/shared/` |
| Build and release automation | `package.json`, `.github/workflows/release.yml` | verification scripts above |
| Historical feature decisions | `docs/plans/`, `docs/superpowers/` | consult only when current code and this handbook are insufficient |

## Runtime Flows

### Startup and sidebar

`src/plugin/global.ts` registers the Plugin menu item and `Shift+P`. It creates one plugin-managed IINA player using the splash asset. `src/plugin/main.ts` loads the sidebar and overlay after `iina.window-loaded`; global/player messages reuse the active player and toggle the sidebar.

### Discovery and series

`src/ui/app.ts` queries Cinemeta and enabled addon catalogs, then uses `src/shared/stremio.ts` and `src/shared/addons.ts` to normalize and merge results. TV/anime metadata is converted into episode rows. One season is shown at a time behind a
horizontal season chip strip, so chrome height is constant no matter how many seasons a show
has. The default season is the one holding the next unwatched episode, marked with a dot on its
chip. Episode ordering is a persisted `oldest`/`newest` preference toggled from the chip row.
Aired dates render only for unaired episodes; watched episodes dim and carry a check, and a
partially watched episode carries a resume bar.

### Streams

The sidebar requests stream resources from every enabled addon that declares stream support.
`parsePlayableStreams` is the normalization boundary: keep direct HTTP(S) streams, prefer
structured filename/size/cache/seeder data, use conservative text fallbacks, clean display
titles, and retain `rawTitle`.

`resolution` and `source` are separate fields and must stay that way. Resolution is parsed from
`behaviorHints.filename` first, because a filename is a release name and is immune to the display
labels an addon may substitute for literal tokens; a standard abbreviation (`UHD`/`QHD`/`FHD`/`HD`)
is consulted only when no literal token exists. `4K` is normalized to `2160p` so one tier is not
split across two spellings. A source type such as `WEBRip` must never occupy the resolution slot -
doing so previously made `findClosestQualityStream` discard the stream and silently suppressed the
next-episode row.

Cache state is read from words before emoji, and an explicit negative wins. Decorative glyphs
appear in addon labels and must never be able to invert a stated cache status.

The list is grouped into resolution tiers with a per-tier ready count. Within a tier, cache state
is the primary sort key and the size toggle is secondary, because availability, not file size,
decides whether playback starts now. Each tier reveals as many rows as it has ready streams,
bounded to 5-15.

Stream loading is latency-shaped around its slowest optional part:

- **Subtitles never gate the list.** The OpenSubtitles lookup runs beside the addon fetches, and
  `renderStreams` paints immediately with an unknown-subtitle summary; when the answer lands it
  patches the badge only if the summary node is still connected (a replaced view ends the update,
  so no revision bookkeeping is needed).
- **Progressive results.** `loadAddonStreams` takes an `AddonStreamLoadOptions.onProgress` and
  calls it with the merged result each time an addon settles, so whatever has answered paints
  while the rest are still in flight. It rebuilds the list in addon order on every tick instead
  of appending, or a late addon would reshuffle rows the user is already reading. `loadStreams`
  skips an empty tick, so a first addon that fails cannot flash the empty state over a list that
  is still arriving. Because a repaint replaces the content node, `streamSizeOrder` lives at
  module scope (reset when a stream list opens) and `renderStreams` restores scroll position, so
  a newly arrived addon neither undoes the user's sort nor throws them back to the top.
- **Per-addon pipeline and timeouts.** `loadEnabledAddonStreams` runs each addon's manifest and
  stream call as one chain rather than as two global phases, so the slowest manifest cannot delay
  a faster addon's stream request. A `null` answer from the loader means "nothing to contribute,
  not a failure", which is how an addon without stream support stays out of both counts. Each
  addon races `STREAM_ADDON_TIMEOUT_MS` (45s) with its manifest capped at
  `STREAM_MANIFEST_TIMEOUT_MS` (10s). The stream budget is deliberately generous: results paint as
  they land, so it marks a host as *hung*, not merely slow. It was 15s, which cut off aggregating
  addons mid-answer on a single episode and turned "slow" into "no streams at all" behind a Retry
  that repeated the same failure. A timed-out addon counts as failed like any other rejection, and
  zero successful addons produces an error that distinguishes "nothing enabled" from "none
  answered".
- **Short-TTL session cache.** Successful per-title results are cached for 60s
  (`STREAM_CACHE_TTL_MS`) keyed on `type:videoId`, capped at 20 entries with oldest-first
  eviction (`createStreamCache`). Total failures stay uncached so Retry retries, and
  `applyConfiguration` clears the cache whenever the addon set actually changes.

Subtitle availability combines embedded stream metadata with OpenSubtitles results when an
IMDb-compatible video ID exists. Unknown metadata must remain visibly unknown rather than being
guessed: a cached stream shows a filled dot, an uncached one a hollow ring, and an unreported one
no dot at all.

### Playback and next episode

`src/ui/app.ts` posts a `PlayItem` message. `src/plugin/main.ts` validates the URL, replaces playback through mpv, applies the media title, restores progress, records local history, and scrobbles when Trakt is connected. mpv events drive progress, watched thresholds, intro/credit controls, EOF handling, and next-episode presentation. The prefetched next stream is chosen by `pickNextEpisodeStream`: cached-first (a stream that can start now outranks a better one that cannot), then the user's preferred audio and subtitle languages (`preferredAudio`/`preferredSubtitle` preferences, unknown language states neutral, never negative), then closest resolution to the current stream with higher quality winning ties. The prefetch is only played within `PREFETCH_FRESH_MS` (30 min) of its fetch, because debrid links expire - an older prefetch is dropped and the sidebar's fresh stream list for the next episode takes over instead.

### Skip segments and next episode

`src/plugin/intro.ts` owns the interval logic; `resolvePlaybackIntervals` in `src/plugin/main.ts`
consults sources in order of trustworthiness, each filling only what the previous one left missing:

1. **mpv chapters** named `intro`/`opening`/`op` and `ending`/`credits`/`outro`/`ed` — from the file
   itself, so always preferred and never needs a network call.
2. **AniSkip** — anime only, via a Kitsu→MAL mapping.
3. **IntroDB** (`https://api.introdb.app/segments?imdb_id=&season=&episode=`) — covers live action.
   No API key. Keyed on the **series** IMDb id plus season and episode, all of which
   `PlaybackContext` already carries. It answers **200 with null segments** when it holds nothing,
   so an empty answer is normal and must never be treated as an error.
4. **Tail fallback** — when no source supplied a credits interval, Next Episode appears in the last
   `NEXT_EPISODE_TAIL_SEC` seconds. It never widens a known credits interval, and is suppressed
   below `MIN_TAIL_DURATION_SEC` so short clips do not become one long tail.

Measured IntroDB coverage over 36 episodes of 12 popular shows: intro 92%, outro 97%, **recap 14%**.
Skip Recap is wired end to end, but the database rarely holds recap entries, so it seldom appears.

`sanitizeSegments` in `src/plugin/intro.ts` is the boundary for bad interval data, whatever
supplied it: nothing may end past the file duration, and an intro or recap must also be shorter
than `MAX_SKIP_SEGMENT_SEC` and end before the closing `NEXT_EPISODE_TAIL_SEC`. A rip chaptered
only `Intro` then `Credits` otherwise yields an interval spanning the whole episode, and skipping
it lands on the end of the file - which reads as the episode simply ending. Credits legitimately
run to the end and keep the duration rule alone. Overlay precedence is recap → intro → next,
since a recap runs before the intro.

Interval resolution and next-episode prefetch are gated on `activePlaybackContext`: a file this
plugin did not start belongs to whatever opened it, and the overlay must not appear over another
plugin's playback.

Pressing Next Episode from the overlay posts `ShowNextEpisode` before `playItem`, so the sidebar
follows the player. Only end-of-file did that before, and skipping ahead left the stream list on
the episode that had just finished.

The overlay uses **simple mode** (`overlay.simpleMode()` + `setStyle` + `setContent`), not
`overlay.loadFile`. Loading a page is asynchronous, and clickability set while it is still loading
is silently lost, which breaks every interval starting near zero — a very common intro shape. Simple
mode has no load to race.

**`overlay.onMessage` must be registered after `overlay.simpleMode()`.** Activating a mode clears
the overlay and discards handlers registered beforehand, so a handler registered in
`iina.window-loaded` is wiped by the first `simpleMode()` call: the button renders, reports itself
clickable, posts its message, and nothing is listening. `ensureOverlayInitialized` therefore
activates the mode exactly once and registers the handler immediately after; later updates only
call `setContent`. Do not move `simpleMode()` back into the show path — repeating it would clear
the handler again.

Also keep the click an inline `onclick` in the rendered markup rather than a bound listener, call
`setClickable(true)` **before** `show()`, and seek with `mpv.set("time-pos", …)`; `core.seekTo` and
the mpv `seek` command were both unreliable here. This mirrors the arrangement proven in the sibling
`jellyfin-iina` plugin.

Lookups are gated on the `skipSegments` preference (default **on**; `parseSkipSegments` treats an
absent value as on so existing installs keep the feature). Per the security rules below, failures log
`formatError(error)` only — never the id, URL, or response, which identify what is being watched.

### Watch history removal

Recently Watched cards carry a remove control. Because a card is itself a `<button>`, the control
cannot nest inside it and rides alongside in a `.card-slot` wrapper, positioned opposite the
watched badge. `src/ui/app.ts` drops the one node and posts `RemoveHistoryEntry`; `src/plugin/main.ts`
re-reads the stored history before filtering, persists, and broadcasts `HistoryUpdated`. A card
stands for a title rather than an episode, so `removeHistoryEntry` drops every entry sharing the
removed one's title - otherwise the episode before it takes its place on the next render. Removal is
immediate and has no undo. It is local only: `mergeWatchHistory` unions local and remote entries, so
an entry that still exists on Trakt returns on the next sync. Suppressing that would need a
tombstone list, which does not exist yet.

### Continue Watching

`latestPerTitle` (`src/shared/history.ts`) collapses history to one entry per title, the most
recent, since three episodes of one show are one thing in progress rather than three. The home
strip holds what is unfinished: an episode or film part way through, or a show whose last episode
is done and whose next one is ahead. Finished films wait in See all, which shows the full
collapsed history with watched marks intact.

History carries no episode list, so a card cannot name the next episode by itself. The strip
paints first, then `resolveUpNext` looks the show up and either rewrites the card with the
episode `findNextEpisode` reports - existing and aired - or removes it, because the show has
nothing to watch right now. A failed lookup leaves the card as it was and opens the show instead
of deleting something watchable. Episode lists are cached per session; failures are not cached.
The strip refills to `HOME_HISTORY_CARDS` as cards drop out, so lookups cost one per shown card
plus one per removal rather than one per history entry.

### Preferences, Trakt, and Simkl

`src/ui/preferences.ts` manages addon manifests and Trakt device authorization in IINA's preference webview. Composite preferences are stored as arrays/objects, not JSON strings. `src/plugin/preferences.ts` migrates legacy stringified values. Playback-side Trakt work is serialized in `src/plugin/trakt.ts`; transport failures must never interrupt playback, and local history remains the fallback.

Recent progress and exact watched episodes are separate persisted values. `watchHistory` remains
capped at 100 items for recent cards and resume positions. `episodeWatchState` stores compact
`season:episode` coordinates by show in separate `local` and `simkl` origins; episode rows use their
union plus watched entries still present in legacy history. Local playback adds a coordinate at the
existing 90% watched threshold. Disconnecting or changing Simkl credentials clears only the Simkl
origin.

Simkl history sync keeps `/sync/activities` as its incremental gate and requests
`/sync/all-items/?extended=full_anime_seasons&episode_watched_at=yes&include_all_episodes=yes`,
adding `date_from` after the first successful pull. Each valid IMDb-backed show response replaces
only that show's Simkl coordinates, using `seasons[].number` with `episodes[].number` and only
episodes carrying the requested `watched_at` marker. That numbering is what matches the Cinemeta
coordinates the sidebar renders, for anime as well as shows - do not switch to the `tvdb` mapping
each anime episode also carries, which addresses the whole franchise (Bleach cour one is TVDB
season 17, not season 1). Verified against a live account in September 2026. Playback rows name the
title `anime` for anime and `show` otherwise, and the episode number `number`, so both spellings are
accepted. Missing or malformed episode lists leave stored state untouched, while an explicit empty
list clears the show. The recent-history merge retains every watched entry but only the newest
unfinished episode per title, so the latest pause/close checkpoint wins across devices. No live
playback polling was added. A `HistoryUpdated` message repaints an open episode list from its cached
episodes while retaining its selected season and scroll position.

## Engineering Rules

- Fix shared behavior at its owning normalization or state boundary, not independently in each caller.
- Reuse existing helpers and message contracts. Do not introduce provider-specific layers when `parsePlayableStreams` can normalize the data.
- Treat all network JSON and stored preferences as untrusted input. Parse defensively and preserve explicit `false` and `0` values.
- Keep unknown states distinct from negative states.
- Preserve request cancellation/revision guards in UI search, playback prefetch, and Trakt flows.
- Keep generated bundles consistent with sources. Never hand-edit `dist/` or `ui/dist/`.
- Do not predict which generated bundles should change. Run `bun run build` or `bun run package`, review the diff, and keep every tracked bundle the build regenerates.
- Add or update the smallest colocated regression test for every nontrivial branch, parser, lifecycle fix, or state transition.
- Preserve unrelated dirty files. Never reset, clean, overwrite, or stage them.
- Do not add dependencies when platform APIs, the standard library, or existing code covers the requirement.

## IINA Constraints

- Global and player plugin instances have different APIs and lifecycles. `global.ts` owns menu/player creation; `main.ts` owns player APIs.
- Do not add repeating JavaScript timers (`setInterval`) to plugin runtime entries. IINA 1.4.4 can retain the timer while unloading its weak plugin instance, causing a native crash when the callback calls an IINA API. Prefer IINA/mpv events.
- A short player-side `setTimeout` currently delays sidebar display by 300 ms. Do not expand timer usage without verifying uninstall behavior.
- The preference webview exposes an asynchronous `window.iina.preferences` bridge, not the plugin runtime's full `iina` APIs.
- The sidebar and overlay must be loaded after `iina.window-loaded`.
- Plugin-created players are managed by the global API and are shut down when the plugin unloads.
- The root `Info.json`, entry bundles, preferences page, and declared assets must remain directly installable by IINA.

## Security and Privacy

- Manifest URLs may contain private debrid credentials. Keep paths and query strings blurred by default and never log, expose, or include them in screenshots, fixtures, docs, or errors.
- Validate external links against the Trakt allowlist in `parseTraktExternalLinkRequest`.
- Validate playback URLs as direct HTTP(S) before sending them to mpv.
- Do not print or commit Trakt Client IDs, Client Secrets, access tokens, refresh tokens, private addon URLs, or watch-history data.
- Keep `allowedDomains: ["*"]` changes deliberate: the plugin needs user-configured addon hosts, but every consuming path must validate expected data.
- Do not add bundled providers or features intended to bypass access controls. Users are responsible for accessing content they may legally view.

## Commands and Verification

Setup:

```sh
bun install
```

Fast checks during development:

```sh
bun test path/to/relevant.test.ts
bun run typecheck
```

Full source verification:

```sh
bun test
bun run typecheck
git diff --check
```

Build and package:

```sh
bun run build
bun run package
bun run verify:root-info
bun run verify:built-client-version
unzip -t xyz.brbc.popcorn.iinaplugin.iinaplgz
```

`bun run package` cleans and regenerates `dist/` and `ui/dist/`, then creates `xyz.brbc.popcorn.iinaplugin.iinaplgz`. The archive is a local artifact; the four generated JavaScript bundles are tracked.

Manual IINA checks are required for lifecycle behavior, plugin install/uninstall, `Shift+P`, sidebar visibility, real addon responses, playback, overlay timing, and Trakt browser/device interaction.

## Git and Release Safety

- Never add Cursor Agent, Cursor, Codex, Claude, or any AI identity as author, committer, or co-author.
- Before every commit or push, verify both identities are exactly `Justaway41 <kritarthasapkota999@gmail.com>`:

```sh
git config user.name
git config user.email
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
```

- Stage only files belonging to the current task.
- Do not push, create a release, tag, or publish unless the user explicitly requests it.
- For releases, update `Info.json` version and monotonically increasing `ghVersion`, rebuild tracked bundles, run the full checks, then create the GitHub release. Publishing a release triggers `.github/workflows/release.yml`, which builds and uploads the plugin archive.
- Never install a local and published package with the same `identifier` simultaneously; IINA treats that as a duplicate plugin.

## Current Working State

As of 2026-08-27:

- `2.0.0` is released: the sidebar declutter (resolution tiers, season chip strip, `quality` split
  into `resolution` + `source`) and the uninstall-crash fix.
- `2.1.0` adds skip segments backed by IntroDB with a next-episode tail fallback, watch-history
  removal, and navigation fixes: the season is restored when returning from a stream list, a search
  query survives a Movies/TV switch, and the search field has a clear control. All are described in
  their runtime-flow sections above and verified in IINA.
- `2.2.0` adds Simkl scrobbling beside Trakt. Both targets run from one funnel, `sendScrobble` in
  `src/plugin/main.ts` (renamed from `sendTrakt`, with `traktStopSent` renamed `scrobbleStopSent`),
  and each is enabled only by its own credentials being present. `src/shared/simkl.ts` is far
  smaller than the Trakt module because Simkl's scrobble paths and body are identical to Trakt's —
  so `buildScrobblePayload` is reused — and Simkl needs no client secret and issues long-lived
  tokens, removing the refresh, expiry, and reconnect handling entirely. Authorization is Simkl's
  PIN flow.
- `2.2.1` adds Simkl history sync, which the shipped `2.2.0` client lacked: it only ever posted, so
  anything watched on another device stayed invisible. `syncSimklHistory` mirrors the Trakt sync and
  stores the `/sync/activities` `all` timestamp as a cursor. Simkl suspends client ids that pull the
  full list every time, so `/sync/activities` runs first and later pulls include `date_from`. Exact
  per-episode state is now stored outside the capped recent list as described above.
- `2.3.0` reworks Recently Watched into Continue Watching, hardens skip-segment data against
  intervals that seek out of the episode, keeps the overlay off playback Popcorn did not start, and
  moves the sidebar with the player when Next Episode is used. The skip-intro fix is a guard on the
  data, not a confirmed reproduction: the reported symptom was Skip Intro ending the episode, and an
  over-long chapter interval is the plausible cause. If it recurs, capture the file's chapters.
- `2.3.1` is a correctness release: `historyKey` falls back to `providerId`/`id` so distinct
  provider-only titles no longer collapse on Trakt/Simkl sync; aborted searches and episode loads
  can no longer render stale results over a newer view; the Simkl PIN poll survives transient 5xx
  and network errors like Trakt's poller; the startup sync chain carries a `.catch`; `playItem`
  rolls back state when `loadfile` throws; failed Kitsu→MAL lookups are no longer cached for the
  session; and the Continue Watching strip refills on removal/dropout and removes itself cleanly
  when emptied (title falls back to Browse/Trending).
- `2.4.0` shapes stream loading for latency: the OpenSubtitles lookup no longer gates the list
  (the summary badge patches in when the answer lands, touching only that text node); every
  addon manifest and stream call races a per-addon timeout so one hung host cannot hold the
  list hostage; successful per-title results cache for 60s keyed on `type:videoId` (20 entries,
  oldest-first eviction, cleared whenever the addon set changes, total failures stay uncached);
  and manifests prefetch in the background as soon as configuration arrives, so opening a title
  never waits on a manifest round trip first.
- `2.4.2` makes the stream list paint progressively. This is the fix for "No stream addon
  answered in time" appearing instead of any streams at all. The 2.4.0 timeout was wired as a
  deadline on the whole result - nothing rendered until every addon had answered or been cut off,
  a late answer was discarded rather than shown, and the manifest phase spent the same clock
  before a stream request could even start, so a slow aggregator became a permanent failure
  behind a Retry that repeated it. See the Streams section for the shape it has now. Verified in
  IINA against a real episode.
- `2.4.1` tunes the next-episode path: zero successful addons now distinguishes "nothing enabled"
  from "none answered" (its 15s per-addon timeout is superseded by the entry above); the recommendation card is gone (the overlay's Next Episode button is the way
  forward, and the sidebar still opens the next episode's fresh list at EOF); the prefetch is
  chosen by `pickNextEpisodeStream` (cached-first, then `preferredAudio`/`preferredSubtitle`,
  then closest resolution) and played within 30 min of fetch, with an older prefetch dropping
  to the sidebar list instead of failing in mpv.
- Simkl was chosen over routing through a self-hosted CrossWatch instance after Trakt limited free
  accounts to one connected community app. The CrossWatch design is kept at
  `docs/superpowers/specs/2026-08-12-crosswatch-scrobble-design.md` and its implementation on the
  `feat/crosswatch-scrobble` branch; both are superseded by the Simkl design beside it. Simkl has no
  such limit, so no relay is needed.
- `SetMediaType` and `RequestConfiguration` are independent messages with no ordering guarantee, so
  a configuration reply can still carry the previous media type. `applyConfiguration` holds a local
  switch in `pendingMediaType` until the plugin echoes it back; without that, switching type while a
  search is showing flips straight back, because only the search path refreshes configuration.
- The uninstall symptom was confirmed as an IINA 1.4.4 `SIGTRAP` in `JavascriptAPIPreferences.get(_:)` invoked by the old global polling timer during plugin teardown. IINA also quits when the plugin is uninstalled while its window is open; that window is a plugin-created player instance, so this is expected and is not the crash.
- `.media-card` must keep `display: block` and `width: 100%`. It is a `<button>`, so as soon as it
  stops being the direct grid item (as it does inside `.card-slot`) an intrinsic width takes over
  and the poster image's natural size blows out the grid. Chrome shrink-to-fits and hides this;
  IINA's WebKit does not, so headless checks cannot catch that class of regression.
- Loading skeletons mirror the geometry they resolve into rather than reusing one poster grid;
  `getSkeletonCells` names the bands per view and the heights in `ui/sidebar.css` are matched to
  the real elements, so content does not move when a fetch resolves. Changing a row's box model
  means updating its `sk-*` counterpart.
- The local test archive is `xyz.brbc.popcorn.iinaplugin.iinaplgz`; it is not published.
- Existing untracked historical plan/spec files under `docs/superpowers/` are user-owned. Do not delete, rewrite, or stage them unless explicitly requested.

Remove or revise current-state entries as soon as they are committed, verified, resolved, or superseded.

- `2.5.0` makes a failed Simkl sync visible and recoverable. Three defects compounded: the only
  trigger was `iina.window-loaded`, so a window left open never pulled again and a failure waited
  for the next window; `request` replaced every transport rejection with the fixed string
  `Simkl request failed.`, and both catch blocks in `simklScrobble` and `syncSimklHistory` did the
  same, so no reason ever survived; and preferences reported any failure as
  `Connected · Last scrobble failed` with no last-synced time and no retry. `transportError` now
  keeps the reason and strips URLs (the pin path carries the client id in its query string),
  `SimklState.lastSyncAt` records the last successful pull, preferences gained a Simkl Sync Now
  button, and `syncRemoteHistory` runs on `RequestConfiguration` behind
  `HISTORY_SYNC_INTERVAL_MS`. Sync Now runs on the webview's `fetch`, not `createIinaTransport`:
  if it succeeds where startup sync fails, the fault is in the IINA HTTP transport. The underlying
  cause of the reported failure is still unknown - this change is what makes it reportable.
  `pickNextEpisodeStream` also stops ranking resolution by absolute distance: with 1080p playing
  and only 720p and 2160p on offer, the nearest was the lower one, so a higher-quality stream was
  passed over. It now prefers the resolution already playing and otherwise the highest available.
  `languageRank` treats the `Dual Audio`/`Multi`/`Other` labels as unnamed rather than as a
  mismatch, because scoring them below a stream that reports no language at all buried the pick
  most likely to carry the preferred audio. Cache still outranks language, by request.
  The overlay gained a fourth action, `credits` / Skip Outro. A credits interval used to mean
  Next Episode wherever it fell, so an anime ending song at 19:00 of a 24:00 episode offered to
  leave an episode that still had a scene in it. Credits ending more than `NEXT_EPISODE_TAIL_SEC`
  before the file ends are now an outro to seek past; only credits reaching the end of the file
  mean the episode is over. An interval longer than `MAX_SKIP_SEGMENT_SEC` is bad data and is
  offered as neither. The tail fallback is no longer suppressed by the presence of credits, so an
  episode that plays on past its outro still offers Next Episode at the end.
  The next-episode pick now reads `current-tracks/audio/lang` and `current-tracks/sub/lang` and
  prefers those over the standing preference, which only applies when the file names no language.
  A setting cannot know that one show is watched subbed and another dubbed, so an anime played in
  Japanese was followed by an English dub of the next episode. `und` is discarded rather than
  treated as a preference, since it would rank every stream naming a language as a mismatch.
  The `preferenceDefaults` for `preferredAudio` and `preferredSubtitle` shipped as `English`,
  which is what actually caused the report: nobody had chosen it, but it ranked an English dub
  above a cached Japanese release. They now default to `""` - the "Any language" option the
  preferences page already offered - so language only re-ranks when the viewer asks for it or
  the playing file says what it is. An explicit stored choice is untouched by the change.
  Cache still outranks language, so an uncached stream in the right language can still lose.
  The wrong-episode report turned out to be a wrong *show*: an addon answers one IMDb id with a
  show's spin-offs too, and each of them has an episode with the requested number, so nothing in
  the stream list told them apart. A live query for `tt0988818:1:11` returned 93 streams of which
  28 were parsed as a different show - `Gintama Mr Ginpachis Zany Class`, `Gintama. Porori-hen` -
  and every language setting picked one of those. Two signals now guard the pick, both ahead of
  the older ones. `parseReleaseShowTitle` reads the title the addon parsed from the first line of
  a stream description (`showTitle` on `PlayableStream`) and compares it with the show being
  watched; a title is only trusted when a season, episode, or year marker follows it, because
  description layout is the user's choice of formatter, and an unreadable one leaves every stream
  equal rather than ranking the list as a mismatch. `releaseTokens` then keeps the next episode in
  the release already playing, comparing the words of `current-tracks`' filename with each
  candidate's, numbers dropped so an episode number and a per-file checksum cannot break a match.
  `behaviorHints.bingeGroup` looks like the field for this but is not: AIOStreams fills it with
  quality, codec, and group only, so the spin-off and the main series share one.
  `filterStreamsToShow` applies the same title check to the sidebar list, in `renderStreams` so
  both the progressive repaint and the final render use it. It removes only titles that are this
  show's name with words added or removed - the spin-off shape - never an unrelated string, since
  an addon listing the show as `Attack On Titan` or `L'attacco Dei Giganti` shares no word with
  `Shingeki no Kyojin` yet is the same show; an early version keyed on exact matches and hid 180
  of 284 valid streams. A parenthesised alias is dropped before comparing. Filtering engages only
  when some stream does name the show, so an addon that spells every title differently leaves the
  list whole. Known cost: a season-qualified variant of the right show (`Shingeki No Kyojin I`) is
  treated as narrower and hidden - 6 of 284 in the measured case, all duplicated by kept rows.
  `ConfigurationPayload.nowPlaying` carries the playing episode id and stream URL, so a stream
  list opened for that episode marks the row it came from (`.srow--playing`) and any other
  episode marks nothing. The sidebar asks for configuration before every stream list, which is
  exactly when it needs this, so no separate message or live update is involved. A debrid addon
  mints a fresh URL for the same file on every request, so `isPlayingStream` matches on the
  release name as well as the URL; `PlayItemPayload.releaseName` carries it from the row the
  viewer clicked. Matching on URL alone silently never marked anything.
  The configuration reply alone was not enough either: a viewer starts a stream from a list that
  is already on screen and never reloaded, so the value delivered with it always predated the
  playback it described. A `NowPlaying` message is posted as playback starts, fails, or ends, and
  `applyPlayingMarks` retoggles the class on the rows in place - rebuilding would discard the open
  tier and scroll position for a one-class change. Rows carry `data-release` only, never their
  URL: a stream URL can hold private debrid credentials and must not sit in the DOM.
- Skip Outro no longer waits on `nextReady`. Seeking past an outro happens inside the file and
  needs nothing loaded, but it sat behind the same guard as Next Episode, so an episode whose
  next-episode prefetch had not finished offered neither control.
- AniSkip is reached through AniList, not ani.zip, and is no longer gated on the item looking
  like anime. Two general defects were behind "no Skip Intro" on show after show, found by
  running the lookup chain over a corpus rather than fixing one title at a time:
  - AniSkip keys its timings by cour (one MyAnimeList entry per cour), while Cinemeta numbers a
    show in seasons. ani.zip mapped an IMDb id to a single MAL id - the first cour's - so every
    season past the first asked AniSkip for the first season's episode of that number: wrong
    timings, not missing ones. ani.zip also had no entry at all for many titles (`tt14986406`,
    Bleach TYBW, maps nowhere; its own index points that show's MAL entry at the original
    Bleach). `loadAnimeChain` now searches AniList by title (`parseAniListRoot`, which accepts a
    result only when one of its titles is the name asked for, so live action resolves to
    nothing) and walks `SEQUEL` relations (`parseAniListSequel`) into the franchise's cours in
    airing order; `mapAnimeEpisode` then places a Cinemeta season and episode in that chain by
    consuming episode counts, so Attack on Titan S3E15 becomes *Season 3 Part 2* episode 3.
    Chains are cached per title for the session; a failed request is never cached, because a
    rate limit (AniList allows 90/min) must not read as "not anime" until restart.
  - AniSkip's `episodeLength` parameter filters submissions to within about fifteen seconds of
    the runtime given, and the plugin passed mpv's exact duration. A rip cut differently from
    the submitter's therefore answered 404: a 1443s Bleach file against a 1475s submission had
    an opening on record and showed nothing. The request now passes `episodeLength=0` for every
    submission and `parseAniSkipInterval` picks the nearest runtime, within
    `ANISKIP_LENGTH_TOLERANCE_SEC`.
  Coverage is still bounded by what the databases hold: Bleach TYBW seasons 2-4 answer 404 from
  AniSkip under their correct ids and IntroDB has only season 1, so that show's later seasons
  offer nothing and no client-side change can supply it. The corpus run that verified the chain
  is recorded here; rerun something like it before touching this area again rather than testing
  on one title. Corpus, 2026-09-03, running the plugin's own functions against live services
  (`before` is the 2.5.0 chain: ani.zip's first-cour id and AniSkip filtered on exact runtime):

  | show | ep | before | after | IntroDB |
  | --- | --- | --- | --- | --- |
  | Bleach TYBW | S1E6 | no mal id | 41467 ep 6: op+ed | intro |
  | Bleach TYBW | S3E6 | no mal id | 56784 ep 6: 404 | none |
  | Attack on Titan | S3E15 | op (season 1's) | 38524 ep 3: op+ed | intro+outro |
  | Attack on Titan | S4E20 | op (season 1's) | 48583 ep 4: op+ed | intro+outro |
  | Gintama | S1E11 | 404 | 918 ep 11: op+ed | intro |
  | Jujutsu Kaisen | S2E5 | op+ed (season 1's) | 51009 ep 5: op+ed | intro+outro |
  | Demon Slayer | S2E3 | op+ed (season 1's) | 49926 ep 3: 404 | intro+outro |
  | Frieren | S1E5 | 404 | 52991 ep 5: op+ed | intro+outro |
  | Re:Zero | S2E5 | 404 | 39587 ep 5: 404 | intro+outro |
  | Spy x Family | S1E3 | op+ed | 50265 ep 3: op+ed | intro+outro |
  | My Hero Academia | S3E10 | op+ed (season 1's) | 36456 ep 10: op+ed | intro+outro |
  | Hunter x Hunter | S1E5 | op+ed | 136 ep 5: op+ed | intro+outro |
  | One Piece | S21E40 | op | 21 absolute ep 930: op | - |
  | Breaking Bad, The Office, Game of Thrones, Severance | - | no mal id | not anime | intro+outro |

  Skip Intro from some source: 13 of 14 anime episodes; the one miss is Bleach TYBW season 3,
  which no database holds. Every "before" marked "season 1's" was wrong data that looked right.
- AniSkip and IntroDB run together rather than one after the other. Chained, the anime id lookup
  sat in front of IntroDB, so a slow or unreachable lookup withheld an intro IntroDB already had
  and Skip Intro stopped appearing. Each source applies what it found as it arrives and fills
  only what is still missing, so when both hold the same interval the first to answer wins
  rather than the more trusted one; that ordering no longer matters because neither can block
  the other.
- The overlay's Next Episode transitioned and IINA then died: that session's log ends with no
  `App will terminate`, and IINA stopped logging ~49s before the process went while mpv kept
  decoding, so its main thread froze. The cause is NOT established. A first theory blamed the
  68 GB `Episode 11.mkv` the transition loaded and gated autoplay on file size, then on bitrate;
  both were wrong and were reverted. The user watches that file by choice as the best version in
  the list and it plays normally, so size is not the discriminator, and the seek bursts around
  the transition appear in sessions that exited cleanly too. Do not re-add a size or bitrate
  ceiling on autoplay without evidence: it discards the best quality on offer to chase an
  unproven cause. The one real defect found while investigating is the re-entrancy below.
- `postNowPlaying` is posted from mpv events only. It was called inside `playItem`, which runs
  inside a sidebar or overlay message callback, so it posted into the webview from within a
  webview message handler. Do not move it back. The prefetched next episode carries
  `releaseName` as well: it was set only on the sidebar's own click payload, so an episode the
  overlay started reported no release and its row could never be marked once the debrid link was
  reissued for the reloaded list.
- Chapter names are matched by `INTRO_CHAPTER` and `CREDITS_CHAPTER` rather than an exact list.
  `Ending Song`, `ED1`, and `NCOP` are ordinary in anime releases and were all missed, leaving
  files looking unchaptered. Matching stays anchored so `Endcard` and `Introduction` do not match.
- Multi-cour anime does not reach Simkl at all, and no amount of import work fixes it. Simkl
  indexes each cour as its own show: `search/id?imdb=tt14986406` resolves only to "Bleach: Sennen
  Kessen Hen", a 13-episode record covering cour one, while cours two and three are separate Simkl
  shows reachable by MAL id (53998, 56784). `buildScrobblePayload` addresses shows by IMDb id and
  Cinemeta season, so every `tt14986406` season 2 and 3 scrobble lands on that 13-episode record
  out of range and Simkl silently drops it. A live account watched through Bleach S3E6 locally and
  Simkl held only S1E1-13, which is why a second device offered S2E1 as next. Shows and
  single-cour anime are unaffected and verified correct (Gintama, Attack on Titan, Family Guy).
  Fixing it means addressing anime by MAL id on the way out and mapping MAL plus in-cour episode
  back onto Cinemeta coordinates on the way in, both of which the AniList chain in
  `src/plugin/intro.ts` already computes for skip times. Do not change only the write side: Simkl
  numbers every cour from season 1, so scrobbling by MAL without the inverse map would report
  cour three as season 1 and mark the wrong episodes watched.

## Handbook Maintenance

Update this file in the same change when any of these change:

- feature behavior or supported scope;
- file/module ownership or runtime flow;
- commands, tests, packaging, versioning, or release process;
- IINA lifecycle assumptions or platform constraints;
- security/privacy rules;
- known issues or active work another agent must preserve.

Do not turn this into a chronological changelog. Replace stale facts with current facts. Small refactors or fixes that do not change any item above do not need a handbook edit.

If this handbook conflicts with current code, stop, verify the code path, and update the handbook as part of the task. If it conflicts with an explicit user instruction, follow the user instruction and then update the handbook.
