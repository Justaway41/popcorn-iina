# CrossWatch Scrobble Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Popcorn post playback events to a self-hosted CrossWatch instance as a Jellyfin-shaped webhook, so CrossWatch can hold the single Trakt connection that a free Trakt account now allows.

**Architecture:** A pure shared module builds and sends the payload; a thin IINA client reads preferences and swallows failures; the one existing scrobble funnel in `src/plugin/main.ts` fans out to both the Trakt client and the new CrossWatch client. The Trakt integration is untouched — both targets run side by side, each enabled by its own configuration being present.

**Tech Stack:** TypeScript, IINA plugin APIs (`http`, `preferences`), browser DOM for the preferences page, Bun test runner, Bun bundler.

Design spec: `docs/superpowers/specs/2026-08-12-crosswatch-scrobble-design.md`

## Global Constraints

- Add no dependency.
- Never hand-edit `dist/` or `ui/dist/`. Regenerate with `bun run build` or `bun run package`.
- Do not add repeating JavaScript timers (`setInterval`) to plugin runtime entries. The existing `updatePlaybackMonitoring` tick is the only clock.
- The CrossWatch webhook token is a credential. Never log it, never place it in an error message, never commit it to a fixture, doc, or test.
- A scrobble failure must never interrupt playback.
- Before every commit, verify both git identities are exactly `Justaway41 <kritarthasapkota999@gmail.com>`.
- Never add Claude, Codex, Cursor, or any AI identity as author, committer, or co-author.
- Stage only files belonging to the current task. Six untracked files under `docs/superpowers/` are user-owned — never stage, rewrite, or delete them.
- Do not push, tag, or create a release.

---

### Task 1: Pure CrossWatch payload module

**Files:**
- Create: `src/shared/crosswatch.ts`
- Create: `src/shared/crosswatch.test.ts`
- Modify: `src/shared/stremio.ts:550`

**Interfaces:**
- Consumes: `PlaybackContext` from `src/shared/messages.ts`; `isImdbId` and `releaseYear` from `src/shared/stremio.ts`; `TraktScrobbleAction` and `TraktTransport` types from `src/shared/trakt.ts`.
- Produces:
  - `interface CrossWatchState { url: string; token: string; username: string }`
  - `parseCrossWatchState(value: unknown): CrossWatchState`
  - `isCrossWatchConfigured(state: CrossWatchState): boolean`
  - `buildJellyfinPayload(action: TraktScrobbleAction, context: PlaybackContext, percent: number, username?: string): Record<string, unknown> | null`
  - `sendCrossWatchPlayback(transport: HttpTransport, state: CrossWatchState, action: TraktScrobbleAction, context: PlaybackContext, percent: number): Promise<void>`

- [ ] **Step 1: Export the existing year helper**

`releaseYear` already exists in `src/shared/stremio.ts:550` and is exactly the parse the movie payload needs. Add `export` rather than writing a second copy.

```ts
export function releaseYear(value: string): string {
    return value.match(/\b\d{4}\b/)?.[0] || "";
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/shared/crosswatch.test.ts`:

