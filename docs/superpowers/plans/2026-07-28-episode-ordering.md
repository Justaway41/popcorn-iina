# Serial Episode Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep episodes in serial order while allowing users to reverse the complete season/episode sequence with a remembered Oldest First/Newest First control.

**Architecture:** Add an `EpisodeOrder` value and pure parser/sorter beside the existing episode model. Pass the stored value through the existing sidebar configuration channel, persist changes through one new message, and re-render the already-loaded episode list without another network request.

**Tech Stack:** TypeScript, Bun tests/build, IINA preferences and sidebar messaging, existing HTML/CSS.

## Global Constraints

- Default order is `oldest`.
- Sorting uses season number first and episode number second.
- Watched state never affects ordering.
- Invalid stored values fall back to `oldest`.
- No episode search, filters, per-show preference, dependency, or unrelated refactor.
- Before every commit, verify author and committer are `Justaway41 <kritarthasapkota999@gmail.com>`.

---

### Task 1: Persisted Serial Episode Order

**Files:**
- Modify: `src/shared/stremio.ts`
- Modify: `src/shared/stremio.test.ts`
- Modify: `src/shared/messages.ts`
- Modify: `src/plugin/main.ts`
- Modify: `src/ui/app.ts`
- Modify: `src/ui/app.test.ts`
- Modify: `xyz.brbc.popcorn.iinaplugin/Info.json`
- Modify: `xyz.brbc.popcorn.iinaplugin/ui/sidebar.css`

**Interfaces:**
- Produces: `type EpisodeOrder = "oldest" | "newest"`
- Produces: `parseEpisodeOrder(value: unknown): EpisodeOrder`
- Produces: `sortEpisodes(episodes: Episode[], order: EpisodeOrder): Episode[]`
- Extends: `ConfigurationPayload` with `episodeOrder: EpisodeOrder`
- Produces: `SetEpisodeOrderPayload` with `episodeOrder: EpisodeOrder`
- Adds: `MESSAGE_NAMES.SetEpisodeOrder`

- [ ] **Step 1: Write failing parser and ordering tests**

Add to `src/shared/stremio.test.ts`:

```ts
test("restores only supported episode order preferences", () => {
    expect(parseEpisodeOrder("newest")).toBe("newest");
    expect(parseEpisodeOrder("oldest")).toBe("oldest");
    expect(parseEpisodeOrder("unwatched")).toBe("oldest");
    expect(parseEpisodeOrder(null)).toBe("oldest");
});

test("sorts episodes serially in either direction", () => {
    const values = [
        episode("s2e1", 2, 1),
        episode("s1e2", 1, 2),
        episode("s1e1", 1, 1)
    ];
    expect(sortEpisodes(values, "oldest").map((item) => item.id))
        .toEqual(["s1e1", "s1e2", "s2e1"]);
    expect(sortEpisodes(values, "newest").map((item) => item.id))
        .toEqual(["s2e1", "s1e2", "s1e1"]);
    expect(values.map((item) => item.id)).toEqual(["s2e1", "s1e2", "s1e1"]);
});
```

Import `parseEpisodeOrder` and `sortEpisodes` from `./stremio`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test src/shared/stremio.test.ts
```

Expected: FAIL because `parseEpisodeOrder` and `sortEpisodes` are not exported.

- [ ] **Step 3: Implement the pure order model**

Add to `src/shared/stremio.ts`:

```ts
export type EpisodeOrder = "oldest" | "newest";

export function parseEpisodeOrder(value: unknown): EpisodeOrder {
    return value === "newest" ? "newest" : "oldest";
}

export function sortEpisodes(episodes: Episode[], order: EpisodeOrder): Episode[] {
    const direction = order === "newest" ? -1 : 1;
    return [...episodes].sort((a, b) =>
        direction * (a.season - b.season || a.episode - b.episode)
    );
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
bun test src/shared/stremio.test.ts
```

Expected: all tests in the file PASS.

- [ ] **Step 5: Write a failing UI-label test**

Import the not-yet-created `getEpisodeOrderLabel` from `src/ui/app.ts` and add to `src/ui/app.test.ts`:

```ts
test("labels both serial episode orders", () => {
    expect(getEpisodeOrderLabel("oldest")).toBe("Oldest First");
    expect(getEpisodeOrderLabel("newest")).toBe("Newest First");
});
```

- [ ] **Step 6: Run the UI test and verify RED**

Run:

```bash
bun test src/ui/app.test.ts
```

Expected: FAIL because `getEpisodeOrderLabel` is not exported.

- [ ] **Step 7: Wire the preference and local re-render**

Make these minimal changes:

1. In `src/shared/messages.ts`, add `SetEpisodeOrder`, include `episodeOrder` in `ConfigurationPayload`, and add:

```ts
export interface SetEpisodeOrderPayload {
    episodeOrder: EpisodeOrder;
}
```

2. In `xyz.brbc.popcorn.iinaplugin/Info.json`, add:

```json
"episodeOrder": "oldest"
```

3. In `src/plugin/main.ts`, include the parsed preference in configuration and persist the new message:

```ts
sidebar.onMessage(MESSAGE_NAMES.SetEpisodeOrder, (data) => {
    preferences.set(
        "episodeOrder",
        parseEpisodeOrder((data as SetEpisodeOrderPayload)?.episodeOrder)
    );
    preferences.sync();
});
```

4. In `src/ui/app.ts`, store `episodeOrder`, parse it in `applyConfiguration`, and export:

```ts
export function getEpisodeOrderLabel(order: EpisodeOrder): string {
    return order === "newest" ? "Newest First" : "Oldest First";
}
```

5. At the top of `renderEpisodes`, render a two-button `episode-order` segmented control. The active button reflects `episodeOrder`. Clicking a different button updates `episodeOrder`, posts `SetEpisodeOrder`, and calls `renderEpisodes(media, episodes)` using the already-loaded array.

6. Build seasons from `sortEpisodes(episodes, episodeOrder)`. Iterate the season map in insertion order and do not sort `values` again; the pure helper has already established the complete serial direction.

7. In `sidebar.css`, style `.episode-order` by reusing the visual dimensions and active-state colors of `.type-switch`, keeping the control compact and keyboard-focus visible.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
bun test src/shared/stremio.test.ts src/ui/app.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 9: Run full verification**

Run:

```bash
bun test
bun run typecheck
bun run build
bun run verify:built-client-version
git diff --check
```

Expected: 0 test failures, both TypeScript targets pass, build exits 0, client version is found, and diff check is clean.

- [ ] **Step 10: Verify identity and commit**

Run:

```bash
git config user.name
git config user.email
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
```

Expected: author and committer are `Justaway41 <kritarthasapkota999@gmail.com>`.

Then commit only the listed source, test, manifest, and CSS files:

```bash
git add src/shared/stremio.ts src/shared/stremio.test.ts src/shared/messages.ts src/plugin/main.ts src/ui/app.ts src/ui/app.test.ts xyz.brbc.popcorn.iinaplugin/Info.json xyz.brbc.popcorn.iinaplugin/ui/sidebar.css
git commit -m "feat: add serial episode ordering"
```

- [ ] **Step 11: Package for local IINA testing**

Run:

```bash
bun run package
```

Expected: `xyz.brbc.popcorn.iinaplugin.iinaplgz` is rebuilt successfully and the local development symlink still targets this checkout.
