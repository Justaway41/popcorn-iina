# Catalog and Playback Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge Cinemeta and enabled Stremio catalog search results, then add file-size sorting, explicit closest-quality next episode playback, and verified Skip Intro controls.

**Architecture:** Extend the existing Stremio parsing module with provider-aware media previews, manifest capability parsing, endpoint builders, stable merge/sort helpers, and intro interval parsers. Keep network orchestration in the existing preferences/sidebar/plugin entry points. Store only the selected stream quality in the existing playback context; continue using the current addon preferences without migration.

**Tech Stack:** TypeScript 5.9, Bun test/build, IINA JavaScript plugin API, Stremio addon protocol, Kitsu mappings, AniSkip.

## Global Constraints

- Cinemeta remains the only Trending source; merged providers are search-only.
- TMDB preset URL is `https://94c8cb9f702d-tmdb-addon.baby-beamup.club/manifest.json`.
- Anime Kitsu preset URL is `https://anime-kitsu.strem.fun/manifest.json`.
- Do not add a TMDB API token, new dependency, autoplay, guessed intro time, or automatic intro skipping.
- Manifest URLs remain local preferences and blurred until explicitly revealed.
- Unknown file sizes always sort after known sizes in both directions.
- Optional provider, subtitle, Trakt, Kitsu mapping, and AniSkip failures must not block local playback.
- Before every commit or push, verify author and committer are `Justaway41 <kritarthasapkota999@gmail.com>`.

---

### Task 1: Manifest capabilities and preset settings

**Files:**
- Modify: `src/shared/addons.ts`
- Test: `src/shared/addons.test.ts`
- Modify: `src/ui/preferences.ts`
- Modify: `xyz.brbc.popcorn.iinaplugin/ui/preferences.html`

**Interfaces:**
- Produces: `AddonResource = "catalog" | "meta" | "stream" | "subtitles"`
- Produces: `AddonManifest { name: string; resources: AddonResource[]; catalogs: StremioCatalog[]; types: string[] }`
- Produces: `parseAddonManifest(value: unknown): AddonManifest`
- Produces: `getAddonCapabilities(value: unknown): AddonResource[]`

- [ ] **Step 1: Write failing capability tests**

```ts
expect(parseAddonManifest({ name: "Catalog", resources: ["catalog"] })).toMatchObject({
    name: "Catalog",
    resources: ["catalog"]
});
expect(parseAddonManifest({ name: "Mixed", resources: [{ name: "meta" }, "stream"] }).resources)
    .toEqual(["meta", "stream"]);
expect(() => parseAddonManifest({ name: "Unsupported", resources: ["addon_catalog"] }))
    .toThrow("Manifest does not provide a supported resource.");
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `bun test src/shared/addons.test.ts`

Expected: FAIL because `parseAddonManifest` returns a string and rejects catalog-only manifests.

- [ ] **Step 3: Parse only supported manifest capabilities**

Replace the stream-only check with validation for `catalog`, `meta`, `stream`, and `subtitles`, supporting both string resources and `{ name, types }` resource objects. Return the parsed name, deduplicated resource names, manifest types, and valid catalog declarations.

- [ ] **Step 4: Add preset controls and capability badges**

Add TMDB and Anime Kitsu preset buttons to the existing settings section. Route preset clicks through the same canonicalization, duplicate validation, fetch, and save path as manual URLs. Cache fetched manifest details only for the current preferences view and render `Catalog`, `Metadata`, `Streams`, and `Subtitles` badges on rows; do not change the stored `StremioAddon` shape.

- [ ] **Step 5: Run focused tests**

Run: `bun test src/shared/addons.test.ts src/ui/preferences.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit only task files**

```bash
git add src/shared/addons.ts src/shared/addons.test.ts src/ui/preferences.ts xyz.brbc.popcorn.iinaplugin/ui/preferences.html
git commit -m "feat: support catalog addon capabilities"
```

### Task 2: Provider-aware catalog and metadata normalization

**Files:**
- Modify: `src/shared/stremio.ts`
- Test: `src/shared/stremio.test.ts`