```ts
import { expect, test } from "bun:test";

import type { PlaybackContext } from "./messages";

import {
    buildJellyfinPayload,
    isCrossWatchConfigured,
    parseCrossWatchState,
    sendCrossWatchPlayback
} from "./crosswatch";

const movie = {
    id: "tt0145487",
    imdbId: "tt0145487",
    type: "movie" as const,
    name: "Spider-Man",
    releaseInfo: "2002",
    poster: "poster.jpg"
};

const series = {
    id: "tt5753856",
    imdbId: "tt5753856",
    type: "series" as const,
    name: "Dark",
    releaseInfo: "2017-2020",
    poster: "poster.jpg"
};

const episode = {
    id: "tt5753856:3:4",
    name: "The Travellers",
    season: 3,
    episode: 4,
    aired: "2020-06-27",
    description: "",
    thumbnail: ""
};

test("parses stored state defensively", () => {
    expect(parseCrossWatchState(null)).toEqual({ url: "", token: "", username: "popcorn" });
    expect(parseCrossWatchState("http://box:8787")).toEqual({ url: "", token: "", username: "popcorn" });
    expect(parseCrossWatchState({ url: 7, token: [], username: null }))
        .toEqual({ url: "", token: "", username: "popcorn" });
    expect(parseCrossWatchState({ url: " http://box:8787/// ", token: " abc ", username: " me " }))
        .toEqual({ url: "http://box:8787", token: "abc", username: "me" });
});

test("requires both a url and a token to be configured", () => {
    expect(isCrossWatchConfigured({ url: "", token: "abc", username: "popcorn" })).toBe(false);
    expect(isCrossWatchConfigured({ url: "http://box:8787", token: "", username: "popcorn" })).toBe(false);
    expect(isCrossWatchConfigured({ url: "http://box:8787", token: "abc", username: "popcorn" })).toBe(true);
});

test("builds a movie payload with the release year", () => {
    const context: PlaybackContext = { media: movie, episodes: [] };
    expect(buildJellyfinPayload("start", context, 12.5)).toEqual({
        NotificationType: "PlaybackStart",
        NotificationUsername: "popcorn",
        Progress: 12.5,
        Item: {
            Type: "Movie",
            Name: "Spider-Man",
            ProductionYear: 2002,
            ProviderIds: { Imdb: "tt0145487" }
        }
    });
});

test("omits the production year when the release info carries none", () => {
    const context: PlaybackContext = {
        media: { ...movie, releaseInfo: "" },
        episodes: []
    };
    const payload = buildJellyfinPayload("start", context, 1);
    expect((payload?.Item as Record<string, unknown>).ProductionYear).toBeUndefined();
});

test("puts the series id in SeriesProviderIds and never in ProviderIds", () => {
    const context: PlaybackContext = { media: series, episode, episodes: [episode] };
    const payload = buildJellyfinPayload("pause", context, 44);
    const item = payload?.Item as Record<string, unknown>;

    expect(item.SeriesProviderIds).toEqual({ Imdb: "tt5753856" });
    expect(item.ProviderIds).toBeUndefined();
    expect(item).toMatchObject({
        Type: "Episode",
        SeriesName: "Dark",
        Name: "The Travellers",
        ParentIndexNumber: 3,
        IndexNumber: 4
    });
});

test("maps every scrobble action", () => {
    const context: PlaybackContext = { media: movie, episodes: [] };
    expect(buildJellyfinPayload("start", context, 0)?.NotificationType).toBe("PlaybackStart");
    expect(buildJellyfinPayload("pause", context, 0)?.NotificationType).toBe("PlaybackPause");
    expect(buildJellyfinPayload("stop", context, 0)?.NotificationType).toBe("PlaybackStop");
});

test("clamps progress and rejects unusable input", () => {
    const context: PlaybackContext = { media: movie, episodes: [] };
    expect(buildJellyfinPayload("start", context, -5)?.Progress).toBe(0);
    expect(buildJellyfinPayload("start", context, 140)?.Progress).toBe(100);
    expect(buildJellyfinPayload("start", context, 33.333)?.Progress).toBe(33.33);
    expect(buildJellyfinPayload("start", context, Number.NaN)).toBeNull();
});

test("returns null when the media has no imdb id", () => {
    const context: PlaybackContext = {
        media: { ...movie, imdbId: "kitsu:123" },
        episodes: []
    };
    expect(buildJellyfinPayload("start", context, 10)).toBeNull();
});

test("posts to the jellyfin webhook with the token in the query string", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const transport = async (
        _method: "GET" | "POST",
        url: string,
        body: unknown,
        headers: Record<string, string>
    ) => {
        calls.push({ url, body, headers });
        return { status: 200, data: null, headers: {} };
    };
    const state = { url: "http://box:8787", token: "a b", username: "popcorn" };

    await sendCrossWatchPlayback(transport, state, "start", { media: movie, episodes: [] }, 5);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://box:8787/webhook/jellyfin?token=a%20b");
    expect(calls[0].headers).toEqual({ "Content-Type": "application/json" });
});

test("sends nothing when unconfigured or when the payload cannot be built", async () => {
    let called = 0;
    const transport = async () => {
        called += 1;
        return { status: 200, data: null, headers: {} };
    };
    const context: PlaybackContext = { media: movie, episodes: [] };

    await sendCrossWatchPlayback(transport, parseCrossWatchState(null), "start", context, 5);
    await sendCrossWatchPlayback(
        transport,
        { url: "http://box:8787", token: "abc", username: "popcorn" },
        "start",
        { media: { ...movie, imdbId: "" }, episodes: [] },
        5
    );

    expect(called).toBe(0);
});

test("throws without leaking the token when the webhook rejects", async () => {
    const transport = async () => ({ status: 401, data: null, headers: {} });
    const state = { url: "http://box:8787", token: "secret-token", username: "popcorn" };

    const error = await sendCrossWatchPlayback(
        transport,
        state,
        "start",
        { media: movie, episodes: [] },
        5
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("secret-token");
    expect((error as Error).message).toContain("401");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/shared/crosswatch.test.ts`
