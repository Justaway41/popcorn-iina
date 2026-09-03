# Cross-Device Episode Progress Design

## Context

Popcorn currently uses one capped `WatchHistoryEntry[]` for two different jobs:

- recent titles and resume percentages;
- the complete set of watched episodes used by episode rows and default-season selection.

That cannot converge reliably across devices. Simkl's compact `/sync/all-items/` response supplies
only a title's `last_watched` position, while each device retains its own older local entries.
Unfinished entries are merged by episode, so an old pause on one device survives after another
device reports a newer episode. A successful history update also repaints the history page only;
an episode list already on screen stays stale.

## Goals

- Show the same exact watched episodes on devices connected to the same Simkl account.
- Transfer unfinished progress after playback is paused, replaced, or the window closes.
- Keep only the newest unfinished episode for a title, using timestamps to resolve conflicts.
- Refresh an open episode list without changing its selected season or scroll position.
- Preserve local progress when Simkl is disconnected or unavailable.
- Keep recent-history storage bounded without truncating watched-episode state.

## Non-goals

- Live progress synchronization while playback continues.
- Supporting two simultaneous active playbacks of the same title; the newest checkpoint wins.
- Synchronizing remote unwatch operations against episodes watched locally.
- Replacing Trakt or introducing a generic provider framework.
- Changing Continue Watching layout, completion thresholds, or the five-minute sync throttle.

## Chosen Approach

Keep recent progress and complete watched state separate.

`watchHistory` remains the capped recent/resume list. A new compact `episodeWatchState` preference
stores episode coordinates per show and per origin:

```ts
interface WatchedShow {
    id: string;
    episodes: string[]; // `season:episode`
}

interface EpisodeWatchState {
    local: WatchedShow[];
    simkl: WatchedShow[];
}
```

Arrays are used instead of an object keyed by untrusted provider IDs. Parsing accepts only a
non-empty show ID and finite, non-negative integer season and episode coordinates. Entries are
deduplicated and sorted for stable persistence. The rendered watched set is the union of `local`,
`simkl`, and watched entries still present in legacy `watchHistory`.

This avoids an unbounded recent-history array and does not guess that every episode before
`last_watched` was watched.

## Ownership

The existing modules keep their current responsibilities:

- `src/shared/history.ts` owns the persisted watched-state shape, defensive parsing, canonical
  coordinates, union checks, local marking, Simkl patch application, and unfinished-progress
  conflict resolution.
- `src/shared/simkl.ts` owns Simkl request construction and parsing provider responses into recent
  history plus watched-show patches. It does not read preferences or render UI.
- `src/plugin/main.ts` orchestrates player checkpoints, synchronization, persistence, and sidebar
  messages. It contains no Simkl response-shape logic.
- `src/ui/preferences.ts` applies the same pure synchronization result for Connect and Sync Now,
  preserving its existing revision guards.
- `src/shared/messages.ts` carries watched state with configuration and history updates.
- `src/ui/app.ts` consumes normalized state and owns repainting the visible episode view.

No new dependency, service layer, repository class, or general-purpose sync abstraction is added.

## Local Playback Flow

1. The existing mpv event path saves recent progress every 30 seconds.
2. When an episode reaches the existing 90 percent watched threshold, its show ID and
   `season:episode` coordinate are added to `episodeWatchState.local`.
3. Pause, stream replacement, natural EOF, and window close keep using `checkpointPlayback`.
4. A pause below the watched threshold sends Simkl's `pause` action. A completion sends `stop`.
5. There is no new timer and no remote write on each 30-second local save.

Before any preference write, the caller re-reads the stored history and watched state. This keeps a
network response that started earlier from overwriting a playback checkpoint recorded while it was
in flight.

## Simkl Synchronization

The existing `/sync/activities` cursor remains the gate. When its `all` timestamp is unchanged, no
item or playback request is made.

When data changed, `/sync/all-items/` requests detailed episode data with:

```text
extended=full_anime_seasons&episode_watched_at=yes&include_all_episodes=yes
```

`date_from` is included after the first successful synchronization. The detailed anime form is
used so Simkl supplies TVDB-style season mappings compatible with Cinemeta's season layout rather
than treating every anime cour as an unrelated season-one title. The parser uses the mapped season
and episode coordinates supplied by that response and rejects entries without an IMDb show ID.

For each returned show or anime item:

- `last_watched` still produces at most one recent-history entry;
- the explicit `seasons[].episodes[]` list produces one `WatchedShow` patch;
- only episodes carrying the requested `watched_at` marker count as watched;
- anime coordinates use `seasons[].number` and `episodes[].number`, the same as shows; each
  episode's `tvdb` mapping addresses the whole franchise and does not match Cinemeta;
