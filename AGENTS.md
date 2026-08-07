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

## Project Scope

Popcorn for IINA is an IINA JavaScript plugin (`xyz.brbc.popcorn`, currently version `2.0.0`) for discovering media and playing direct streams supplied by configured Stremio addons.

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
- local recent/watch progress plus optional user-supplied Trakt credentials;
- skip intro, end-credit next-episode control, and closest-quality next stream;
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
| Skip intro and credit intervals | `src/plugin/intro.ts` | `src/plugin/intro.test.ts`, `ui/overlay.html` |
| Display sleep prevention | `src/plugin/sleep.ts` | `src/plugin/constants.ts` |
| IINA-side Trakt transport and serialization | `src/plugin/trakt.ts` | `src/plugin/trakt.test.ts` |
| IINA preference migration | `src/plugin/preferences.ts` | `src/plugin/preferences.test.ts` |
| Shared Stremio URLs, metadata, episodes, streams, sorting | `src/shared/stremio.ts` | `src/shared/stremio.test.ts` |
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

Subtitle availability combines embedded stream metadata with OpenSubtitles results when an
IMDb-compatible video ID exists. Unknown metadata must remain visibly unknown rather than being
guessed: a cached stream shows a filled dot, an uncached one a hollow ring, and an unreported one
no dot at all.

### Playback and next episode

`src/ui/app.ts` posts a `PlayItem` message. `src/plugin/main.ts` validates the URL, replaces playback through mpv, applies the media title, restores progress, records local history, and scrobbles when Trakt is connected. mpv events drive progress, watched thresholds, intro/credit controls, EOF handling, and next-episode presentation. The prefetched next stream uses the closest resolution to the current stream, with higher quality winning ties.

### Watch history removal

Recently Watched cards carry a remove control. Because a card is itself a `<button>`, the control
cannot nest inside it and rides alongside in a `.card-slot` wrapper, positioned opposite the
watched badge. `src/ui/app.ts` drops the one node and posts `RemoveHistoryEntry`; `src/plugin/main.ts`
re-reads the stored history before filtering, persists, and broadcasts `HistoryUpdated`. Removal is
immediate and has no undo. It is local only: `mergeWatchHistory` unions local and remote entries, so
an entry that still exists on Trakt returns on the next sync. Suppressing that would need a
tombstone list, which does not exist yet.

### Preferences and Trakt

`src/ui/preferences.ts` manages addon manifests and Trakt device authorization in IINA's preference webview. Composite preferences are stored as arrays/objects, not JSON strings. `src/plugin/preferences.ts` migrates legacy stringified values. Playback-side Trakt work is serialized in `src/plugin/trakt.ts`; transport failures must never interrupt playback, and local history remains the fallback.

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

As of 2026-08-07:

- `main` contains version `2.0.0`, which bundles two changes that were developed separately but
  shipped together because they touch the same files (`src/plugin/main.ts`, `Info.json`, and the
  built bundles):
  - The sidebar declutter, planned in `docs/superpowers/plans/2026-08-06-sidebar-declutter.md` and
    measured against a live AIOStreams response. It splits `quality` into `resolution` + `source`,
    makes cache parsing collision-proof, groups streams into resolution tiers with cached-first
    ordering, replaces the season accordions with a season chip strip, and renames the `quality`
    field on `PlaybackContext` / `ShowNextEpisodePayload` to `resolution`. `getOpenSeasonNumbers`,
    `getSubtitleBadge`, `getQualityClass`, and `buildStreamDetails` were removed with their tests;
    the stream badge CSS they used is gone.
  - The uninstall-crash fix. It removes repeating timers from both plugin runtime entries, moves
    playback monitoring to mpv events, and changes approved Trakt links in Settings to
    copy-to-clipboard because the preference webview has no safe native-open event.
  - Watch-history removal, described under its own runtime-flow section above.
- The uninstall symptom was confirmed as an IINA 1.4.4 `SIGTRAP` in `JavascriptAPIPreferences.get(_:)` invoked by the old global polling timer during plugin teardown.
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