**Interfaces:**
- Extends: `Media` with `sourceManifestUrl`, `providerId`, `providerType`, and optional `malId`
- Produces: `buildStremioResourceUrl(manifestUrl, resource, type, id, extra?)`
- Produces: `getSearchableCatalogs(manifest, mediaType): StremioCatalog[]`
- Produces: `mergeMediaResults(groups: Media[][]): Media[]`
- Produces: `parseMediaResponse(value, source): Media[]`
- Produces: `parseMediaMetadata(value, source, preview): { media: Media; episodes: Episode[] }`
- Produces: `isImdbId(value: string): boolean`

- [ ] **Step 1: Write failing endpoint, type, merge, and provider parsing tests**

```ts
expect(buildStremioResourceUrl(manifestUrl, "catalog", "anime", "kitsu-anime-list", { search: "Frieren" }))
    .toEndWith("/catalog/anime/kitsu-anime-list/search=Frieren.json");
expect(getSearchableCatalogs(kitsuManifest, "series").map(({ type }) => type))
    .toContain("anime");
expect(mergeMediaResults([[cinemeta], [duplicateByImdb, kitsuOnly]])).toEqual([cinemeta, kitsuOnly]);
expect(parseMediaResponse(kitsuSearch, kitsuSource)[0]).toMatchObject({
    providerId: "kitsu:46474",
    providerType: "anime",
    type: "series",
    imdbId: ""
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `bun test src/shared/stremio.test.ts`

Expected: FAIL because provider metadata and generic resource builders do not exist.

- [ ] **Step 3: Implement generic URL construction and searchable catalog selection**

Derive every resource endpoint from the canonical manifest URL while preserving configuration query strings. Select catalogs declaring `extra: [{ name: "search" }]`; Movies accept `movie`, TV accepts `series` and `anime`.

- [ ] **Step 4: Normalize previews, full metadata, and episodes**

Map provider `anime` to display type `series`. Keep provider ID/type separate from optional valid IMDb identity. For episodes, prefer `imdb_id` plus `imdbSeason`/`imdbEpisode` when present; otherwise retain the provider video ID. Preserve the current Cinemeta aliases for `title`, `released`, and `overview`.

- [ ] **Step 5: Implement stable provider merge**

Deduplicate first by valid IMDb ID, otherwise by normalized display type/title/release year. Iterate groups in input order so Cinemeta and earlier enabled addons win.

- [ ] **Step 6: Run focused tests**

Run: `bun test src/shared/stremio.test.ts src/shared/history.test.ts src/shared/trakt.test.ts`

Expected: PASS, including legacy stored media parsing.

- [ ] **Step 7: Commit only task files**

```bash
git add src/shared/stremio.ts src/shared/stremio.test.ts
git commit -m "feat: normalize provider catalog metadata"
```

### Task 3: Merged sidebar search and provider metadata loading

**Files:**
- Modify: `src/ui/app.ts`
- Test: `src/ui/app.test.ts`
- Modify: `src/shared/history.ts`
- Test: `src/shared/history.test.ts`
- Modify: `src/shared/trakt.ts`
- Test: `src/shared/trakt.test.ts`

**Interfaces:**
- Consumes: provider-aware `Media`, `parseAddonManifest`, `getSearchableCatalogs`, `buildStremioResourceUrl`, `mergeMediaResults`
- Produces: `loadCatalogSearchSources(...)` orchestration in `src/ui/app.ts`
- Produces: valid-IMDb guards for OpenSubtitles and Trakt calls

- [ ] **Step 1: Write failing orchestration and identity guard tests**

```ts
expect(isCompatibleSubtitleId("kitsu:46474")).toBe(false);
expect(isCompatibleSubtitleId("tt1234567:1:2")).toBe(true);
expect(canSyncTrakt({ ...media, imdbId: "" })).toBe(false);
```

Test a pure `mergeSettledCatalogResults` helper with one rejected and two fulfilled sources; assert results remain ordered and the failure count is one.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `bun test src/ui/app.test.ts src/shared/history.test.ts src/shared/trakt.test.ts`

Expected: FAIL because merged search and identity guards do not exist.

- [ ] **Step 3: Fetch manifests and searchable catalogs concurrently**

Keep empty-query home loading on Cinemeta Trending. For submitted search, use `Promise.allSettled` across Cinemeta and enabled addon manifests, then across matching searchable catalogs. Preserve source order, merge successful results, display an addon warning for partial failures, and show a retry error only when every source fails.

- [ ] **Step 4: Load selected provider metadata**

Use the source addon's `meta` endpoint when supported. Movies without metadata continue from the preview. Series without source metadata fall back to Cinemeta only for valid IMDb IDs; otherwise render `Episode metadata unavailable.`

- [ ] **Step 5: Route streams, subtitles, history, and Trakt through compatible identities**

Use episode canonical IDs when available and provider IDs otherwise for stream requests. Query OpenSubtitles only for IMDb-compatible IDs. Keep provider IDs valid for local history. Skip Trakt scrobbling and remote history upload entries without a valid IMDb ID.

- [ ] **Step 6: Run focused and full tests**

Run: `bun test src/ui/app.test.ts src/shared/history.test.ts src/shared/trakt.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit only task files**

