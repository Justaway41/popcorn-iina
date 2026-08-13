# Season and Stream UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add collapsed season navigation, future-episode status, sticky context navigation, and stream language metadata.

**Architecture:** Keep metadata normalization in `src/shared/stremio.ts` so the browser UI only renders typed values. Use native `<details>` elements and CSS sticky positioning; add no state manager or dependency.

**Tech Stack:** TypeScript, browser DOM APIs, CSS, Bun tests and build.

## Global Constraints

- Episode availability means only: Cinemeta `firstAired` is not a valid future date.
- Do not probe the addon once per episode.
- Omit language when it cannot be inferred.
- Preserve addon stream titles and the existing `Stream` fallback.
- Add no dependencies.

---

### Task 1: Normalize availability and language metadata

**Files:**
- Modify: `src/shared/stremio.ts`
- Test: `src/shared/stremio.test.ts`

**Interfaces:**
- Produces: `isEpisodeAvailable(episode: Episode, now?: Date): boolean`
- Extends: `PlayableStream` with `language: string`

- [ ] **Step 1: Write failing tests**

Add assertions proving that past, current, missing, and invalid air dates remain available; a future air date is unavailable. Extend the playable-stream fixture with `English`, `MULTI`, and unknown titles and assert normalized `English`, `Multi`, and empty language values.

- [ ] **Step 2: Verify RED**

Run: `bun test src/shared/stremio.test.ts`
Expected: FAIL because `isEpisodeAvailable` and `PlayableStream.language` do not exist.

- [ ] **Step 3: Implement the minimum parser logic**

Add `language` to `PlayableStream`. Extract only explicit language markers from the combined stream name/title/description using a small ordered regex map. Add `isEpisodeAvailable`, returning false only when `Date.parse(episode.aired)` is finite and later than `now`.

- [ ] **Step 4: Verify GREEN**

Run: `bun test src/shared/stremio.test.ts`
Expected: all tests pass.

### Task 2: Render folded seasons and availability

**Files:**
- Modify: `src/ui/app.ts`
- Modify: `xyz.brbc.popcorn.iinaplugin/ui/sidebar.css`

**Interfaces:**
- Consumes: `isEpisodeAvailable(episode: Episode): boolean`
- Consumes: `PlayableStream.language`

- [ ] **Step 1: Replace season wrappers with native disclosure sections**

In `renderEpisodes`, create a `<details class="season">` and `<summary>` containing `Season N` plus the episode count. Keep every season closed by default.

- [ ] **Step 2: Disable future episodes**

Extend `rowButton` with an optional disabled flag. For future episodes, set `disabled`, omit the play glyph, add the unavailable class, and render `Available <localized date>`.

- [ ] **Step 3: Render stream language**

In `buildStreamDetails`, append a neutral metadata label when `stream.language` is non-empty.

- [ ] **Step 4: Keep navigation context visible**

Make `.section-header` sticky below `.app-header`, with the existing background and border tokens. Style native summary focus/hover states and unavailable rows without changing the established visual system.

- [ ] **Step 5: Verify UI compilation**

Run: `bun run typecheck && bun run build`
Expected: typecheck succeeds and all three bundles build.

### Task 3: Final verification

**Files:** none

- [ ] **Step 1: Run the complete checks**

Run: `bun test && bun run typecheck && bun run build && git diff --check`
Expected: all tests pass, compilation succeeds, bundles build, and no whitespace errors are reported.

- [ ] **Step 2: Review generated diff**

Run: `git diff -- src/shared/stremio.ts src/shared/stremio.test.ts src/ui/app.ts xyz.brbc.popcorn.iinaplugin/ui/sidebar.css xyz.brbc.popcorn.iinaplugin/ui/dist/sidebar.js`
Expected: only approved season, availability, sticky-header, language, test, and generated bundle changes.
