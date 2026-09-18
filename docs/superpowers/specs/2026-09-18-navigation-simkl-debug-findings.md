# Navigation and Simkl Sync Debugging Findings

**Status:** S1-S7 and N2-N7 fixed with regressions, plus P1-P3 found while verifying on a real store; N1, N8, and S8 still open  
**Baseline:** `main` at `v2.6.9` (`149f596`)  
**Working tree at diagnosis:** clean  
**Existing verification:** 205 tests and both TypeScript configurations passed at diagnosis. The
failures below were coverage gaps, not failures caught by that suite. After the repair the suite
is 221 tests, and each fixed finding carries a regression that fails without its fix.

## What Was Fixed

| Finding | Fix | Regression |
| --- | --- | --- |
| S1 | `syncSimklHistory` reports `remoteHistory` apart from the merged `history`, and `syncRemoteHistory` passes that to the backfill | `reports what Simkl sent apart from the merged history` |
| S2 | `uploadSimklResume` records only positions a request actually delivered and starts the next pass with the rest | `sends every resume position, not only the first batch` |
| S3 | `isNewerCheckpoint` picks a paused session by `paused.at`, coordinates only when neither carries a usable timestamp | `the newest paused checkpoint wins, whichever cour it sits in` |
| S4 | `WatchedCour.ownership` is `owner`/`other`/`unknown`; a failed `/search/id` stays unknown, a legacy stored `true` is re-verified | `a failed ownership lookup leaves the cour unverified`, `an unverified cour is never read as owning the id it is filed under` |
| S5 | the AniList fallback takes its title from Cinemeta, and direct season-one placement needs confirmed ownership of the id being placed into | `a device with no history does not drop a later cour into season one`, `the series metadata names the show when a relation chain carries no title` |
| S6 | a resolved cour addresses Simkl on its own, in scrobbles, uploads, and resume backfill | `scrobbles anime addressed only by its cour`, `anime carrying only a MAL id is uploaded without IMDb metadata` |
| S7 | `hasUnmatchedUploads` keeps `lastUploadKey` unset when Simkl reports `not_found` | `does not retire an upload Simkl could not match` |
| N2 | `uniqueEpisodes` collapses repeated ids and shared coordinates before navigating | `does not offer the current episode again when it is listed twice` |
| N3 | the serial successor is found first and only then checked for availability | `does not step over an episode that has not aired yet` |
| N4 | an unreadable resolution ranks last instead of being discarded | `recommends the resolution being played, then the highest available` |
| N5 | `serialEpisodes` scopes a walk to season zero or to the real seasons, used by navigation and by the default season | `keeps specials out of a normal run and normal episodes out of the specials`, `an unwatched special never becomes what a show is continued with` |
| N6 | the sidebar's episode-list cache carries a ten-minute TTL; no timer was added | none; a cache lifetime has no failure to pin |
| N7 | `resolveUpNextEpisode` resumes a genuine checkpoint, otherwise takes the first available episode the watched set does not hold | `a Continue Watching card resumes an unfinished episode`, `a Continue Watching card offers the first episode the watched set is missing` |

S1's regression covers the boundary that caused it - the merged history is no longer reported as
Simkl's own - rather than counting `/scrobble/pause` requests out of `syncRemoteHistory`, which has
no test harness. N6 changed a cache lifetime and left no assertable failure behind.

## Found While Verifying On A Real Store

Both were reproduced on this machine against live Simkl data, and neither is in the findings
above.

### P1 - Every sync write was silently discarded

**Severity:** critical; it made all of S1-S7 unobservable  
**Owner:** `src/plugin/preferences.ts`

IINA stores a plugin's preferences as a property list, which cannot hold a null. A movie's
history entry carries `episode: null`, so each flush failed with:

```text
Unable to write preferences file: The data couldn't be written because of an error in the
destination for the data.
```

Probe result, written from the plugin at window load:

```text
writeProbeClean      persisted
writeProbeNull       not stored, one write error logged
writeProbeUndefined  not stored, one write error logged
```

Consequences observed on the live store: `lastSyncAt` had not advanced since 2026-09-17T08:03Z
even though the pull itself completed; `animeChains` never persisted, so every pass re-queried
AniList and was answered 429; a stale `lastError` could never be cleared.