```bash
git add src/ui/app.ts src/ui/app.test.ts src/shared/history.ts src/shared/history.test.ts src/shared/trakt.ts src/shared/trakt.test.ts
git commit -m "feat: merge addon catalog search"
```

### Task 4: File-size sorting, preserved stream list, and closest-quality next episode

**Files:**
- Modify: `src/shared/stremio.ts`
- Test: `src/shared/stremio.test.ts`
- Modify: `src/shared/messages.ts`
- Modify: `src/ui/app.ts`
- Test: `src/ui/app.test.ts`
- Modify: `src/plugin/main.ts`

**Interfaces:**
- Replaces: `QualityOrder` with `SizeOrder = "largest" | "smallest"`
- Produces: `parseByteSize(size: string): number | null`
- Produces: `sortStreamsBySize(streams, order)`
- Produces: `findClosestQualityStream(streams, previousQuality)`
- Extends: `PlaybackContext` with optional `quality`
- Extends: `ShowNextEpisodePayload` with optional `quality`

- [ ] **Step 1: Write failing sort and closest-quality tests**

```ts
expect(sortStreamsBySize(streams, "largest").map(({ title }) => title))
    .toEqual(["12 GB", "900 MB", "Unknown"]);
expect(sortStreamsBySize(streams, "smallest").map(({ title }) => title))
    .toEqual(["900 MB", "12 GB", "Unknown"]);
expect(findClosestQualityStream(qualityStreams, "1440p")?.quality).toBe("1080p");
expect(findClosestQualityStream(tieStreams, "900p")?.quality).toBe("1080p");
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `bun test src/shared/stremio.test.ts src/ui/app.test.ts`

Expected: FAIL because ordering still uses resolution and no recommendation helper exists.

- [ ] **Step 3: Implement byte-only stable sorting and closest-quality selection**

Parse decimal KB/MB/GB/TB values into bytes. Keep equal sizes stable and unknown sizes last. For recommendations, use exact numeric resolution, then smallest difference, higher resolution on a tie, and response order within equal quality; with unknown previous quality choose the highest known stream.

- [ ] **Step 4: Preserve stream content on playback click**

Delete the `showStreamLoading()` DOM replacement. Keep the stream list visible while the plugin's existing `core.osd("Loading stream...")` handles feedback.

- [ ] **Step 5: Render explicit next-episode recommendation**

Record selected quality in `PlaybackContext`. Pass it through the natural-EOF message. When the next episode stream page finishes loading, render one primary `Play Next Episode` button for the recommendation above the full sorted stream list. Its click reuses the normal PlayItem sender; loading alone never plays.

- [ ] **Step 6: Run focused tests**

Run: `bun test src/shared/stremio.test.ts src/ui/app.test.ts src/plugin/playback.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit only task files**

