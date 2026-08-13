# Local Watch History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the newest 100 locally played Popcorn items, show six on Home plus a full Recently Watched page, and mark items watched at 90% or natural EOF.

**Architecture:** A pure shared module validates and updates history records. The main IINA entry owns preference persistence and playback thresholds; the sidebar receives typed history messages and reuses the existing poster and episode UI.

**Tech Stack:** TypeScript, IINA preferences and mpv APIs, browser DOM/CSS, Bun tests.

## Global Constraints

- Record playback at 5%.
- Mark watched at 90% or natural EOF.
- Keep at most 100 entries, newest first.
- Show at most 6 entries on Home.
- Do not persist stream URLs.
- Add no dependency.

---

### Task 1: Pure history model

**Files:**
- Create: `src/shared/history.ts`
- Create: `src/shared/history.test.ts`

**Interfaces:**
- Produces: `WatchHistoryEntry`, `parseWatchHistory(value)`, `recordPlayback(entries, context, percent, playedAt)`
- Consumes: `Media`, `Episode`, and `PlaybackContext` from shared types.

- [ ] **Step 1: Write failing tests**

Test malformed JSON returning an empty list; recording nothing below 5%; inserting at 5%; deduplicating and moving an existing item first; preserving watched state on replay; marking watched at 90%; and capping output at 100.

- [ ] **Step 2: Verify RED**

Run: `bun test src/shared/history.test.ts`
Expected: FAIL because `src/shared/history.ts` does not exist.

- [ ] **Step 3: Implement the model**

Define entries as `{ id, media, episode?, lastPlayedAt, watched }`. Use `episode.id` or `media.imdbId` as the key. Parse strings with `JSON.parse` inside `try/catch`, discard malformed records, update immutably, and return `entries.slice(0, 100)`.

- [ ] **Step 4: Verify GREEN**

Run: `bun test src/shared/history.test.ts`
Expected: all history tests pass.

### Task 2: Playback persistence and messages

**Files:**
- Modify: `src/shared/messages.ts`
- Modify: `src/plugin/main.ts`
- Modify: `xyz.brbc.popcorn.iinaplugin/Info.json`
- Modify: `Info.json`

**Interfaces:**
- Produces: `PlaybackContext { media, episode?, episodes }`
- Produces: configuration/history payloads containing `history: WatchHistoryEntry[]`
- Stores: preference key `watchHistory` as JSON text.

- [ ] **Step 1: Make playback context available for movies and episodes**

Replace the episode-only payload field with `playbackContext`, always sent by the UI. Keep optional `episode` and the episode list so movies and series share one history path.

- [ ] **Step 2: Persist threshold crossings**

Read history defensively from preferences. On the existing playback timer, record once when `mpv.getNumber("percent-pos") >= 5` and once when it reaches 90. On confirmed natural EOF, record 100 before clearing context. Call `preferences.sync()` after each actual write.

- [ ] **Step 3: Notify the sidebar**

Include history in the configuration response and post `HistoryUpdated` after writes. Add `watchHistory: "[]"` to both synchronized manifests.

- [ ] **Step 4: Verify compilation**

Run: `bun run typecheck`
Expected: both TypeScript projects pass.

### Task 3: Home recents, full history, and watched badges

**Files:**
- Modify: `src/ui/app.ts`
- Modify: `xyz.brbc.popcorn.iinaplugin/ui/sidebar.css`

**Interfaces:**
- Consumes: `WatchHistoryEntry[]` from configuration and `HistoryUpdated`.
- Produces: `{ kind: "history"; query: string }` sidebar view.

- [ ] **Step 1: Initialize with history**

Wait for the first configuration response before loading Home. Update in-memory history on `HistoryUpdated`.

- [ ] **Step 2: Reuse poster cards**

Extract the current media-card construction into one function accepting title, subtitle, click action, and watched state. Add a compact watched check overlay.

- [ ] **Step 3: Render Home recents**

For an empty search query and non-empty history, render a `Recently Watched` heading, the newest six cards, and a `See all` button before a `Trending` heading and existing results.

- [ ] **Step 4: Render full history**

Add a history view using the same grid for all stored entries. Back reloads the prior Home query. A movie loads streams directly; an episode first fetches its current Cinemeta episode list, then loads streams with the matching stored episode.

- [ ] **Step 5: Render watched state in browsing**

Mark matching movie cards and episode rows with the same check indicator without disabling them.

- [ ] **Step 6: Verify UI build**

Run: `bun run typecheck && bun run build`
Expected: compilation and all bundles succeed.

### Task 4: Final verification and package

**Files:** none

- [ ] **Step 1: Run all checks**

Run: `bun test && bun run typecheck && bun run build && bun run verify:root-info && bun run verify:built-client-version && git diff --check`
Expected: zero failures and synchronized manifests.

- [ ] **Step 2: Build the test package**

Run: `bun run package && zip -T xyz.brbc.popcorn.iinaplugin.iinaplgz`
Expected: archive builds and passes integrity testing.