Expected: FAIL, because `src/shared/crosswatch.ts` does not exist.

- [ ] **Step 4: Implement the module**

Create `src/shared/crosswatch.ts`:

```ts
import type { PlaybackContext } from "./messages";
import { isImdbId, releaseYear } from "./stremio";
import type { TraktScrobbleAction, TraktTransport as HttpTransport } from "./trakt";

export interface CrossWatchState {
    /** Base URL of the CrossWatch instance, without a trailing slash. */
    url: string;
    /** Webhook token from CrossWatch's `/api/webhooks/urls`. Never log this. */
    token: string;
    username: string;
}

const DEFAULT_USERNAME = "popcorn";

const NOTIFICATION_TYPES: Record<TraktScrobbleAction, string> = {
    start: "PlaybackStart",
    pause: "PlaybackPause",
    stop: "PlaybackStop"
};

export function parseCrossWatchState(value: unknown): CrossWatchState {
    const record = value && typeof value === "object"
        ? value as Record<string, unknown>
        : {};
    return {
        url: text(record.url).replace(/\/+$/, ""),
        token: text(record.token),
        username: text(record.username) || DEFAULT_USERNAME
    };
}

export function isCrossWatchConfigured(state: CrossWatchState): boolean {
    return state.url !== "" && state.token !== "";
}

export function buildJellyfinPayload(
    action: TraktScrobbleAction,
    context: PlaybackContext,
    percent: number,
    username = DEFAULT_USERNAME
): Record<string, unknown> | null {
    const imdbId = context.media.imdbId;
    if (!isImdbId(imdbId) || !Number.isFinite(percent)) return null;
    return {
        NotificationType: NOTIFICATION_TYPES[action],
        NotificationUsername: username,
        Progress: clampPercent(percent),
        Item: context.episode
            ? episodeItem(context, imdbId)
            : movieItem(context, imdbId)
    };
}

export async function sendCrossWatchPlayback(
    transport: HttpTransport,
    state: CrossWatchState,
    action: TraktScrobbleAction,
    context: PlaybackContext,
    percent: number
): Promise<void> {
    if (!isCrossWatchConfigured(state)) return;
    const payload = buildJellyfinPayload(action, context, percent, state.username);
    if (!payload) return;
    const response = await transport(
        "POST",
        `${state.url}/webhook/jellyfin?token=${encodeURIComponent(state.token)}`,
        payload,
        { "Content-Type": "application/json" }
    );
    if (response.status < 200 || response.status >= 300) {
        // The token rides in the URL, so the URL must never reach the message.
        throw new Error(`CrossWatch webhook failed with status ${response.status}.`);
    }
}

/**
 * Popcorn only ever holds a series-level id, and CrossWatch merges episode ids over
 * series ids, so this must stay in `SeriesProviderIds` — an id in `ProviderIds` is
 * read as an episode id and resolves to the wrong thing or to nothing.
 */
function episodeItem(context: PlaybackContext, imdbId: string): Record<string, unknown> {
    return {
        Type: "Episode",
        SeriesName: context.media.name,
        Name: context.episode?.name || "",
        ParentIndexNumber: context.episode?.season,
        IndexNumber: context.episode?.episode,
        SeriesProviderIds: { Imdb: imdbId }
    };
}

function movieItem(context: PlaybackContext, imdbId: string): Record<string, unknown> {
    const year = Number(releaseYear(context.media.releaseInfo));
    return {
        Type: "Movie",
        Name: context.media.name,
        ...(year ? { ProductionYear: year } : {}),
        ProviderIds: { Imdb: imdbId }
    };
}

function clampPercent(percent: number): number {
    return Math.round(Math.max(0, Math.min(100, percent)) * 100) / 100;
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/shared/crosswatch.test.ts`
Expected: PASS, all eleven tests.

