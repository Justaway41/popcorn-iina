# Cross-Device Episode Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make watched episodes and paused progress converge across devices connected to the same Simkl account.

**Architecture:** Keep the 100-entry recent history list and add a compact watched-episode state owned by `src/shared/history.ts`. Simkl returns provider-specific watched-show patches; plugin and preferences callers merge them at persistence boundaries, while the sidebar consumes normalized state and rerenders an open season in place.

**Tech Stack:** TypeScript, Bun tests, IINA JavaScript plugin APIs, Simkl Sync API.

**Spec:** `docs/superpowers/specs/2026-09-03-cross-device-episode-progress-design.md`

## Global Constraints

- Do not add a repeating runtime timer or a dependency.
- Keep `watchHistory` capped and store complete episode marks separately.
- Preserve all existing request-revision guards and re-read preferences before asynchronous writes.
- Treat stored preferences and Simkl JSON as untrusted.
- Never log credentials, media identifiers, response bodies, or watch data.
- Do not create a local `.iinaplgz` package for this task.
- Preserve every pre-existing dirty file and build on the existing `src/plugin/main.ts`, `dist/main.js`, and `AGENTS.md` changes.

---

### Task 1: Compact Watched State and Progress Reconciliation

**Files:**
- Modify: `src/shared/history.ts`
- Test: `src/shared/history.test.ts`
- Modify: `src/shared/trakt.ts`
- Test: `src/shared/trakt.test.ts`

**Interfaces:**
- Produces: `WatchedShow`, `EpisodeWatchState`, `WatchedShowPatch`.
- Produces: `parseEpisodeWatchState(value, legacyHistory?)`.
- Produces: `markEpisodeWatched(state, context)`.
- Produces: `applySimklWatchedPatches(state, patches)` and `clearSimklWatched(state)`.
- Produces: `isEpisodeWatched(state, media, episode, legacyHistory?)`.
- Changes: `mergeWatchHistory` retains only the newest unfinished entry per title.

- [ ] **Step 1: Write failing watched-state tests**

Add tests proving defensive parsing, stable deduplication, local marking, per-show Simkl replacement,
Simkl clearing, and legacy-history compatibility:

```ts
test("normalizes compact episode watch state", () => {
    expect(parseEpisodeWatchState({
        local: [{ id: "tt9", episodes: ["2:3", "2:3", "bad"] }],
        simkl: [{ id: "tt9", episodes: ["1:2"] }, null]
    })).toEqual({
        local: [{ id: "tt9", episodes: ["2:3"] }],
        simkl: [{ id: "tt9", episodes: ["1:2"] }]
    });
});

test("replaces only the changed Simkl show", () => {
    const state = parseEpisodeWatchState({
        local: [{ id: "tt9", episodes: ["1:1"] }],
        simkl: [
            { id: "tt9", episodes: ["1:1"] },
            { id: "tt8", episodes: ["2:2"] }
        ]
    });
    expect(applySimklWatchedPatches(state, [{ id: "tt9", episodes: ["1:2"] }])).toEqual({
        local: [{ id: "tt9", episodes: ["1:1"] }],
        simkl: [
            { id: "tt8", episodes: ["2:2"] },
            { id: "tt9", episodes: ["1:2"] }
        ]
    });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun test src/shared/history.test.ts`

Expected: compilation failure because the watched-state exports do not exist.

- [ ] **Step 3: Implement the compact state in `history.ts`**

Add the persisted types and pure helpers. Parse episode coordinates with an anchored integer
pattern, normalize show arrays by ID, and use `historyTitleId` for canonical show identity:

```ts
export interface WatchedShow {
    id: string;
    episodes: string[];
}

export interface EpisodeWatchState {
    local: WatchedShow[];
    simkl: WatchedShow[];
}

export interface WatchedShowPatch extends WatchedShow {}

export function episodeCoordinate(episode: Episode): string {
    return `${episode.season}:${episode.episode}`;
}
```

`parseEpisodeWatchState` must merge watched episode entries from optional legacy history into
`local`. `applySimklWatchedPatches` replaces a returned show, including an explicit empty episode
array. `clearSimklWatched` returns the local half unchanged.

- [ ] **Step 4: Add failing newest-progress tests**

In `src/shared/trakt.test.ts`, merge two unfinished episodes of the same show in both input orders
and assert only the newest survives while watched episodes remain:

```ts
test("keeps only the newest unfinished episode per title", () => {
    const merged = mergeWatchHistory([olderPaused, watchedEpisode], [newerPaused]);
    expect(merged.map((entry) => entry.id)).toEqual([
        newerPaused.id,
        watchedEpisode.id
    ]);
});
```

- [ ] **Step 5: Run the focused test and confirm RED**

Run: `bun test src/shared/trakt.test.ts`

Expected: the older paused episode is still present.

- [ ] **Step 6: Filter merged history at the shared boundary**

After existing key-level merging and timestamp sorting, retain every watched item but only the
first unfinished item for each `historyTitleId`:

```ts
const unfinishedTitles = new Set<string>();
return sorted.filter((entry) => {
    if (entry.watched) return true;
    const id = historyTitleId(entry);
    if (unfinishedTitles.has(id)) return false;
    unfinishedTitles.add(id);
    return true;
}).slice(0, MAX_HISTORY_ITEMS);
```

- [ ] **Step 7: Verify Task 1**

Run: `bun test src/shared/history.test.ts src/shared/trakt.test.ts`

Expected: all tests pass.

---

### Task 2: Parse Detailed Simkl Episode State

**Files:**
- Modify: `src/shared/simkl.ts`
- Test: `src/shared/simkl.test.ts`
- Modify: `src/plugin/simkl.ts`
- Test: `src/plugin/simkl.test.ts`

**Interfaces:**
- Consumes: `WatchedShowPatch` from Task 1.
- Produces: `SimklHistorySyncResult` with `state`, `history`, and `watchedPatches`.
- Produces: `parseSimklWatchedPatches(items)`.
- Changes: `IinaSimklClient.sync(history)` returns `{ history, watchedPatches }`.

- [ ] **Step 1: Add detailed-response parser tests**

Use fixtures containing TV `seasons[].episodes[]`, anime mapped seasons, an explicit empty season
list, and malformed data. Assert only IMDb-backed shows become patches:

```ts
test("parses exact watched episodes into per-show patches", () => {
    expect(parseSimklWatchedPatches({
        shows: [{
            show: { title: "Show", ids: { imdb: "tt5753856" } },
            seasons: [{ number: 2, episodes: [{ number: 1 }, { number: 3 }] }]
        }]
    })).toEqual([{ id: "tt5753856", episodes: ["2:1", "2:3"] }]);
});
```

Anime and shows share one path: `seasons[].number` plus `episodes[].number`, keeping only episodes
that carry `watched_at`. The `tvdb` mapping anime episodes also carry addresses the franchise, not
the Cinemeta series, and must not be used. Reject any pair containing a negative or non-integer
value.

- [ ] **Step 2: Run the Simkl test and confirm RED**

Run: `bun test src/shared/simkl.test.ts`

Expected: missing parser/result fields and the old request URL.

- [ ] **Step 3: Implement detailed request construction and parsing**

Build the item query from fixed parameters and the encoded existing cursor:

```ts
const query = [
    "extended=full_anime_seasons",
    "episode_watched_at=yes",
    "include_all_episodes=yes",
    ...(state.lastActivityAt
        ? [`date_from=${encodeURIComponent(state.lastActivityAt)}`]
        : [])
].join("&");
const items = await request(transport, state, "GET", `/sync/all-items/?${query}`, null, now);
```

Return `watchedPatches: parseSimklWatchedPatches(items)` with the existing recent history. When
activities are unchanged or synchronization fails, return an empty patch list so callers make no
watched-state mutation.

- [ ] **Step 4: Update the IINA Simkl wrapper**

Change its interface to:

```ts
sync(history: WatchHistoryEntry[]): Promise<{
    history: WatchHistoryEntry[];
    watchedPatches: WatchedShowPatch[];
}>;
```

Disconnected and failed operations return the input history with `watchedPatches: []`. Preserve
the existing serialized queue and connection-change guard.

- [ ] **Step 5: Verify Task 2**

Run: `bun test src/shared/simkl.test.ts src/plugin/simkl.test.ts`

Expected: all tests pass.

---

### Task 3: Persist and Transport Watched State

**Files:**
- Modify: `Info.json`
- Modify: `src/shared/messages.ts`
- Modify: `src/plugin/main.ts`
- Test: `src/plugin/preferences.test.ts`
- Modify: `src/ui/preferences.ts`
- Test: `src/ui/preferences.test.ts`

**Interfaces:**
- Consumes: Task 1 watched-state helpers and Task 2 Simkl patches.
- Changes: `ConfigurationPayload.episodeWatchState` and `HistoryPayload.episodeWatchState`.
- Adds preference default: `episodeWatchState: { local: [], simkl: [] }`.

- [ ] **Step 1: Add failing persistence tests**

Cover these source-visible behaviors:

- a watched episode checkpoint adds a local coordinate;
- background Simkl sync applies patches to the latest preference value;
- Preferences Connect and Sync Now re-read and merge the latest state;
- disconnect and credential changes clear only `simkl`.

Use the existing source-contract tests where IINA runtime objects cannot be instantiated:

```ts
expect(info.preferenceDefaults.episodeWatchState).toEqual({ local: [], simkl: [] });
expect(mainSource).toContain("markEpisodeWatched");
expect(mainSource).toContain("applySimklWatchedPatches");
expect(mainSource).toContain("episodeWatchState");
expect(preferencesSource).toContain("clearSimklWatched");
```

- [ ] **Step 2: Run focused plugin/preferences tests and confirm RED**

Run: `bun test src/plugin/preferences.test.ts src/ui/preferences.test.ts`

Expected: missing watched-state preference/message persistence.

- [ ] **Step 3: Add the preference and message fields**

