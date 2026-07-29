# Stream Quality Sorting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-button quality sort toggle that defaults to highest first and detects resolution from addon stream titles and metadata.

**Architecture:** Keep quality parsing and stable ordering as pure helpers in `src/shared/stremio.ts`. Build the toggle inside the existing stream renderer so switching order only replaces the displayed rows and never refetches streams.

**Tech Stack:** TypeScript, DOM APIs, CSS, Bun tests.

## Global Constraints

- Default to highest quality first for every newly opened stream list.
- Toggle between highest-first and lowest-first ordering.
- Keep unknown qualities last in both directions.
- Preserve addon order when qualities are equal.
- Add no dependencies or persistent preference.

---

### Task 1: Quality extraction, ordering, and toggle

**Files:**
- Modify: `src/shared/stremio.ts`
- Test: `src/shared/stremio.test.ts`
- Modify: `src/ui/app.ts`
- Modify: `xyz.brbc.popcorn.iinaplugin/ui/sidebar.css`

**Interfaces:**
- Produces: `QualityOrder = "highest" | "lowest"`
- Produces: `sortStreamsByQuality<T extends { quality: string }>(streams: T[], order: QualityOrder): T[]`
- Consumes: the existing `AddonStream.quality` populated by `parsePlayableStreams`

- [ ] **Step 1: Write failing extraction and sorting tests**

Add coverage that a title containing `1440p` is parsed and that known qualities sort stably while unknown qualities stay last:

```ts
const streams = [
    { title: "720", quality: "720p" },
    { title: "Unknown", quality: "" },
    { title: "4K first", quality: "4K" },
    { title: "4K second", quality: "2160p" },
    { title: "1080", quality: "1080p" }
];

expect(sortStreamsByQuality(streams, "highest").map(({ title }) => title)).toEqual([
    "4K first", "4K second", "1080", "720", "Unknown"
]);
expect(sortStreamsByQuality(streams, "lowest").map(({ title }) => title)).toEqual([
    "720", "1080", "4K first", "4K second", "Unknown"
]);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `bun test src/shared/stremio.test.ts`

Expected: FAIL because `sortStreamsByQuality` is not exported and `1440p` is not detected.

- [ ] **Step 3: Implement minimum pure helpers**

Export `QualityOrder`, recognize common numeric resolutions plus `4K`, and sort a copied array:

```ts
export type QualityOrder = "highest" | "lowest";

export function sortStreamsByQuality<T extends { quality: string }>(
    streams: T[],
    order: QualityOrder
): T[] {
    return [...streams].sort((a, b) => {
        const left = qualityHeight(a.quality);
        const right = qualityHeight(b.quality);
        if (left === null) return right === null ? 0 : 1;
        if (right === null) return -1;
        return order === "highest" ? right - left : left - right;
    });
}
```

Update the existing metadata regex so quality continues to be extracted from the combined addon name, title, and description, including `1440p`, `576p`, `360p`, and `240p`.

- [ ] **Step 4: Run the focused test and verify success**

Run: `bun test src/shared/stremio.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Add the in-place stream toggle**

In `renderStreams`, initialize `let qualityOrder: QualityOrder = "highest"`, create one button labeled `Highest First`, and render rows from `sortStreamsByQuality(streams, qualityOrder)`. On click, flip the value, update the label, and replace only the list rows.

- [ ] **Step 6: Style the toggle**

Add a compact right-aligned `.stream-sort` control using the existing sidebar surface, border, focus, and accent variables. Keep a visible focus outline and a minimum 11px label.

- [ ] **Step 7: Run complete verification**

Run:

```bash
bun test
bun run typecheck
bun run package
bun run verify:built-client-version
git diff --check
```

Expected: 0 test failures, 0 type errors, successful package build, matching client version, and no whitespace errors.

- [ ] **Step 8: Commit the implementation**

Before committing, verify `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` both report `Justaway41 <kritarthasapkota999@gmail.com>`.

```bash
git add src/shared/stremio.ts src/shared/stremio.test.ts src/ui/app.ts \
  xyz.brbc.popcorn.iinaplugin/ui/sidebar.css
git commit -m "feat: sort streams by quality"
```