- an explicitly empty `seasons` array clears Simkl watched state for that show;
- a missing or malformed `seasons` field or a malformed non-empty list produces no patch, so bad
  data cannot erase good state.

On the first full synchronization, all returned patches establish the Simkl baseline. On later
incremental synchronizations, a patch replaces only the matching show's `simkl` episodes. Other
shows remain untouched. The cursor advances only after activities, items, and playback all finish
successfully.

Simkl playback remains a separate recent-progress input. It is not added to the watched index until
the provider reports it watched or local playback reaches the threshold.

## Conflict Resolution

`mergeWatchHistory` continues to merge duplicate movie or episode records by canonical identity,
newest timestamp, rich metadata, and sticky watched state. After that merge, it keeps at most one
unfinished entry per title:

- sort newest first;
- keep every watched entry;
- keep the first unfinished entry for a title;
- drop older unfinished entries for that title.

Therefore a newer remote `S3E6` pause removes an older local `S2E8` pause, while an older remote
response cannot replace a newer local checkpoint. This rule applies equally when a viewer starts a
new episode locally. It matches the product decision that simultaneous playback of one title on two
devices is not supported.

Watched-state conflict rules are additive across origins. Simkl patches may remove an episode from
the `simkl` origin, but an episode present in `local` remains watched. This preserves offline local
history and matches the existing sticky-watched behavior.

## Messages and Rendering

`ConfigurationPayload` and `HistoryPayload` gain `episodeWatchState`. Their parsers treat a missing
or malformed value as empty so old stored preferences migrate without a separate one-shot script.

The sidebar builds its watched lookup from the normalized state. Movie watched marks and recent
cards continue to use `watchHistory`; episode rows and default-season selection use the watched
lookup plus legacy watched history.

The episode view retains the loaded episode list and selected season in its existing `View` state.
When `HistoryUpdated` arrives while that view is active, it rerenders from the retained episodes,
restores the same selected season, and restores the content scroll position. Other views retain
their current update behavior.

Preferences cannot directly repaint a separate open player webview. Connect or Sync Now writes the
latest normalized preferences; the next existing configuration request reads them. No polling or
cross-webview bridge is added.

## Disconnect and Migration

- Missing `episodeWatchState` starts as `{ local: [], simkl: [] }`.
- Watched episode entries already present in `watchHistory` continue to count immediately and are
  folded into `local` on the next relevant write.
- Disconnecting Simkl clears only the `simkl` origin and its activity cursor. Local watched state
  and recent history remain.
- Reconnecting performs a full baseline because the cursor was cleared.
- Changing Simkl credentials also clears the old account's `simkl` watched state.

## Failure and Privacy Rules

- Network failure, non-2xx status, invalid JSON, or a malformed detailed response leaves the stored
  watched state and history unchanged.
- A valid response may update one show without requiring every show to parse successfully.
- Client IDs, access tokens, private addon URLs, media IDs, response bodies, and watch data are not
  logged.
- Existing error sanitization and retry handling remain in place.
- IMDb IDs and episode coordinates are validated before persistence or message use.

## Testing

Small colocated tests cover the boundaries:

- `src/shared/history.test.ts`
  - defensively parse and normalize watched state;
  - mark a local episode without duplicating it;
  - replace one show's Simkl patch without touching another;
  - union local, Simkl, and legacy watched entries;
  - keep only the newest unfinished episode per title while retaining watched entries.
- `src/shared/simkl.test.ts`
  - request detailed data on first and incremental synchronization;
  - parse show and mapped-anime season/episode lists;
  - treat explicit empty seasons as a clearing patch;
  - ignore malformed episode data without clearing stored state;
  - return paused progress separately from watched state.
- `src/ui/app.test.ts`
  - episode watched lookup uses the compact state;
  - a history update preserves the active season and scroll position.
- `src/ui/preferences.test.ts` and plugin-side tests
  - Connect, Sync Now, background sync, and local checkpoints merge with the latest stored state;
  - disconnect and credential changes clear only Simkl-origin watched state.

Then run the repository's full source checks, rebuild/package every tracked bundle, and verify the
archive as specified in `AGENTS.md`.

Manual IINA verification uses two devices on the same Simkl account:

1. Finish several episodes and pause the next one on device A.
2. Use Sync Now or trigger normal configuration sync on device B.
3. Confirm exact watched checks, current progress, and default season match device A.
4. Leave the episode list open during another sync and confirm its season and scroll position stay
   fixed while marks update.
5. Disconnect Simkl and confirm local watched state remains.

## Release Boundary

Implementation produces a local package for testing. Version changes, commits beyond the approved
design document, pushing, and publishing remain separate explicit user actions.
