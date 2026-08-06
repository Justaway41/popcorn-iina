# Stream Display Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean decorated provider titles and show truthful cache and seeder metadata in each stream row.

**Architecture:** Normalize provider output once in `parsePlayableStreams`, preferring structured AIOStreams and Stremio fields before conservative text markers. Render the normalized tri-state metadata with existing badge patterns and retain the raw provider value as a tooltip.

**Tech Stack:** TypeScript, Bun tests, DOM APIs, CSS, IINA plugin build scripts.

## Global Constraints

- Do not add dependencies.
- Cache state is `true`, `false`, or `null`; never infer false from missing data.
- Seeder count is a non-negative integer or `null`; never treat unrelated numbers as seeders.
- Preserve playable streams when metadata is malformed.
- Prefer `behaviorHints.filename` and `behaviorHints.videoSize` over formatted provider text.

---

### Task 1: Normalize stream display metadata

**Files:**
- Modify: `src/shared/stremio.ts`
- Test: `src/shared/stremio.test.ts`

**Interfaces:**
- Produces: `PlayableStream.rawTitle: string`, `cached: boolean | null`, and `seeders: number | null`.
- Produces: cleaned `PlayableStream.title` and structured-size fallback through `parsePlayableStreams(value: unknown): PlayableStream[]`.

- [ ] **Step 1: Write failing parser tests**

Add cases equivalent to:

```ts
expect(parsePlayableStreams({ streams: [{
    name: "[TB+] AIOStreams 2160p",
    description: "🎬 Dark 🐒 S03 🎞 E03 🎥 WEBRip",
    url: "https://example/stream",
    behaviorHints: { filename: "Dark.S03E03.2160p.WEBRip.HEVC.mkv", videoSize: 65_928_328_806 },
    streamData: { service: { cached: true }, torrent: { seeders: 42 } }
}] })[0]).toMatchObject({
    title: "Dark · S03E03 · WEBRip · HEVC",
    rawTitle: "Dark.S03E03.2160p.WEBRip.HEVC.mkv",
    cached: true,
    seeders: 42
});
```

Also cover Comet `⚡`/`⬇️`, explicit zero seeders, conflicting cache markers, unknown metadata, emoji cleanup, and fallback to the original provider title.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun test src/shared/stremio.test.ts`

Expected: failures because the three fields and cleanup do not exist.

- [ ] **Step 3: Implement minimal structured-first parsing**

Update the interface:

```ts
export interface PlayableStream {
    title: string;
    rawTitle: string;
    url: string;
    quality: string;
    size: string;
    audioLanguages: string[];
    subtitleLanguages: string[] | null;
    cached: boolean | null;
    seeders: number | null;
}
```

Inside `parsePlayableStreams`, read `streamData.service.cached`, `streamData.torrent.seeders`, `behaviorHints.filename`, and `behaviorHints.videoSize`. Add small private helpers that clean the display title, format positive byte sizes, parse explicit seeder labels/symbols, and resolve cache markers to `true`, `false`, or `null` on conflicts.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bun test src/shared/stremio.test.ts && bun run typecheck`

Expected: PASS.

### Task 2: Render cache, seeders, and raw-title tooltip

**Files:**
- Modify: `src/ui/app.ts`
- Modify: `ui/sidebar.css`
- Test: `src/ui/app.test.ts`

**Interfaces:**
- Consumes: `PlayableStream.cached`, `seeders`, and `rawTitle` from Task 1.
- Produces: `getCacheBadge(cached: boolean | null)` returning label, title, and visual state.

- [ ] **Step 1: Write failing UI tests**

Add assertions for:

```ts
expect(getCacheBadge(true).label).toBe("Cached");
expect(getCacheBadge(false).label).toBe("Uncached");
expect(getCacheBadge(null).label).toBe("Cache ?");
```

Check the source contains the raw-title tooltip assignment, renders seeders when `stream.seeders !== null`, and does not use truthiness so explicit zero remains visible.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun test src/ui/app.test.ts`

Expected: failure because the cache helper and metadata rendering do not exist.

- [ ] **Step 3: Implement the existing-row UI**

Add the cache badge after the addon badge, add a neutral `<count> seeders` badge only for non-null values, and pass `stream.rawTitle` to `rowButton` so `.row-title.title` contains the untouched value. Add cached, uncached, and unknown CSS modifiers using the existing badge colors.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bun test src/ui/app.test.ts && bun run typecheck`

Expected: PASS.

### Task 3: Verify and package

**Files:**
- Regenerate: `dist/main.js`
- Regenerate: `dist/global.js`
- Regenerate: `ui/dist/sidebar.js`
- Regenerate: `ui/dist/preferences.js`

**Interfaces:**
- Consumes the completed parser and UI.
- Produces the directly installable repository build and `.iinaplgz` package.

- [ ] **Step 1: Run full verification**

Run:

```sh
bun test
bun run typecheck
bun run package
bun run verify:root-info
bun run verify:built-client-version
unzip -t xyz.brbc.popcorn.iinaplugin.iinaplgz
git diff --check
```

Expected: all tests and checks pass and the archive reports no errors.

- [ ] **Step 2: Review scope**

Confirm only parser, UI, CSS, tests, generated bundles, and this plan changed; leave unrelated untracked documents untouched.
