# Next Episode During Credits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a Jellyfin-style `Next Episode` overlay during verified end credits and play the closest-quality next episode only when clicked.

**Architecture:** Extend the existing pure intro/segment helpers to parse credits markers and choose the active overlay action. Add one shared async stream loader usable by both the sidebar and plugin entry, then prefetch the next episode from `main.ts` with request-revision protection. Reuse the current `playItem` function for clicks and keep the natural-EOF sidebar flow as fallback.

**Tech Stack:** TypeScript 5.9, Bun tests/build, IINA overlay and HTTP APIs, Stremio addon protocol, AniSkip v2.

## Global Constraints

- Never autoplay the next episode.
- Use only exact chapter names `ending`, `credits`, `outro`, or `ed`, or a valid AniSkip `ed` interval.
- The current stream's quality is the recommendation target.
- Ignore stale prefetch results after file replacement.
- Keep the natural-EOF sidebar fallback.
- Before committing, verify author and committer are `Justaway41 <kritarthasapkota999@gmail.com>`.

---

### Task 1: Credits timing and overlay action

**Files:**
- Modify: `src/plugin/intro.ts`
- Test: `src/plugin/intro.test.ts`
- Modify: `xyz.brbc.popcorn.iinaplugin/ui/overlay.html`

**Interfaces:**
- Produces: `findChapterCredits(chapters, duration): IntroInterval | null`
- Extends: `parseAniSkipInterval(value, skipType = "op")`
- Produces: `getOverlayAction(time, intro, credits, nextReady): "intro" | "next" | null`

- [ ] **Step 1: Write failing tests for exact credits chapters, AniSkip `ed`, and intro priority**

```ts
expect(findChapterCredits([{ title: "Credits", start: 1200 }], 1500))
    .toEqual({ start: 1200, end: 1500 });
expect(parseAniSkipInterval(response, "ed")).toEqual({ start: 1320, end: 1410 });
expect(getOverlayAction(100, intro, credits, true)).toBe("intro");
```

- [ ] **Step 2: Run `bun test src/plugin/intro.test.ts` and confirm the missing exports fail**

- [ ] **Step 3: Implement the smallest strict parsers and action selector**

- [ ] **Step 4: Change the overlay page to render Jellyfin-style `Skip Intro` or `Next Episode` labels from plugin messages and post a single action message on click**

- [ ] **Step 5: Run `bun test src/plugin/intro.test.ts` and confirm it passes**

### Task 2: Shared direct-stream loading

**Files:**
- Modify: `src/shared/addons.ts`
- Test: `src/shared/addons.test.ts`
- Modify: `src/ui/app.ts`

**Interfaces:**
- Produces: `loadEnabledAddonStreams(addons, fetchManifest, fetchStreams): Promise<AddonStreamLoadResult>`
- Consumes: existing `parseAddonManifest`, `loadAddonStreams`, and enabled addon preference order

- [ ] **Step 1: Write a failing test with catalog-only, stream, failed, and disabled addons**

```ts
expect(result.streams.map(({ title }) => title)).toEqual(["Playable"]);
expect(result.failedAddons).toBe(1);
```

- [ ] **Step 2: Run `bun test src/shared/addons.test.ts` and confirm failure**

- [ ] **Step 3: Implement the shared loader with `Promise.allSettled`, capability filtering, response-order preservation, and URL deduplication**

- [ ] **Step 4: Replace the sidebar's local manifest/stream orchestration with the shared helper**

- [ ] **Step 5: Run `bun test src/shared/addons.test.ts src/ui/app.test.ts` and confirm it passes**

### Task 3: Prefetch and click-to-play

**Files:**
- Modify: `src/plugin/main.ts`
- Modify: `src/plugin/playback.ts`
- Test: `src/plugin/playback.test.ts`

**Interfaces:**
- Produces: `isCurrentRequest(expectedRevision, currentRevision): boolean`
- Consumes: `findNextEpisode`, `findClosestQualityStream`, and `loadEnabledAddonStreams`

- [ ] **Step 1: Write failing tests for stale-request rejection and no-autoplay decision state**

```ts
expect(isCurrentRequest(2, 2)).toBe(true);
expect(isCurrentRequest(2, 3)).toBe(false);
```

- [ ] **Step 2: Run `bun test src/plugin/playback.test.ts` and confirm failure**

- [ ] **Step 3: Prefetch the next released episode after file load, loading only direct HTTP streams and selecting closest quality**

- [ ] **Step 4: Resolve intro and credits markers together, including AniSkip `types=op&types=ed`, and reject stale responses with the playback revision**

- [ ] **Step 5: During credits show `Next Episode`; on click call the existing `playItem` with the prefetched URL/context; never call it from a timer or EOF**

- [ ] **Step 6: Preserve natural-EOF sidebar behavior when the user did not click**

- [ ] **Step 7: Run `bun test src/plugin/intro.test.ts src/plugin/playback.test.ts src/shared/addons.test.ts` and `bun run typecheck`**

### Task 4: Verify and install locally

**Files:**
- Build: `xyz.brbc.popcorn.iinaplugin/dist/*`
- Build: `xyz.brbc.popcorn.iinaplugin/ui/dist/*`

- [ ] **Step 1: Run `bun test && bun run typecheck && bun run build && bun run verify:root-info && bun run verify:built-client-version`**

- [ ] **Step 2: Run `git diff --check` and inspect `git status --short`**

- [ ] **Step 3: Verify the git identity, commit only implementation files, and leave unrelated untracked documents untouched**

- [ ] **Step 4: Copy the built bundle into the existing `xyz.brbc.popcorn.iinaplugin-dev` directory and compare build hashes**

- [ ] **Step 5: Ask the user to fully restart IINA and test a series episode with chapter or AniSkip credits metadata**