**Fix:** `plistSafe` drops nulls, undefined, and non-finite numbers, and every write in both
plugin entries goes through `createPlistSafeStore`. Parsers already read a missing field as
absent. `plistSafe` avoids the `undefined` identifier so the global bundle stays clear of it.

**Regression:** `a preference write drops what a property list cannot hold`.

After the fix, two consecutive launches: zero write errors, `lastSyncAt` advancing on each pass,
`animeChains` persisted (2 to 7 titles), no watched state lost.

### P2 - The AniList fallback ignored the lookup budget

**Severity:** high  
**Owner:** `src/plugin/anime.ts`

`MAX_CHAIN_LOOKUPS_PER_PASS` guards `indexCandidates`, but the fallback that runs when a Simkl
relation chain does not align with the seasons called `loadChain` directly. On a store of
thirteen cours AniList answered 429 for six of them and those cours went unplaced:

```text
Popcorn: Anime cour placement failed: too many requests, status 429 cour 41467
Popcorn: Anime cour placement failed: too many requests, status 429 cour 56784
```

**Fix:** that fallback now uses `loadChainWithinBudget`, so a pass cannot burst through the rate
limit and what it did not reach is left for the next one.

### P3 - `formatError` still read "[object Object]"

`describeRejection` moved to `src/shared/errors.ts` (import-free, so the global entry does not
pull a sync module in) and `formatError` delegates to it. That is what turned the placement
failures above from `[object Object]` into `too many requests, status 429`.

### P4 - A Simkl relation chain claimed the wrong show

**Owner:** `src/plugin/anime.ts`