- [ ] **Step 6: Verify nothing else broke**

Run: `bun test && bun run typecheck`
Expected: the whole suite passes and both TypeScript projects compile.

- [ ] **Step 7: Commit**

```bash
git add src/shared/crosswatch.ts src/shared/crosswatch.test.ts src/shared/stremio.ts
git commit -m "feat: add CrossWatch jellyfin webhook payload module"
```

---

### Task 2: IINA client and scrobble fan-out

**Files:**
- Create: `src/plugin/crosswatch.ts`
- Modify: `src/plugin/main.ts:38`, `:52`, `:67`, `:138`, `:161-166`, `:174`, `:220`, `:677`, `:693`, `:702`, `:716`

**Interfaces:**
- Consumes: `parseCrossWatchState` and `sendCrossWatchPlayback` from Task 1; `createIinaTransport` already exported from `src/plugin/trakt.ts:11`.
- Produces: `createIinaCrossWatchClient(http, preferences, onError): IinaCrossWatchClient` with a single method `sendPlayback(action: TraktScrobbleAction, context: PlaybackContext, percent: number): Promise<void>`.

There is no unit test for this task. It is IINA glue with no logic of its own — all behaviour lives in the pure module from Task 1, and the plugin runtime cannot be exercised headlessly. `bun run typecheck` plus the manual checks in Task 4 are the gate.

- [ ] **Step 1: Create the client**

Create `src/plugin/crosswatch.ts`:

```ts
import { parseCrossWatchState, sendCrossWatchPlayback } from "../shared/crosswatch";
import type { PlaybackContext } from "../shared/messages";
import type { TraktScrobbleAction } from "../shared/trakt";
import { createIinaTransport } from "./trakt";

export interface IinaCrossWatchClient {
    sendPlayback(
        action: TraktScrobbleAction,
        context: PlaybackContext,
        percent: number
    ): Promise<void>;
}

export function createIinaCrossWatchClient(
    http: IINA.API.HTTP,
    preferences: IINA.API.Preferences,
    onError: (error: unknown) => void
): IinaCrossWatchClient {
    const transport = createIinaTransport(http);

    return {
        // No queue and no state writes: unlike Trakt there are no tokens to refresh,
        // so each call is independent and a failure is dropped rather than retried.
        async sendPlayback(action, context, percent) {
            const state = parseCrossWatchState(preferences.get("crosswatch"));
            try {
                await sendCrossWatchPlayback(transport, state, action, context, percent);
            } catch (error) {
                onError(error);
            }
        }
    };
}
```

- [ ] **Step 2: Construct the client in `main.ts`**

Add the import beside the existing Trakt import at `src/plugin/main.ts:38`:

```ts
import { createIinaCrossWatchClient } from "./crosswatch";
import { createIinaTraktClient } from "./trakt";
```

Then add the client immediately after the Trakt client at `:52`:

```ts
const trakt = createIinaTraktClient(http, preferences, (error) => {
    logDebug("Popcorn: Trakt request failed:", formatError(error));
});
const crosswatch = createIinaCrossWatchClient(http, preferences, (error) => {
    logDebug("Popcorn: CrossWatch request failed:", formatError(error));
});
```

`formatError` never receives the URL, because `sendCrossWatchPlayback` throws a message carrying only the status code.

- [ ] **Step 3: Rename the funnel and fan out**

Replace the function at `src/plugin/main.ts:161-166` with:

```ts
function sendScrobble(action: TraktScrobbleAction, percent: number): void {
    const context = activePlaybackContext;
    if (!context || !Number.isFinite(percent) || scrobbleStopSent) return;
    if (action === "stop") scrobbleStopSent = true;
    void trakt.sendPlayback(action, context, percent);
    void crosswatch.sendPlayback(action, context, percent);
}
```