Add the default to `Info.json` and extend both payloads:

```ts
episodeWatchState: EpisodeWatchState;
```

- [ ] **Step 4: Integrate local playback writes in `main.ts`**

At `savePlaybackProgress`, parse recent history and watched state from preferences. After
`recordPlayback`, inspect the updated context entry; when it is watched and has an episode, call
`markEpisodeWatched`. Write both values once, sync once, then post one `HistoryUpdated` payload
containing both.

- [ ] **Step 5: Integrate background synchronization in `main.ts`**

Keep Trakt first. Pass its history into Simkl, then re-read both preferences before the final
write. Merge the latest history with the returned history and apply only the returned Simkl
patches to the latest watched state. Include watched state in `Configuration` and every
`HistoryUpdated` message.

- [ ] **Step 6: Integrate Preferences Connect, Sync Now, and disconnect**

Create one local persistence helper that re-reads `episodeWatchState`, applies the returned
patches, then writes history and watched state before `preferences.sync?.()`. Use it from Simkl
Connect and Sync Now. Call `clearSimklWatched` when disconnecting or changing credentials.

- [ ] **Step 7: Verify Task 3**

Run: `bun test src/plugin/preferences.test.ts src/ui/preferences.test.ts src/plugin/simkl.test.ts`

Expected: all tests pass.

---

### Task 4: Refresh Episode Rows Without Losing Navigation State

**Files:**
- Modify: `src/ui/app.ts`
- Test: `src/ui/app.test.ts`

**Interfaces:**
- Consumes: `EpisodeWatchState`, `parseEpisodeWatchState`, and `isEpisodeWatched`.
- Changes: the episodes `View` variant retains normalized media, episodes, and selected season.

- [ ] **Step 1: Add failing UI state tests**

Extract only pure calculations needed for reliable tests. Test watched lookup from local, Simkl,
and legacy state, plus a helper that chooses the active season without discarding an explicitly
selected valid season.

```ts
test("uses exact Simkl episode marks without inferring gaps", () => {
    const state = parseEpisodeWatchState({
        local: [],
        simkl: [{ id: "tt9", episodes: ["1:1", "1:3"] }]
    });
    expect(isEpisodeWatched(state, show, episode(1, 1), [])).toBe(true);
    expect(isEpisodeWatched(state, show, episode(1, 2), [])).toBe(false);
});
```

- [ ] **Step 2: Run the UI test and confirm RED**

Run: `bun test src/ui/app.test.ts`

Expected: episode rendering still reads only `watchHistory` and view state lacks episodes.

- [ ] **Step 3: Store sufficient episode view state**

Change the variant to:

```ts
| {
    kind: "episodes";
    media: Media;
    episodes: Episode[];
    selectedSeason?: number;
}
```

Set it only after metadata loads successfully. Whenever a season chip renders another season,
update `view.selectedSeason`.

- [ ] **Step 4: Render from compact watched state**

Parse `episodeWatchState` from configuration/history messages. Replace episode-only calls to the
old `isWatched(id)` with `isEpisodeWatched(episodeWatchState, media, episode, watchHistory)`.
Movie and recent-card behavior remains unchanged.

- [ ] **Step 5: Repaint an open episode view on history updates**

Before rendering, save `ui.content.scrollTop`; call `renderEpisodes` with the retained media,
episodes, and selected season; then restore the scroll position. Do not reload metadata or create a
network request.

- [ ] **Step 6: Verify Task 4**

Run: `bun test src/ui/app.test.ts src/shared/history.test.ts`

Expected: all tests pass.

---

### Task 5: Handbook, Build, and Verification

**Files:**
- Modify: `AGENTS.md`
- Regenerate: every tracked file changed by `bun run build`

**Interfaces:**
- Documents the final persisted state, Simkl detailed sync, one-unfinished-entry rule, and open-view repaint behavior.

- [ ] **Step 1: Update the handbook**

Replace the stale statement that `extended=full` is unused. Document `episodeWatchState`,
incremental detailed Simkl patches, local/Simkl origins, and the newest-unfinished conflict rule.
Preserve all unrelated current handbook edits.

- [ ] **Step 2: Run full source verification**

Run:

```sh
bun test
bun run typecheck
git diff --check
```

Expected: all commands pass.

- [ ] **Step 3: Rebuild tracked bundles without packaging**

Run: `bun run build`

Expected: runtime bundles regenerate successfully. Keep every tracked generated change; do not
create `xyz.brbc.popcorn.iinaplugin.iinaplgz`.

- [ ] **Step 4: Verify built metadata**

Run:

```sh
bun run verify:root-info
bun run verify:built-client-version
```

Expected: both commands pass.

- [ ] **Step 5: Review scope**

Run `git status --short` and `git diff --stat`. Confirm the pre-existing intro/main/handbook work
was preserved, no private values appear, and no local package was created or changed.

- [ ] **Step 6: Report manual requirements**

Report that two-device IINA verification and any push/release remain outstanding. Do not commit,
push, tag, package, or publish unless the user explicitly asks.