Simkl roots Bleach's Thousand-Year Blood War cours at anime `1300367`, which carries
`imdb: tt0434665` - the 2004 series they continue. `placeWatchedCours` read that id as the show,
so all four cours were assigned to a title the device has never played, were excluded from the
candidate scan that would have found `tt14986406`, failed `alignsWithSeasons` (a 13-episode cour
against the 2004 season's 20) and placed nothing. Live state held 37 stale marks ending at S3E11
while Simkl had 48 through S4E8.

**Fix:** the Simkl chain is kept for its order only; the show is named from local history, and a
cour whose chain named no known show returns to the normal candidate scan.

**Regression:** `a chain rooted at the series a cour continues does not claim the show`.

### P5 - A paused session Simkl never cleared repainted a finished episode

A playback session left on this Mac on 2026-09-05 was still reported at cour episode 12, 41%.
Placement emitted it as an unfinished entry and `syncRemoteHistory` merged it *after* the watched
marks were applied, so a finished episode kept showing a half progress bar.

**Fix:** placement drops a paused checkpoint whose episode the same pass marks watched, and
`applyWatchedMarks` now runs after the merge so no source can reintroduce a finished episode.

**Regression:** `a paused session for an episode the pass marks watched is not offered as unfinished`.

### P6 - Placement invented shows Cinemeta has never had

When `loadSeries` found nothing, the direct fallback built a show out of the cour itself. That
produced a title with no poster and no episode list - `tt36501927` on the live store - which
reached the sidebar as a blank card that could name nothing to play, and no later sync could take
it back. Placement now leaves such a cour unplaced, and `FULL_PULL_VERSION` 3 rebuilds Simkl marks
from a full pull so marks already placed onto an invented show are dropped. History entries such a
pass wrote are left for the viewer to remove; nothing re-creates them.

**Regression:** `a cour whose show Cinemeta has never heard of is left unplaced`.

### P7 - The window icon

`assets/Popcorn` was a PNG with no extension, so macOS had nothing to derive an icon from and drew
a blank document. The icon used to be painted onto that file by an AppleScript at startup, which
is what crashed IINA on macOS 27 (removed in 2.6.9). The asset is now `assets/Popcorn.png`; the
window title is still forced to "Popcorn" by `setWindowTitle`, so only the icon changes.

## Still Open

- **N1** - Previous Episode needs the UX decision below before anything is built.
- **N5 UX** - the minimal policy is implemented; where Previous appears is still undecided.
- **N8** - EOF event ordering needs an IINA reproduction, not a unit test.
- **S8** - remote unwatch convergence remains a deliberate non-goal; decide it separately.
- The Simkl header contract (`app-name`, `app-version`, `User-Agent`) and the anime cross-mapping
  comparison are untouched follow-ups.

This document is the handoff for agents fixing incorrect next/previous episode behavior and
unreliable Simkl cross-device synchronization. Read `AGENTS.md` first and preserve its lifecycle,
privacy, generated-bundle, and release constraints.

## Product Rules Already Decided

- Pausing or closing playback creates the checkpoint that should win across devices.
- Simultaneous playback of the same title on two devices is not supported; the newest checkpoint
  wins.
- Episode lists stay serial. Watched state may influence the default season and Continue Watching,
  but must not reorder episode rows.
- Unknown state is not negative state.
- Do not add a repeating runtime timer.
- Do not log credentials, private addon URLs, media IDs, response bodies, or watch history.
- Fix normalization/state boundaries rather than adding caller-specific guards.

## Confirmed Simkl Failures

### S1 — Local resume backfill is suppressed

**Severity:** critical  
**Owners:** `src/plugin/main.ts`, `src/shared/simkl.ts`

`syncSimklHistory` returns history that already merges the local input with Simkl's response:

- `src/shared/simkl.ts:537`

`syncRemoteHistory` later passes that merged history to `uploadLocalHistory` as though it were a
remote-only list:

- `src/plugin/main.ts:883-886`

`uploadLocalResume` builds its `known` set from that argument and therefore sees every local
unfinished entry as already present on Simkl:

- `src/plugin/main.ts:809-833`

Reproduction with one local 42% entry and an empty Simkl playback response:

```text
sync result still contains local entry = true
resume point considered already remote = true
pause upload count = 0
```

**Fix direction:** stop treating merged history as remote-only. Upload the newest merged unfinished
positions and let `lastResumeKey` deduplicate successful sends, or return remote playback separately
from the shared Simkl boundary.

**Required regression:** empty remote playback plus one local unfinished entry produces one
`/scrobble/pause` request.

### S2 — Positions after the eighth are marked sent without being sent

**Severity:** high  
**Owner:** `src/shared/simkl.ts`

`uploadSimklResume` computes `resumeKey(points)` over the complete input, sends only
`points.slice(0, MAX_RESUME_UPLOADS)`, then stores the complete key:

- key: `src/shared/simkl.ts:321-330`, `:345-347`
- truncated send: `src/shared/simkl.ts:351`
- completed key: `src/shared/simkl.ts:365`

Reproduction:

```text
input points = 9
first request count = 8
stored key describes = 9
identical second request count = 0
```

The ninth item is permanently suppressed.

**Fix direction:** sequentially send every point, or key only the successfully transmitted batch
and leave the remainder eligible for the next pass. Do not mark a point sent before its request
succeeds.

**Required regression:** nine points eventually produce nine requests; a partial failure leaves
unsent points retryable.

### S3 — Anime resume conflict uses episode order instead of checkpoint time

**Severity:** high  
**Owner:** `src/plugin/anime.ts`

`isLater` compares season and episode coordinates:

- `src/plugin/anime.ts:112-117`

It is also used to select paused playback:

- `src/plugin/anime.ts:427-430`

Reproduction:

```text
newer checkpoint: S1E2 in February
older checkpoint: S2E1 in January
chosen checkpoint: older S2E1
```

This contradicts the cross-device design: the newest pause/close checkpoint wins.

**Fix direction:** watched progress and paused progress need different selection rules. Watched
marks remain an exact set; choose a resume point by valid `paused.at` timestamp, with a deterministic
fallback only when timestamps are missing or invalid.

**Required regression:** a newer lower-coordinate pause beats an older higher-coordinate pause.

### S4 — Failed ownership verification becomes trusted ownership

**Severity:** high  
**Owners:** `src/shared/simkl.ts`, `src/shared/history.ts`, `src/plugin/anime.ts`

Newly parsed anime cours start with `ownsImdb: true`:

- `src/shared/simkl.ts:620-640`

`markCourOwnership` swallows `/search/id` failures and leaves that value unchanged:

- `src/shared/simkl.ts:585-616`

The pull is then treated as successful and its cursor may advance. Relation-chain resolution skips
every cour whose `ownsImdb` is true:

- `src/shared/simkl.ts:401-454`

The unverified value survives preference parsing because a missing value also defaults to true:

- `src/shared/history.ts:175-204`

This can place a later cour on the wrong IMDb show or leave it unplaced permanently.

**Fix direction:** ownership is tri-state: confirmed owner, confirmed non-owner, unknown. Unknown
must be eligible for relation lookup and must never use the direct season-one fallback in
`src/plugin/anime.ts:393-417`.

**Required regression:** a transient ownership request failure does not authorize direct IMDb
placement and remains retryable after the next sync.

### S5 — Fresh-device multi-cour placement can map a later cour to season one

**Severity:** high  
**Owner:** `src/plugin/anime.ts`

When local history does not identify the root show, a Simkl relation candidate is created with an
empty name:

- `src/plugin/anime.ts:355-376`

If the Simkl relation chain does not align with Cinemeta seasons, fallback calls
`loadChain(owner.name)` using that empty string:

- `src/plugin/anime.ts:383-392`

When no chain remains, the placement closure can treat the cour number as an episode in the first
Cinemeta season:

- `src/plugin/anime.ts:404-417`

Reproduction with no local history, a misaligned `[5, 12]` relation chain, and later-cour episode
six produced `S1E6` under the root IMDb show.

**Fix direction:** after loading Cinemeta metadata, use `details.media.name` for the AniList fallback.
If no verified chain remains, leave a non-owning or unknown cour unplaced rather than guessing
season one.

**Required regression:** a historyless device cannot place a later non-owning cour in season one.

### S6 — MAL-addressable anime is rejected without IMDb metadata

**Severity:** medium/high  
**Owners:** `src/shared/simkl.ts`, `src/plugin/anime.ts`, `src/plugin/main.ts`

The payload builder supports MAL-addressed anime, but `simklScrobble` exits when the media has no
IMDb ID before consulting the resolved cour:

- payload: `src/shared/simkl.ts:185-195`
- guard: `src/shared/simkl.ts:198-209`

Backfill has equivalent IMDb-only guards:

- `src/plugin/main.ts:787-800`, `:817-826`
- `src/plugin/anime.ts:452-459`

Stremio normalization deliberately accepts provider media carrying `mal_id` without IMDb metadata:

- `src/shared/stremio.ts:199-230`

**Fix direction:** a valid resolved MAL cour is sufficient for anime scrobbling and upload. Require
IMDb only for IMDb-addressed payloads.

**Required regressions:** a non-IMDb context with a valid MAL cour scrobbles; provider-only anime
with `malId` can upload watched and resume state.

### S7 — Logical `/sync/history` rejection is recorded as success

**Severity:** medium/high  
**Owner:** `src/shared/simkl.ts`

`uploadSimklHistory` treats every 2xx response as success and stores `lastUploadKey` without
examining the response:

- `src/shared/simkl.ts:286-304`

Current Simkl documentation allows a successful HTTP response to report unmatched items under
`not_found`. Recording the key then prevents that set from ever being retried or surfaced.

**Fix direction:** parse the documented `added`/`not_found` result before saving the key. Do not
include media identifiers in errors or logs.

**Required regression:** HTTP 201 with a non-empty `not_found` set does not record the upload as
fully successful.

Official reference:

- <https://api.simkl.org/api-reference/simkl/add-to-history.md>

### S8 — Remote anime removals cannot clear stale marks

**Severity:** lower; existing non-goal may need reconsideration  
**Owners:** `src/shared/simkl.ts`, `src/shared/history.ts`

An anime item with no watched episodes is omitted by `parseSimklWatchedCours`:

- `src/shared/simkl.ts:620-651`

`mergeSimklCours` only merges supplied cours and preserves old episodes when an incoming cour has
none:

- `src/shared/history.ts:154-172`

Placed Simkl coordinates are union-added:

- `src/shared/history.ts:120-134`

Therefore a remote anime unwatch/removal cannot clear a previous Simkl mark. The existing design
explicitly excludes remote unwatch convergence, so do not silently change this behavior as part of
the critical sync repair. Decide it separately.

## Confirmed Navigation Failures

### N1 — Previous Episode is not implemented

There is no previous-episode resolver, message, overlay action, or handler:

- messages expose only `ShowNextEpisode`: `src/shared/messages.ts:5-14`, `:74-79`
- overlay actions are recap, intro, credits, and next: `src/plugin/main.ts:398-403`
- playback uses `loadfile ... replace`, not an mpv playlist: `src/plugin/main.ts:286-314`

The sidebar back button only changes views: `src/ui/app.ts:616-628`.

Before implementation, define where Previous appears and its specials/boundary behavior. Do not
assume IINA's native previous control can navigate episodes when Popcorn supplies no playlist.

### N2 — Next can return the same episode

**Owner:** `src/shared/stremio.ts`

`parseSeriesEpisodes` does not deduplicate provider videos by coordinate or canonical ID:

- `src/shared/stremio.ts:274-303`

`findNextEpisode` finds the first matching ID and returns the immediately following array item:

- `src/shared/stremio.ts:375-388`

Duplicate IDs or duplicate coordinates can therefore return the current episode again.

**Required regressions:** duplicate IDs and distinct IDs sharing one season/episode coordinate are
skipped in favor of the next unique coordinate.

### N3 — Next can jump across an unaired immediate successor

`findNextEpisode` removes unavailable episodes before locating the successor. A future E2 followed
by E3 with a missing/invalid date makes E3 appear to be next:

- availability: `src/shared/stremio.ts:370-373`
- filtered navigation: `src/shared/stremio.ts:375-388`

This changes “immediate serial successor, if available” into “first later row that appears
available.”

**Fix direction:** identify the next unique serial coordinate first, then decide whether that
episode is available. Do not leap over a known future episode.

**Required regression:** E1 aired, E2 future, E3 unknown date returns no playable next episode.

### N4 — Playable unknown-resolution streams make Next disappear

`pickNextEpisodeStream` rejects every stream whose resolution cannot be parsed:

- `src/shared/stream-choice.ts:131-168`

`prefetchNextEpisode` stores nothing, while the overlay shows Next only when a prefetch exists:

- `src/plugin/main.ts:712-759`
- `src/plugin/main.ts:534-540`
- `src/plugin/intro.ts:338-362`

The sidebar can still play those direct HTTP streams, so this is inconsistent provider-dependent
behavior.

**Fix direction:** known resolution participates in ranking, but unknown resolution must remain a
playable fallback.

**Required regression:** an unknown-resolution direct stream is selected when it is the only valid
candidate.

### N5 — Specials are mixed into normal serial navigation

- `sortEpisodes` places season zero before season one: `src/shared/stremio.ts:138-142`
- `findNextEpisode` navigates the same complete set: `src/shared/stremio.ts:375-388`
- `getDefaultSeason` can select an unwatched special: `src/ui/app.ts:969-991`

Define a product policy before adding Previous. Recommended minimal policy: normal playback stays
within seasons `>= 1`; specials navigate within season zero only when the current episode is a
special.

### N6 — Episode metadata can stay stale for the whole session

Playback context carries the episode-list snapshot captured when a stream was opened:

- `src/ui/app.ts:1152-1164`

EOF and prefetch reuse it:

- `src/plugin/main.ts:349-380`, `:712-717`

Continue Watching caches series episode promises for the entire sidebar session with no TTL:

- `src/ui/app.ts:73`, `:777-790`

Newly aired or corrected metadata therefore cannot affect navigation until a reload.

**Fix direction:** use a short TTL or invalidate the relevant series cache when configuration/home
refreshes. Do not add a repeating timer.

### N7 — Continue Watching ignores exact watched-state gaps

`resolveUpNext` asks for the episode after the one history happens to carry:

- `src/ui/app.ts:750-775`

It does not consult `episodeWatchState`. Consequences include:

- rewatching an older episode can move a normal TV show's card backward;
- exact watched state such as E1 and E3 can produce E4 instead of the unwatched E2;
- the card can disagree with the default season, which does use the exact watched set.

**Fix direction:** derive the home-card target from the same exact watched-state boundary used by
the episode view. A genuine unfinished checkpoint resumes its own episode; otherwise select the
first available serial episode not present in the watched union.

**Required regressions:** a newer pause resumes itself; a watched gap chooses the first gap; a
rewatch does not regress the next unwatched target.

### N8 — EOF event ordering remains an unverified runtime risk

Natural EOF depends on `mpv.eof-reached.changed` setting a flag before `mpv.end-file` consumes it:

- `src/plugin/main.ts:349-381`, `:1007-1011`

Tests cover only the pure boolean helper, not actual event ordering, sidebar messages, or
exactly-once behavior. Do not claim this is a root cause without an IINA reproduction, but add an
integration-style lifecycle test while repairing navigation.

## Simkl API Contract Follow-up

Current official documentation requires application identification (`app-name`, `app-version`, and
`User-Agent`) and documents two anime integration paths:

- TVDB/TMDB-shaped applications use per-episode cross-mapping.
- Anime-native applications use MAL/AniList/Kitsu IDs with absolute/cour episode numbering.

The current client sends `simkl-api-key` and authorization but no app name, version, or user agent:

- `src/shared/simkl.ts:856-862`

Official references:

- <https://api.simkl.org/conventions/headers.md>
- <https://api.simkl.org/guides/anime.md>

`AGENTS.md` records live evidence that raw TVDB coordinates did not match Cinemeta for Bleach, so
do not replace the MAL/cour mapping solely from the generic guide. First compare real Cinemeta
coordinates with Simkl's per-episode `tvdb` mapping across the existing anime corpus. If the
handbook is wrong or stale, update it with the evidence in the same change.

## Implementation Order

Keep fixes isolated so each hypothesis remains testable:

1. Fix S1 and S2: resume backfill correctness.
2. Fix S3: timestamp-based pause conflict resolution.
3. Fix S4 and S5 together: verified ownership and safe fresh-device placement.
4. Fix S6: MAL-only scrobble and backfill.
5. Fix S7: validate upload results.
6. Fix N2, N3, and N4 at their shared owners.
7. Fix N7 so Continue Watching and default-season logic share one target calculation.
8. Decide N1 and N5 UX, then implement Previous using the same unique-coordinate resolver.
9. Address N6 cache freshness without timers.
10. Treat S8 and the API cross-mapping choice as explicit follow-ups.

Do not combine all ten steps into one unreviewable patch. Each numbered group should leave focused
tests passing before the next begins.

## Required Tests

Add the smallest colocated regressions:

- `src/shared/simkl.test.ts`
  - local resume with empty remote playback is uploaded;
  - nine-plus resume points are not lost;
  - partial upload remains retryable;
  - MAL-only scrobble succeeds with a resolved cour;
  - 201 plus `not_found` is not recorded as complete;
  - failed ownership lookup stays unknown and retryable.
- `src/plugin/anime.test.ts` (new; the module currently has no direct tests)
  - newest pause timestamp wins across cours;
  - historyless misaligned relation chain does not map a later cour to season one;
  - metadata title is used for safe fallback mapping;
  - MAL-only media uploads.
- `src/shared/stremio.test.ts`
  - duplicate IDs/coordinates do not repeat the current episode;
  - a future immediate successor blocks later unknown-date rows;
  - previous/next season and specials boundaries after policy approval.
- `src/shared/stream-choice.test.ts`
  - unknown resolution remains a playable last resort.
- `src/ui/app.test.ts`
  - Continue Watching resumes an unfinished checkpoint;
  - watched gaps select the first available unwatched episode;
  - rewatching an older episode does not regress the target.
- `src/plugin/playback.test.ts` or a focused lifecycle test
  - EOF and replacement ordering emits the correct navigation message exactly once.

## Verification

During each fix:

```sh
bun test path/to/relevant.test.ts
bun run typecheck
```

Before handoff:

```sh
bun test
bun run typecheck
git diff --check
bun run build
```

Packaging is necessary only when the user requests a local test archive or release. Manual IINA
checks remain required for real Simkl responses, two-device convergence, EOF event ordering,
overlay interaction, and uninstall/lifecycle behavior.