- [ ] **Step 4: Rename every remaining reference**

Rename the declaration `let traktStopSent = false;` at `:67` to `let scrobbleStopSent = false;`, then update all remaining occurrences.

```bash
grep -n "traktStopSent\|sendTrakt" src/plugin/main.ts
```

Expected before editing: `traktStopSent` at lines 67, 138, 220, 677, 716 (line 163 and 164 were already handled in Step 3), and `sendTrakt` at lines 139, 174, 693, 702.

Rename `traktStopSent` → `scrobbleStopSent` and `sendTrakt` → `sendScrobble` at each. Do not touch `trakt.sendPlayback`, `trakt.sync`, `createIinaTraktClient`, or `TraktScrobbleAction` — those still belong to the Trakt client.

- [ ] **Step 5: Verify no stale references remain**

```bash
grep -n "traktStopSent\|sendTrakt(" src/plugin/main.ts
```

Expected: no output.

- [ ] **Step 6: Verify compilation**

Run: `bun test && bun run typecheck`
Expected: the suite passes and both TypeScript projects compile.

- [ ] **Step 7: Commit**

```bash
git add src/plugin/crosswatch.ts src/plugin/main.ts
git commit -m "feat: send playback events to CrossWatch alongside Trakt"
```

---

### Task 3: Preferences

**Files:**
- Modify: `Info.json:24`
- Modify: `ui/preferences.html:119`
- Modify: `src/ui/preferences.ts:62`, `:100`, `:109-114`

**Interfaces:**
- Consumes: `parseCrossWatchState` and `CrossWatchState` from Task 1.
- Produces: the preference key `crosswatch`, holding `{ url, token, username }`, which the client in Task 2 reads at every scrobble.

No migration is needed. The key is new, and `parseCrossWatchState` treats a missing or malformed value as unconfigured.

- [ ] **Step 1: Add the preference default**

In `Info.json`, add `crosswatch` to `preferenceDefaults`:

```json
  "preferenceDefaults": {
    "addonManifestUrl": "",
    "addons": [],
    "mediaType": "movie",
    "episodeOrder": "oldest",
    "watchHistory": [],
    "trakt": {},
    "skipSegments": true,
    "crosswatch": {}
  },
```

There is one `Info.json`, at the repository root.

- [ ] **Step 2: Add the preferences section**

In `ui/preferences.html`, insert this section immediately after the closing `</section>` of `.trakt-section` (currently line 119) and before `<template id="addon-row-template">`:

```html
    <section class="pref-section trakt-section" aria-labelledby="crosswatch-heading">
        <h3 id="crosswatch-heading">CrossWatch</h3>
        <p class="small secondary pref-help">
            Send playback events to a self-hosted CrossWatch instance on your network, so it can
            hold the single Trakt connection a free Trakt account allows. Leave the URL empty to
            send nothing. Popcorn appears to CrossWatch as a Jellyfin webhook source, so leave that
            source's library whitelist empty in CrossWatch.
        </p>
        <label for="crosswatch-url">CrossWatch URL</label>
        <input id="crosswatch-url" type="text" autocomplete="off" spellcheck="false"
               placeholder="http://192.168.1.10:8787">
        <label for="crosswatch-token">Webhook token</label>
        <input id="crosswatch-token" type="password" autocomplete="off" spellcheck="false">
        <label for="crosswatch-username">Username reported to CrossWatch</label>
        <input id="crosswatch-username" type="text" autocomplete="off" spellcheck="false"
               placeholder="popcorn">
    </section>
```

The section reuses the `trakt-section` class for its grid layout rather than adding a duplicate rule, and the token uses `type="password"` exactly as `#trakt-client-secret` does.

- [ ] **Step 3: Wire the fields**

In `src/ui/preferences.ts`, add the import beside the existing shared imports:

```ts
import { parseCrossWatchState } from "../shared/crosswatch";
```

Add the element references after `traktError` at `:62`:

```ts
const crosswatchUrl = element<HTMLInputElement>("crosswatch-url");
const crosswatchToken = element<HTMLInputElement>("crosswatch-token");
const crosswatchUsername = element<HTMLInputElement>("crosswatch-username");
```

Add the change handlers after the `skipSegments` handler at `:104`:

```ts
[crosswatchUrl, crosswatchToken, crosswatchUsername].forEach((field) => {
    field.addEventListener("change", saveCrossWatch);
});
```

Add this function beside `saveTraktCredentials`:

```ts
function saveCrossWatch(): void {
    preferences.set("crosswatch", parseCrossWatchState({
        url: crosswatchUrl.value,
        token: crosswatchToken.value,
        username: crosswatchUsername.value
    }));
}
```

Routing the write through `parseCrossWatchState` means trimming and trailing-slash removal happen once, in the module that already has tests for them.

- [ ] **Step 4: Load the stored values**

Extend the batch in `loadPreferences` at `:109-114`:

```ts
    const [stored, legacy, storedTrakt, storedSkipSegments, storedCrossWatch] = await Promise.all([
        getPreference("addons"),
        getPreference("addonManifestUrl"),
        getPreference("trakt"),
        getPreference("skipSegments"),
        getPreference("crosswatch")
    ]);
```

Then set the fields beside the existing Trakt assignments at `:119-120`:

```ts
    const crosswatch = parseCrossWatchState(storedCrossWatch);
    crosswatchUrl.value = crosswatch.url;
    crosswatchToken.value = crosswatch.token;
    crosswatchUsername.value = crosswatch.username;
```

- [ ] **Step 5: Verify compilation and the manifest**

Run: `bun test && bun run typecheck && bun run build && bun run verify:root-info`
Expected: all pass, and `verify:root-info` reports the manifest is directly installable.

- [ ] **Step 6: Commit**

```bash
git add Info.json ui/preferences.html src/ui/preferences.ts dist ui/dist
git commit -m "feat: add CrossWatch preferences"
```

---

### Task 4: Full verification and manual IINA checks

**Files:** none created or modified beyond regenerated bundles.

- [ ] **Step 1: Run the full source chain**

```bash
bun test
bun run typecheck
git diff --check
```

Expected: zero failures and no whitespace errors.

- [ ] **Step 2: Build and package**

```bash
bun run package
bun run verify:root-info
bun run verify:built-client-version
unzip -t xyz.brbc.popcorn.iinaplugin.iinaplgz
```

Expected: the archive builds and passes integrity testing. `bun run package` regenerates `dist/` and `ui/dist/`; if those tracked bundles changed, commit them.

- [ ] **Step 3: Confirm the token never reaches a log**

```bash
grep -rn "crosswatch" src/plugin src/shared --include=*.ts | grep -i "log\|osd\|ask"
```

Expected: no output. The only logging path is `logDebug("Popcorn: CrossWatch request failed:", formatError(error))` in `main.ts`, whose error message carries a status code and nothing else.

- [ ] **Step 4: Manual checks in IINA**

These are the only checks that prove the integration; headless tests cannot see mpv or WebKit. Requires a running CrossWatch instance with Trakt connected and an empty Jellyfin scrobble library whitelist.

1. Configure the CrossWatch URL and token, play a movie → CrossWatch's `SCROBBLE` log shows the incoming event, and Trakt shows the play
2. Play an episode → the correct season and episode reach Trakt, not a mismatched title
3. Pause, then resume → CrossWatch reports a pause and then a start, not a completion
4. Watch past the completion threshold → Trakt marks it watched
5. Clear the CrossWatch URL → no outbound request at all
6. Stop the CrossWatch container mid-playback → playback is unaffected, and the debug log shows a status code with no token in it
7. Trakt configured **and** CrossWatch configured → both receive the events
8. Play something with no IMDb id → no request attempted

- [ ] **Step 5: Commit any regenerated bundles**

```bash
git status --porcelain
```

If `dist/` or `ui/dist/` changed:

```bash
git add dist ui/dist
git commit -m "chore: rebuild bundles for CrossWatch scrobbling"
```

The six untracked files under `docs/superpowers/` are user-owned. Leave them alone.