```bash
git add src/shared/stremio.ts src/shared/stremio.test.ts src/shared/messages.ts src/ui/app.ts src/ui/app.test.ts src/plugin/main.ts
git commit -m "feat: improve stream and next episode controls"
```

### Task 5: Verified Skip Intro overlay

**Files:**
- Create: `src/plugin/intro.ts`
- Test: `src/plugin/intro.test.ts`
- Modify: `src/plugin/main.ts`
- Create: `xyz.brbc.popcorn.iinaplugin/ui/overlay.html`

**Interfaces:**
- Produces: `IntroInterval { start: number; end: number }`
- Produces: `findChapterIntro(chapters): IntroInterval | null`
- Produces: `parseKitsuMalId(value): string`
- Produces: `parseAniSkipInterval(value): IntroInterval | null`
- Produces: `isInsideIntro(time, interval): boolean`

- [ ] **Step 1: Write failing chapter and AniSkip parser tests**

```ts
expect(findChapterIntro([
    { title: "Opening", start: 30 },
    { title: "Episode", start: 120 }
])).toEqual({ start: 30, end: 120 });
expect(findChapterIntro([{ title: "Opening", start: 30 }])).toBeNull();
expect(parseAniSkipInterval({ results: [{ skipType: "op", interval: { startTime: 10, endTime: 100 } }] }))
    .toEqual({ start: 10, end: 100 });
expect(isInsideIntro(100, { start: 10, end: 100 })).toBe(false);
```

- [ ] **Step 2: Run focused test and confirm failure**

Run: `bun test src/plugin/intro.test.ts`

Expected: FAIL because `src/plugin/intro.ts` does not exist.

- [ ] **Step 3: Implement strict interval and mapping parsers**

Match only case-insensitive chapter names `intro`, `opening`, or `op`, requiring a later chapter boundary. Accept only finite AniSkip opening intervals where `0 <= start < end`. Parse a MyAnimeList mapping only from Kitsu relationships whose external site is `myanimelist/anime`.

- [ ] **Step 4: Add the clickable overlay and playback integration**

Load a minimal overlay page with a single `Skip Intro` button using `data-clickable`. After `mpv.file-loaded`, prefer chapter timing; only if absent and current Kitsu anime metadata supplies an episode and MAL mapping, fetch Kitsu mappings then AniSkip. On `mpv.time-pos.changed`, show the overlay only inside the interval. The click message calls `core.seekTo(interval.end)` and hides it. Clear and hide state before replacement, on end-file, splash load, and window close.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `bun test src/plugin/intro.test.ts src/plugin/playback.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit only task files**

```bash
git add src/plugin/intro.ts src/plugin/intro.test.ts src/plugin/main.ts xyz.brbc.popcorn.iinaplugin/ui/overlay.html
git commit -m "feat: add verified skip intro control"
```

### Task 6: Full verification and local IINA bundle refresh

**Files:**
- Verify: all files changed by Tasks 1–5
- Build: `xyz.brbc.popcorn.iinaplugin/dist/*`
- Build: `xyz.brbc.popcorn.iinaplugin/ui/dist/*`

**Interfaces:**
- Consumes: the complete approved design
- Produces: a locally installable IINA development plugin bundle

- [ ] **Step 1: Run all automated checks**

```bash
bun test
bun run typecheck
bun run build
bun run verify:root-info
bun run verify:built-client-version
```

Expected: every command exits 0.

- [ ] **Step 2: Inspect the final diff and repository status**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; unrelated untracked documents remain unstaged.

- [ ] **Step 3: Refresh the local development plugin**

Copy the rebuilt plugin bundle contents into:

`~/Library/Application Support/com.colliderli.iina/plugins/xyz.brbc.popcorn.iinaplugin-dev`

Do not reinstall the published plugin and do not create a second identifier.

- [ ] **Step 4: Give the user a manual test checklist**

Ask the user to fully quit and reopen IINA, then verify a Cinemeta result, a TMDB result, a Kitsu anime, file-size sort direction, stream-list persistence while loading, explicit next episode recommendation, and Skip Intro on a file with a matching chapter or valid AniSkip opening.
