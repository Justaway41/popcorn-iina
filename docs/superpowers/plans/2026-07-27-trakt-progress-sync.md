# Trakt Progress Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional Trakt authentication, cross-device playback progress, watched-history synchronization, and automatic resume while retaining local offline tracking.

**Architecture:** Extend the existing local history entry with exact progress and keep it as the UI's immediate source. Put defensive Trakt parsing, payload construction, merge rules, and transport-independent API operations in `src/shared/trakt.ts`; adapt browser `fetch` in Preferences and IINA's native `http` module in the plugin runtime. Playback always updates locally first, while Trakt scrobbles and sync run asynchronously.

**Tech Stack:** TypeScript, Bun tests, browser DOM/fetch, IINA JavaScript Plugin API, Trakt API v2, Cinemeta/Stremio identifiers.

## Global Constraints

- Add no runtime dependency.
- Playback and local history must work when Trakt is disconnected or unavailable.
- Users provide their own Trakt Client ID and Client Secret; no hosted proxy or bundled shared credentials.
- Store Trakt state locally in IINA plugin preferences under one JSON key, `trakt`.
- Movies use IMDb IDs; episodes use the show's IMDb ID plus season and episode numbers.
- Preserve the existing 90 percent watched threshold.
- Trakt requests must never delay stream loading or interrupt playback.
- Respect device-code polling interval, device-code expiry, token expiry, and `Retry-After`.
- Before every commit or push, verify author and committer are `Justaway41 <kritarthasapkota999@gmail.com>`.

---

## File Map

- Modify `src/shared/history.ts`: exact local progress, legacy migration, and merge-safe history parsing.
- Modify `src/shared/history.test.ts`: progress persistence and legacy-entry coverage.
- Modify `src/shared/messages.ts`: carry an optional resume percentage to the plugin runtime.
- Modify `src/plugin/playback.ts`: pure progress-save timing helper; remove obsolete milestone logic.
- Modify `src/plugin/playback.test.ts`: timing, watched threshold, and resume tests.
- Modify `src/plugin/constants.ts`: 30-second local progress interval.
- Modify `src/plugin/main.ts`: local checkpoints, automatic resume, pause/resume/end events, background Trakt integration.
- Modify `src/shared/stremio.ts`: poster fallback URL for Trakt-only IMDb entries.
- Modify `src/shared/stremio.test.ts`: poster fallback URL coverage.
- Modify `src/ui/app.ts`: progress bars and resume value selection.
- Modify `src/ui/app.test.ts`: progress-display helper coverage.
- Modify `xyz.brbc.popcorn.iinaplugin/ui/sidebar.css`: compact poster progress bar.
- Create `src/shared/trakt.ts`: Trakt state parsing, request protocol, OAuth, scrobble payloads, remote-history parsing, merging, and sync.
- Create `src/shared/trakt.test.ts`: pure Trakt behavior and mocked-transport tests.
- Modify `src/ui/preferences.ts`: Trakt credentials, device authorization, manual sync, and disconnect.
- Modify `xyz.brbc.popcorn.iinaplugin/ui/preferences.html`: Trakt preferences controls and status.
- Modify `xyz.brbc.popcorn.iinaplugin/Info.json`: `trakt` preference default.
- Create `src/plugin/trakt.ts`: IINA HTTP adapter and preference-backed runtime client.
- Create `src/plugin/trakt.test.ts`: native adapter/result normalization tests.
- Modify `README.md`: user setup and behavior.

---

### Task 1: Persist Exact Local Progress

**Files:**
- Modify: `src/shared/history.ts`
- Modify: `src/shared/history.test.ts`

**Interfaces:**
- Produces: `WatchHistoryEntry.progress: number | null`
- Produces: `recordPlayback(entries, context, percent, playedAt): WatchHistoryEntry[]`
- Produces: `getHistoryEntry(entries, context): WatchHistoryEntry | null`
- Produces: `getResumePercent(progress, watched): number | null`

- [ ] **Step 1: Write failing progress and migration tests**

Add these assertions to `src/shared/history.test.ts`:

```ts
import {
    getHistoryEntry,
    getResumePercent,
    parseWatchHistory,
    recordPlayback
} from "./history";

test("stores exact progress and keeps watched state sticky", () => {
    const context: PlaybackContext = { media: movie, episodes: [] };
    const partial = recordPlayback([], context, 42.25, "partial");
    expect(partial[0]).toMatchObject({ progress: 42.25, watched: false });

    const watched = recordPlayback(partial, context, 95, "watched");
    const replayed = recordPlayback(watched, context, 12, "replayed");
    expect(replayed[0]).toMatchObject({
        progress: 12,
        watched: true,
        lastPlayedAt: "replayed"
    });
});

test("migrates legacy history without inventing unfinished progress", () => {
    const partial = {
        id: "tt1",
        media: movie,
        lastPlayedAt: "partial",
        watched: false
    };
    const watched = { ...partial, lastPlayedAt: "watched", watched: true };

    expect(parseWatchHistory([partial])[0].progress).toBeNull();
    expect(parseWatchHistory([watched])[0].progress).toBe(100);
});

test("finds movie and episode history by playback context", () => {
    const context: PlaybackContext = { media: movie, episodes: [] };
    const entries = recordPlayback([], context, 35, "now");
    expect(getHistoryEntry(entries, context)?.progress).toBe(35);
});

test("resumes only unfinished meaningful progress", () => {
    expect(getResumePercent(null, false)).toBeNull();
    expect(getResumePercent(4.9, false)).toBeNull();
    expect(getResumePercent(42.5, false)).toBe(42.5);
    expect(getResumePercent(90, false)).toBeNull();
    expect(getResumePercent(42.5, true)).toBeNull();
});
```

Update existing expected entries to include `progress: 5`, `progress: 90`, or
`progress: 100` as appropriate.

- [ ] **Step 2: Run the history tests and verify failure**

Run:

```bash
bun test src/shared/history.test.ts
```

Expected: FAIL because `progress` and `getHistoryEntry` do not exist.

- [ ] **Step 3: Implement exact progress and defensive migration**

In `src/shared/history.ts`, make the entry shape and parser explicit:

```ts
export interface WatchHistoryEntry {
    id: string;
    media: Media;
    episode?: Episode;
    lastPlayedAt: string;
    watched: boolean;
    progress: number | null;
}

export function getHistoryEntry(
    entries: WatchHistoryEntry[],
    context: PlaybackContext
): WatchHistoryEntry | null {
    const id = context.episode?.id || context.media.imdbId;
    return entries.find((entry) => entry.id === id) || null;
}

export function getResumePercent(progress: number | null, watched: boolean): number | null {
    return !watched && progress !== null && progress >= 5 && progress < 90
        ? progress
        : null;
}

function normalizeProgress(value: unknown, watched: boolean): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return watched ? 100 : null;
    }
    return Math.max(0, Math.min(100, value));
}
```

Update `recordPlayback` to retain the current 5 percent inclusion threshold,
clamp the stored progress, and preserve watched state:

```ts
const progress = Math.max(0, Math.min(100, percent));
const existing = entries.find((entry) => entry.id === id);
const entry: WatchHistoryEntry = {
    id,
    media: context.media,
    ...(context.episode ? { episode: context.episode } : {}),
    lastPlayedAt: playedAt,
    watched: Boolean(existing?.watched || progress >= 90),
    progress
};
```

In `parseEntry`, calculate `watched` once and add:

```ts
const watched = item?.watched;
if (typeof watched !== "boolean") return [];

return [{
    id,
    media,
    ...(episode ? { episode } : {}),
    lastPlayedAt,
    watched,
    progress: normalizeProgress(item.progress, watched)
}];
```

- [ ] **Step 4: Run history tests**

Run:

```bash
bun test src/shared/history.test.ts
```

Expected: all history tests PASS.

- [ ] **Step 5: Verify identity and commit**

Run:

```bash
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
```

Expected for both: `Justaway41 <kritarthasapkota999@gmail.com>`.

Then:

```bash
git add src/shared/history.ts src/shared/history.test.ts
git commit -m "feat: track exact local playback progress"
```

---

### Task 2: Show and Resume Local Progress

**Files:**
- Modify: `src/shared/messages.ts`
- Modify: `src/plugin/playback.ts`
- Modify: `src/plugin/playback.test.ts`
- Modify: `src/plugin/constants.ts`
- Modify: `src/plugin/main.ts`
- Modify: `src/shared/stremio.ts`
- Modify: `src/shared/stremio.test.ts`
- Modify: `src/ui/app.ts`
- Modify: `src/ui/app.test.ts`
- Modify: `xyz.brbc.popcorn.iinaplugin/ui/sidebar.css`

**Interfaces:**
- Consumes: `WatchHistoryEntry.progress`
- Produces: `PlayItemPayload.resumePercent?: number`
- Produces: `shouldSaveProgress(nowMs, lastSavedAtMs, intervalMs): boolean`
- Produces: `getProgressDisplay(progress, watched): { percent: number; label: string } | null`
- Produces: `buildCinemetaPosterUrl(imdbId): string`

- [ ] **Step 1: Write failing playback helper tests**

Add to `src/plugin/playback.test.ts`:

```ts
import {
    shouldOfferNextEpisode,
    shouldSaveProgress
} from "./playback";

test("saves local progress every 30 seconds", () => {
    expect(shouldSaveProgress(29_999, 0, 30_000)).toBe(false);
    expect(shouldSaveProgress(30_000, 0, 30_000)).toBe(true);
    expect(shouldSaveProgress(60_001, 30_001, 30_000)).toBe(true);
});
```

Add to `src/ui/app.test.ts`:

```ts
import {
    getAudioBadge,
    getProgressDisplay,
    getSubtitleBadge,
    replaceRequest
} from "./app";

test("shows progress only for unfinished entries with an exact position", () => {
    expect(getProgressDisplay(null, false)).toBeNull();
    expect(getProgressDisplay(42.25, false)).toEqual({ percent: 42, label: "42% watched" });
    expect(getProgressDisplay(95, true)).toBeNull();
});
```

Add to `src/shared/stremio.test.ts`:

```ts
test("builds a lazy poster fallback for an IMDb item", () => {
    expect(buildCinemetaPosterUrl("tt123")).toBe(
        "https://images.metahub.space/poster/medium/tt123/img"
    );
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
bun test src/plugin/playback.test.ts src/ui/app.test.ts
```

Expected: FAIL because the new helpers do not exist.

- [ ] **Step 3: Add pure save, resume, and display helpers**

In `src/plugin/playback.ts`:

```ts
export function shouldSaveProgress(
    nowMs: number,
    lastSavedAtMs: number,
    intervalMs: number
): boolean {
    return nowMs - lastSavedAtMs >= intervalMs;
}
```

Delete `getPlaybackMilestone` and its milestone test; exact periodic progress now
drives both recent and watched state through `recordPlayback`.

In `src/ui/app.ts`:

```ts
export function getProgressDisplay(
    progress: number | null,
    watched: boolean
): { percent: number; label: string } | null {
    if (watched || progress === null || progress < 5 || progress >= 90) return null;
    const percent = Math.round(progress);
    return { percent, label: `${percent}% watched` };
}
```

In `src/shared/stremio.ts`:

```ts
export function buildCinemetaPosterUrl(imdbId: string): string {
    return `https://images.metahub.space/poster/medium/${encodeURIComponent(imdbId)}/img`;
}
```

- [ ] **Step 4: Carry resume progress through stream selection**

In `src/shared/messages.ts`, extend the payload:

```ts
export interface PlayItemPayload {
    url: string;
    title: string;
    playbackContext: PlaybackContext;
    resumePercent?: number;
}
```

In `src/ui/app.ts`, import `getResumePercent` from `../shared/history` and add a
history lookup:

```ts
function getEntryProgress(id: string): number | null {
    const entry = watchHistory.find((item) => item.id === id);
    return entry ? getResumePercent(entry.progress, entry.watched) : null;
}
```

When posting `PlayItem`, use the selected movie or episode ID:

```ts
const resumePercent = getEntryProgress(episode?.id || media.imdbId);
iina.postMessage(MESSAGE_NAMES.PlayItem, {
    url: stream.url,
    title: episode ? formatEpisodeTitle(media, episode) : media.name,
    playbackContext: { media, ...(episode ? { episode } : {}), episodes },
    ...(resumePercent === null ? {} : { resumePercent })
});
```

- [ ] **Step 5: Render poster progress**

Extend `mediaCard` with an optional `progress` argument. Use
`media.poster || buildCinemetaPosterUrl(media.imdbId)` for the lazy image URL;
the existing one-time image error handler remains the fallback when no poster
exists. Inside `.poster`, append:

```ts
const progressDisplay = getProgressDisplay(progress, watched);
if (progressDisplay) {
    const track = document.createElement("span");
    track.className = "poster-progress";
    track.title = progressDisplay.label;
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(progressDisplay.percent));
    const fill = document.createElement("span");
    fill.style.width = `${progressDisplay.percent}%`;
    track.appendChild(fill);
    poster.appendChild(track);
}
```

Pass `entry.progress` from `historySection` and `null` from ordinary catalog
cards.

Add to `xyz.brbc.popcorn.iinaplugin/ui/sidebar.css`:

```css
.poster-progress {
    position: absolute;
    right: 5px;
    bottom: 5px;
    left: 5px;
    height: 3px;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(0, 0, 0, .55);
}
.poster-progress > span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
}
```

- [ ] **Step 6: Save locally every 30 seconds and seek after load**

In `src/plugin/constants.ts`, add:

```ts
export const PROGRESS_SAVE_INTERVAL_MS = 30_000;
```

In `src/plugin/main.ts`:

- add `pendingResumePercent: number | null`
- add `lastProgressSavedAt = 0`
- read `payload.resumePercent` in `playItem`
- after the non-splash `mpv.file-loaded` branch, run:

```ts
if (pendingResumePercent !== null) {
    mpv.command("seek", [String(pendingResumePercent), "absolute-percent+exact"]);
    pendingResumePercent = null;
}
```

Replace milestone-only persistence with a local checkpoint function:

```ts
function savePlaybackProgress(percent = mpv.getNumber("percent-pos")): void {
    const context = activePlaybackContext;
    if (!context || !Number.isFinite(percent)) return;
    watchHistory = recordPlayback(
        parseWatchHistory(preferences.get("watchHistory")),
        context,
        percent,
        new Date().toISOString()
    );
    preferences.set("watchHistory", JSON.stringify(watchHistory));
    preferences.sync();
    sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, { history: watchHistory });
    lastProgressSavedAt = Date.now();
}
```

The one-second monitor calls it only when
`shouldSaveProgress(Date.now(), lastProgressSavedAt, PROGRESS_SAVE_INTERVAL_MS)`
is true. Pause, end-file, and window-close handlers call it once immediately
before clearing the active context. Remove `getPlaybackMilestone` from the
`src/plugin/main.ts` import list.

- [ ] **Step 7: Run focused and full checks**

Run:

```bash
bun test src/shared/history.test.ts src/shared/stremio.test.ts src/plugin/playback.test.ts src/ui/app.test.ts
bun run typecheck
```

Expected: all tests PASS and both TypeScript configurations succeed.

- [ ] **Step 8: Verify identity and commit**

Run:

```bash
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
```

Expected for both: `Justaway41 <kritarthasapkota999@gmail.com>`.

Then:

```bash
git add src/shared/messages.ts src/shared/stremio.ts src/shared/stremio.test.ts src/plugin/playback.ts src/plugin/playback.test.ts src/plugin/constants.ts src/plugin/main.ts src/ui/app.ts src/ui/app.test.ts xyz.brbc.popcorn.iinaplugin/ui/sidebar.css
git commit -m "feat: resume local playback progress"
```

---

### Task 3: Add Trakt State, Payloads, Remote Parsing, and Merge Rules

**Files:**
- Create: `src/shared/trakt.ts`
- Create: `src/shared/trakt.test.ts`

**Interfaces:**
- Produces: `TraktState`
- Produces: `parseTraktState(value): TraktState`
- Produces: `buildScrobblePayload(context, progress): TraktScrobblePayload`
- Produces: `parseTraktHistory(playback, watched): WatchHistoryEntry[]`
- Produces: `mergeWatchHistory(local, remote): WatchHistoryEntry[]`

- [ ] **Step 1: Write failing state and payload tests**

Create `src/shared/trakt.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { PlaybackContext } from "./messages";
import {
    buildScrobblePayload,
    mergeWatchHistory,
    parseTraktHistory,
    parseTraktState
} from "./trakt";

const movie = {
    id: "tt123",
    imdbId: "tt123",
    type: "movie" as const,
    name: "Movie",
    releaseInfo: "2026",
    poster: ""
};

test("parses Trakt state defensively without retaining invalid tokens", () => {
    expect(parseTraktState("bad")).toMatchObject({
        clientId: "",
        clientSecret: "",
        tokens: null,
        initialHistoryUploaded: false
    });
    expect(parseTraktState(JSON.stringify({
        clientId: "id",
        clientSecret: "secret",
        tokens: { accessToken: 1 }
    })).tokens).toBeNull();
});

test("builds movie and episode scrobble payloads from existing IDs", () => {
    const movieContext: PlaybackContext = { media: movie, episodes: [] };
    expect(buildScrobblePayload(movieContext, 42)).toEqual({
        movie: { ids: { imdb: "tt123" } },
        progress: 42
    });

    const episode = {
        id: "tt456:2:3",
        name: "Episode",
        season: 2,
        episode: 3,
        aired: "",
        description: "",
        thumbnail: ""
    };
    expect(buildScrobblePayload({
        media: { ...movie, imdbId: "tt456", type: "series", name: "Show" },
        episode,
        episodes: [episode]
    }, 75)).toEqual({
        show: { ids: { imdb: "tt456" } },
        episode: { season: 2, number: 3 },
        progress: 75
    });
});
```

- [ ] **Step 2: Write failing remote parse and merge tests**

Append:

```ts
test("parses Trakt playback and watched items into local history", () => {
    const entries = parseTraktHistory(
        [{
            progress: 37.5,
            paused_at: "2026-07-27T10:00:00.000Z",
            type: "episode",
            episode: { season: 1, number: 2, title: "Second" },
            show: { title: "Show", year: 2026, ids: { imdb: "tt456" } }
        }],
        [{
            watched_at: "2026-07-26T10:00:00.000Z",
            type: "movie",
            movie: { title: "Movie", year: 2026, ids: { imdb: "tt123" } }
        }]
    );

    expect(entries).toEqual([
        expect.objectContaining({ id: "tt456:1:2", progress: 37.5, watched: false }),
        expect.objectContaining({ id: "tt123", progress: 100, watched: true })
    ]);
});

test("merges by newest timestamp while keeping watched and rich metadata", () => {
    const local = [{
        id: "tt123",
        media: { ...movie, poster: "poster.jpg" },
        lastPlayedAt: "2026-07-25T10:00:00.000Z",
        watched: true,
        progress: 100
    }];
    const remote = [{
        id: "tt123",
        media: movie,
        lastPlayedAt: "2026-07-27T10:00:00.000Z",
        watched: false,
        progress: 20
    }];

    expect(mergeWatchHistory(local, remote)[0]).toMatchObject({
        watched: true,
        progress: 20,
        lastPlayedAt: "2026-07-27T10:00:00.000Z",
        media: { poster: "poster.jpg" }
    });
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
bun test src/shared/trakt.test.ts
```

Expected: FAIL because `src/shared/trakt.ts` does not exist.

- [ ] **Step 4: Implement state parsing and scrobble payloads**

Create `src/shared/trakt.ts` with these public types:

```ts
import type { WatchHistoryEntry } from "./history";
import type { PlaybackContext } from "./messages";

export interface TraktTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

export interface TraktState {
    clientId: string;
    clientSecret: string;
    tokens: TraktTokens | null;
    initialHistoryUploaded: boolean;
    lastSyncAt: string;
    lastError: string;
    retryAt: number;
}

export interface TraktScrobblePayload {
    progress: number;
    movie?: { ids: { imdb: string } };
    show?: { ids: { imdb: string } };
    episode?: { season: number; number: number };
}

export function buildScrobblePayload(
    context: PlaybackContext,
    progress: number
): TraktScrobblePayload {
    const value = Math.max(0, Math.min(100, progress));
    if (!context.episode) {
        return { movie: { ids: { imdb: context.media.imdbId } }, progress: value };
    }
    return {
        show: { ids: { imdb: context.media.imdbId } },
        episode: {
            season: context.episode.season,
            number: context.episode.episode
        },
        progress: value
    };
}
```

Implement `parseTraktState` using object, string, number, and boolean guards.
Accept tokens only when both token strings are non-empty and `expiresAt` is a
finite positive number. Return empty defaults for every invalid field.

- [ ] **Step 5: Implement remote parsing and deterministic merging**

Implement parsers that accept only:

- movie entries with an IMDb ID, title, and timestamp
- episode entries with show IMDb ID, show title, numeric season/number, and timestamp
- playback progress as a finite value clamped to 0–100

Create remote media using:

```ts
{
    id: imdbId,
    imdbId,
    type: "movie" | "series",
    name: title,
    releaseInfo: year ? String(year) : "",
    poster: ""
}
```

Create remote episode IDs as `${showImdbId}:${season}:${number}`. Set optional
episode metadata fields to empty strings when Trakt does not provide them.

Implement merge ordering with:

```ts
const MAX_HISTORY_ITEMS = 100;

function timestamp(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
```

For duplicates:

- choose `progress`, `lastPlayedAt`, and names from the newest entry
- use the first non-empty poster, description, and thumbnail
- set `watched` to `older.watched || newer.watched`
- sort descending by timestamp
- cap at 100

- [ ] **Step 6: Run tests**

Run:

```bash
bun test src/shared/trakt.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Verify identity and commit**

Run:

```bash
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
```

Expected for both: `Justaway41 <kritarthasapkota999@gmail.com>`.

Then:

```bash
git add src/shared/trakt.ts src/shared/trakt.test.ts
git commit -m "feat: add Trakt sync data model"
```

---

### Task 4: Implement Trakt OAuth and API Operations

**Files:**
- Modify: `src/shared/trakt.ts`
- Modify: `src/shared/trakt.test.ts`

**Interfaces:**
- Produces: `TraktTransport`
- Produces: `requestDeviceCode(transport, state): Promise<TraktDeviceCode>`
- Produces: `pollDeviceToken(transport, state, code, wait): Promise<TraktState>`
- Produces: `refreshTraktTokens(transport, state): Promise<TraktState>`
- Produces: `scrobble(transport, state, action, context, progress): Promise<TraktState>`
- Produces: `syncTraktHistory(transport, state, local): Promise<{ state; history }>`

- [ ] **Step 1: Write failing mocked-transport OAuth tests**

Add to `src/shared/trakt.test.ts`:

```ts
import {
    pollDeviceToken,
    requestDeviceCode,
    scrobble,
    syncTraktHistory,
    type TraktResponse,
    type TraktTransport
} from "./trakt";

function queueTransport(responses: TraktResponse[]): TraktTransport {
    return async () => {
        const response = responses.shift();
        if (!response) throw new Error("Unexpected request");
        return response;
    };
}

test("requests a device code and polls at the supplied interval", async () => {
    const state = parseTraktState({ clientId: "id", clientSecret: "secret" });
    const code = await requestDeviceCode(queueTransport([{
        status: 200,
        data: {
            device_code: "device",
            user_code: "USERCODE",
            verification_url: "https://trakt.tv/activate",
            expires_in: 600,
            interval: 1
        },
        headers: {}
    }]), state);
    expect(code.userCode).toBe("USERCODE");

    const delays: number[] = [];
    const connected = await pollDeviceToken(queueTransport([
        { status: 400, data: {}, headers: {} },
        {
            status: 200,
            data: {
                access_token: "access",
                refresh_token: "refresh",
                created_at: 100,
                expires_in: 604800
            },
            headers: {}
        }
    ]), state, code, async (ms) => { delays.push(ms); });

    expect(delays).toEqual([1000]);
    expect(connected.tokens).toEqual({
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 604900000
    });
});
```

- [ ] **Step 2: Write failing refresh, scrobble, sync, and rate-limit tests**

Add:

```ts
interface RecordedRequest {
    method: "GET" | "POST";
    url: string;
    body: unknown;
    headers: Record<string, string>;
}

function recordingTransport(
    responses: TraktResponse[],
    calls: RecordedRequest[]
): TraktTransport {
    return async (method, url, body, headers) => {
        calls.push({ method, url, body, headers });
        const response = responses.shift();
        if (!response) throw new Error("Unexpected request");
        return response;
    };
}

test("refreshes an expiring access token before an authenticated request", async () => {
    const now = 1_000_000;
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: {
            accessToken: "old-access",
            refreshToken: "refresh",
            expiresAt: now + 1
        }
    });
    const calls: RecordedRequest[] = [];
    await scrobble(recordingTransport([
        {
            status: 200,
            data: {
                access_token: "new-access",
                refresh_token: "new-refresh",
                created_at: 1000,
                expires_in: 604800
            },
            headers: {}
        },
        { status: 200, data: {}, headers: {} }
    ], calls), state, "pause", { media: movie, episodes: [] }, 42, now);

    expect(calls.map((call) => call.url)).toEqual([
        "https://api.trakt.tv/oauth/token",
        "https://api.trakt.tv/scrobble/pause"
    ]);
    expect(calls[1].headers.Authorization).toBe("Bearer new-access");
});

test("uses pause below 90 percent and stop at the watched threshold", async () => {
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 2_000_000
        }
    });
    const calls: RecordedRequest[] = [];
    const transport = recordingTransport([
        { status: 200, data: {}, headers: {} },
        { status: 200, data: {}, headers: {} }
    ], calls);

    await scrobble(transport, state, "pause", { media: movie, episodes: [] }, 89.9, 1_000_000);
    await scrobble(transport, state, "stop", { media: movie, episodes: [] }, 90, 1_000_000);

    expect(calls.map((call) => call.url)).toEqual([
        "https://api.trakt.tv/scrobble/pause",
        "https://api.trakt.tv/scrobble/stop"
    ]);
});

test("merges fetched playback and watched history and uploads local watched once", async () => {
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 2_000_000
        }
    });
    const local = [{
        id: movie.imdbId,
        media: movie,
        lastPlayedAt: "2026-07-27T10:00:00.000Z",
        watched: true,
        progress: 100
    }];
    const calls: RecordedRequest[] = [];
    const result = await syncTraktHistory(recordingTransport([
        { status: 200, data: [], headers: {} },
        { status: 200, data: [], headers: {} },
        { status: 201, data: { added: { movies: 1 } }, headers: {} }
    ], calls), state, local, 1_000_000);

    expect(calls.map((call) => [call.method, call.url])).toEqual([
        ["GET", "https://api.trakt.tv/sync/playback"],
        ["GET", "https://api.trakt.tv/sync/history?limit=100"],
        ["POST", "https://api.trakt.tv/sync/history"]
    ]);
    expect(calls[2].body).toEqual({
        movies: [{ watched_at: "2026-07-27T10:00:00.000Z", ids: { imdb: "tt123" } }],
        episodes: []
    });
    expect(result.state.initialHistoryUploaded).toBe(true);
    expect(result.history[0].id).toBe("tt123");
});

test("records Retry-After without retrying immediately", async () => {
    const now = 1_000_000;
    const state = parseTraktState({
        clientId: "id",
        clientSecret: "secret",
        tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 2_000_000
        }
    });
    const calls: RecordedRequest[] = [];
    const result = await scrobble(recordingTransport([{
        status: 429,
        data: {},
        headers: { "retry-after": "12" }
    }], calls), state, "pause", { media: movie, episodes: [] }, 42, now);

    expect(calls).toHaveLength(1);
    expect(result.retryAt).toBe(now + 12_000);
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
bun test src/shared/trakt.test.ts
```

Expected: FAIL because the API interfaces and operations do not exist.

- [ ] **Step 4: Add the transport protocol and response validation**

Add:

```ts
export interface TraktResponse {
    status: number;
    data: unknown;
    headers: Record<string, string>;
}

export type TraktTransport = (
    method: "GET" | "POST",
    url: string,
    body: unknown,
    headers: Record<string, string>
) => Promise<TraktResponse>;

const TRAKT_API = "https://api.trakt.tv";

function apiHeaders(state: TraktState): Record<string, string> {
    return {
        Accept: "application/json",
        "Content-Type": "application/json",
        "trakt-api-key": state.clientId,
        "trakt-api-version": "2",
        ...(state.tokens ? { Authorization: `Bearer ${state.tokens.accessToken}` } : {})
    };
}
```

Add a `TraktError` carrying `status` and `retryAt`. Accept every 200–299 response.
For a 429 response, parse the case-insensitive `Retry-After` header as seconds,
fall back to 60 seconds when the transport cannot expose response headers, and
do not retry inside the request helper.

- [ ] **Step 5: Implement device code, polling, and refresh**

Define:

```ts
export interface TraktDeviceCode {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresAt: number;
    intervalMs: number;
}
```

`requestDeviceCode` posts `{ client_id }` to `/oauth/device/code`.

`pollDeviceToken` posts:

```ts
{
    code: code.deviceCode,
    client_id: state.clientId,
    client_secret: state.clientSecret
}
```

Handle statuses exactly:

- 200: parse and return tokens
- 400: wait `intervalMs`, then poll again
- 404: invalid code error
- 409: already-used error
- 410: expired error
- 418: denied error
- 429: increase the next wait by the response's `Retry-After` or one interval

Stop before `expiresAt`. Convert Trakt `created_at` and `expires_in` seconds to
an absolute millisecond `expiresAt`.

`refreshTraktTokens` posts the refresh-token grant to `/oauth/token` whenever
the token expires in less than 60 seconds.

- [ ] **Step 6: Implement authenticated scrobble and history sync**

Implement:

```ts
export type TraktScrobbleAction = "start" | "pause" | "stop";

export async function scrobble(
    transport: TraktTransport,
    state: TraktState,
    action: TraktScrobbleAction,
    context: PlaybackContext,
    progress: number,
    now = Date.now()
): Promise<TraktState>
```

It refreshes tokens, skips requests while `retryAt > now`, posts the payload to
`/scrobble/${action}`, and returns the updated state. Authentication failures
set `lastError` without deleting credentials.

Implement:

```ts
export async function syncTraktHistory(
    transport: TraktTransport,
    state: TraktState,
    local: WatchHistoryEntry[],
    now = Date.now()
): Promise<{ state: TraktState; history: WatchHistoryEntry[] }>
```

It:

1. refreshes tokens
2. GETs `/sync/playback`
3. GETs `/sync/history?limit=100`
4. parses and merges both responses into local history
5. if `initialHistoryUploaded` is false, POSTs locally watched entries not
   already present in the fetched Trakt watched history to `/sync/history`,
   using movie IMDb IDs or show IMDb + season/episode numbers
6. returns `initialHistoryUploaded: true`, cleared `lastError`, and a new
   `lastSyncAt` after success

- [ ] **Step 7: Run Trakt tests and type checking**

Run:

```bash
bun test src/shared/trakt.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 8: Verify identity and commit**

Run:

```bash
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
```

Expected for both: `Justaway41 <kritarthasapkota999@gmail.com>`.

Then:

```bash
git add src/shared/trakt.ts src/shared/trakt.test.ts
git commit -m "feat: add Trakt OAuth and sync client"
```

---

### Task 5: Add Trakt Preferences and Device Connection UX

**Files:**
- Modify: `src/ui/preferences.ts`
- Modify: `xyz.brbc.popcorn.iinaplugin/ui/preferences.html`
- Modify: `xyz.brbc.popcorn.iinaplugin/Info.json`

**Interfaces:**
- Consumes: `parseTraktState`, `requestDeviceCode`, `pollDeviceToken`, `syncTraktHistory`
- Produces: persisted `trakt` preference and device authorization UI

- [ ] **Step 1: Add the Trakt preference default**

In `xyz.brbc.popcorn.iinaplugin/Info.json` add:

```json
"trakt": "{}"
```

after `watchHistory`.

- [ ] **Step 2: Add accessible Trakt preference controls**

Append this section before the addon template in
`xyz.brbc.popcorn.iinaplugin/ui/preferences.html`:

```html
<section class="pref-section trakt-section" aria-labelledby="trakt-heading">
    <h3 id="trakt-heading">Trakt Sync</h3>
    <p class="small secondary pref-help">
        Create a Trakt application, then enter its Client ID and Client Secret.
    </p>
    <label for="trakt-client-id">Client ID</label>
    <input id="trakt-client-id" type="text" autocomplete="off" spellcheck="false">
    <label for="trakt-client-secret">Client Secret</label>
    <input id="trakt-client-secret" type="password" autocomplete="off" spellcheck="false">
    <div class="trakt-actions">
        <button id="trakt-connect" type="button">Connect Trakt</button>
        <button id="trakt-sync" type="button" hidden>Sync Now</button>
        <button id="trakt-disconnect" type="button" hidden>Disconnect</button>
    </div>
    <p id="trakt-device" class="trakt-device" hidden></p>
    <p id="trakt-status" class="small secondary" role="status">Not connected</p>
    <p id="trakt-error" class="addon-error" role="alert" hidden></p>
</section>
```

Add minimal inline styles:

```css
.trakt-section { display: grid; gap: 6px; margin-top: 18px; }
.trakt-section h3, .trakt-section p { margin: 0; }
.trakt-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.trakt-device { padding: 7px 8px; border-radius: 7px; background: rgba(128,128,128,.1); }
```

- [ ] **Step 3: Add a browser transport and state renderer**

In `src/ui/preferences.ts`, import the shared Trakt operations and implement:

```ts
const browserTransport: TraktTransport = async (method, url, body, headers) => {
    const response = await fetch(url, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json().catch(() => null) as unknown;
    return {
        status: response.status,
        data,
        headers: Object.fromEntries(
            [...response.headers.entries()].map(([key, value]) => [key.toLowerCase(), value])
        )
    };
};

let trakt = parseTraktState(null);
const traktClientId = element<HTMLInputElement>("trakt-client-id");
const traktClientSecret = element<HTMLInputElement>("trakt-client-secret");
const traktConnect = element<HTMLButtonElement>("trakt-connect");
const traktSync = element<HTMLButtonElement>("trakt-sync");
const traktDisconnect = element<HTMLButtonElement>("trakt-disconnect");
const traktDevice = element<HTMLParagraphElement>("trakt-device");
const traktStatus = element<HTMLParagraphElement>("trakt-status");
const traktError = element<HTMLParagraphElement>("trakt-error");

function setTraktError(message: string): void {
    traktError.textContent = message;
    traktError.hidden = !message;
}
```

Import `TraktState` plus the shared operations named in this task. Load `trakt`
and `watchHistory` alongside addon preferences, populate both credential
inputs, then parse and render:

```ts
function renderTrakt(): void {
    const connected = trakt.tokens !== null;
    traktConnect.hidden = connected;
    traktSync.hidden = !connected;
    traktDisconnect.hidden = !connected;
    traktStatus.textContent = connected
        ? `Connected${trakt.lastSyncAt ? ` · Last synced ${new Date(trakt.lastSyncAt).toLocaleString()}` : ""}`
        : "Not connected";
}

function saveTrakt(next: TraktState): void {
    trakt = next;
    preferences.set("trakt", JSON.stringify(next));
    preferences.sync?.();
    renderTrakt();
}
```

Save Client ID and Client Secret on change. If either value differs from the
saved credentials, clear `tokens`, set `initialHistoryUploaded` to `false`, and
clear `lastSyncAt`, `lastError`, and `retryAt`; credentials belong to one Trakt
application and old tokens must not be reused with another.

```ts
function saveTraktCredentials(): void {
    const clientId = traktClientId.value.trim();
    const clientSecret = traktClientSecret.value.trim();
    if (clientId === trakt.clientId && clientSecret === trakt.clientSecret) return;
    saveTrakt({
        ...trakt,
        clientId,
        clientSecret,
        tokens: null,
        initialHistoryUploaded: false,
        lastSyncAt: "",
        lastError: "",
        retryAt: 0
    });
}

traktClientId.addEventListener("change", saveTraktCredentials);
traktClientSecret.addEventListener("change", saveTraktCredentials);
```

- [ ] **Step 4: Implement Connect Trakt**

Add:

```ts
async function connectTrakt(): Promise<void> {
    setTraktError("");
    const clientId = traktClientId.value.trim();
    const clientSecret = traktClientSecret.value.trim();
    if (!clientId || !clientSecret) {
        setTraktError("Enter both the Trakt Client ID and Client Secret.");
        return;
    }

    traktConnect.disabled = true;
    try {
        saveTrakt({
            ...trakt,
            clientId,
            clientSecret,
            tokens: null,
            initialHistoryUploaded: false,
            lastSyncAt: "",
            lastError: "",
            retryAt: 0
        });
        traktStatus.textContent = "Requesting device code…";
        const code = await requestDeviceCode(browserTransport, trakt);
        traktDevice.hidden = false;
        traktDevice.textContent = `Enter ${code.userCode} at trakt.tv/activate`;
        const activation = `${code.verificationUrl.replace(/\/$/, "")}/${encodeURIComponent(code.userCode)}`;
        window.open(activation, "_blank");
        traktStatus.textContent = "Waiting for Trakt authorization…";
        const connected = await pollDeviceToken(
            browserTransport,
            trakt,
            code,
            (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))
        );
        saveTrakt(connected);

        const local = parseWatchHistory(await getPreference("watchHistory"));
        const result = await syncTraktHistory(browserTransport, connected, local);
        preferences.set("watchHistory", JSON.stringify(result.history));
        preferences.sync?.();
        saveTrakt(result.state);
        traktDevice.hidden = true;
    } catch (error) {
        setTraktError(error instanceof Error ? error.message : "Could not connect Trakt.");
    } finally {
        traktConnect.disabled = false;
        renderTrakt();
    }
}
```

Use the status strings:

- `Requesting device code…`
- `Enter CODE at trakt.tv/activate`
- `Waiting for Trakt authorization…`
- `Connected`

Disable the Connect button during the operation and restore it in `finally`.

- [ ] **Step 5: Implement Sync Now and Disconnect**

Add:

```ts
async function syncTraktNow(): Promise<void> {
    if (!trakt.tokens) return;
    traktSync.disabled = true;
    setTraktError("");
    try {
        const local = parseWatchHistory(await getPreference("watchHistory"));
        const result = await syncTraktHistory(browserTransport, trakt, local);
        preferences.set("watchHistory", JSON.stringify(result.history));
        preferences.sync?.();
        saveTrakt(result.state);
    } catch (error) {
        setTraktError(error instanceof Error ? error.message : "Could not sync Trakt.");
    } finally {
        traktSync.disabled = false;
    }
}

function disconnectTrakt(): void {
    saveTrakt({
        ...trakt,
        tokens: null,
        lastSyncAt: "",
        lastError: "",
        retryAt: 0
    });
    traktDevice.hidden = true;
}

traktConnect.addEventListener("click", () => void connectTrakt());
traktSync.addEventListener("click", () => void syncTraktNow());
traktDisconnect.addEventListener("click", disconnectTrakt);
```

`disconnectTrakt` must not clear credentials or `watchHistory`.

- [ ] **Step 6: Run UI type checking and build**

Run:

```bash
bun run typecheck
bun run build:ui
```

Expected: both succeed and `xyz.brbc.popcorn.iinaplugin/ui/dist/preferences.js`
is rebuilt.

- [ ] **Step 7: Verify identity and commit**

Run:

```bash
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
```

Expected for both: `Justaway41 <kritarthasapkota999@gmail.com>`.

Then:

```bash
git add src/ui/preferences.ts xyz.brbc.popcorn.iinaplugin/ui/preferences.html xyz.brbc.popcorn.iinaplugin/Info.json
git commit -m "feat: add Trakt connection preferences"
```

---

### Task 6: Add Runtime Scrobbling and Background Synchronization

**Files:**
- Create: `src/plugin/trakt.ts`
- Create: `src/plugin/trakt.test.ts`
- Modify: `src/plugin/main.ts`

**Interfaces:**
- Consumes: shared `TraktTransport`, `scrobble`, `syncTraktHistory`
- Produces: `createIinaTraktClient(http, preferences)`
- Produces: `sendPlayback(action, context, progress): Promise<void>`
- Produces: `sync(history): Promise<WatchHistoryEntry[]>`

- [ ] **Step 1: Write failing native adapter tests**

Create `src/plugin/trakt.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createIinaTransport } from "./trakt";

test("normalizes IINA HTTP responses and request headers", async () => {
    const calls: unknown[] = [];
    const http = {
        async get(url: string, options: unknown) {
            calls.push(["GET", url, options]);
            return {
                statusCode: 200,
                data: [{ progress: 10 }],
                text: "",
                reason: "ok"
            };
        }
    };

    const response = await createIinaTransport(http as never)(
        "GET",
        "https://api.trakt.tv/sync/playback",
        null,
        { Authorization: "Bearer token" }
    );

    expect(response.status).toBe(200);
    expect(response.data).toEqual([{ progress: 10 }]);
    expect(calls[0]).toEqual([
        "GET",
        "https://api.trakt.tv/sync/playback",
        { params: {}, headers: { Authorization: "Bearer token" }, data: null }
    ]);
});
```

The IINA HTTP response does not expose headers, so return an empty header object.
The shared client applies its 60-second fallback when this adapter receives 429.

- [ ] **Step 2: Run the adapter test and verify failure**

Run:

```bash
bun test src/plugin/trakt.test.ts
```

Expected: FAIL because `src/plugin/trakt.ts` does not exist.

- [ ] **Step 3: Implement the IINA transport and preference-backed client**

Create `src/plugin/trakt.ts`:

```ts
import type { WatchHistoryEntry } from "../shared/history";
import type { PlaybackContext } from "../shared/messages";
import {
    parseTraktState,
    scrobble,
    syncTraktHistory,
    type TraktScrobbleAction,
    type TraktTransport
} from "../shared/trakt";

export function createIinaTransport(http: IINA.API.HTTP): TraktTransport {
    return async (method, url, body, headers) => {
        const options = { params: {}, headers, data: body };
        const response = method === "GET"
            ? await http.get(url, options)
            : await http.post(url, options);
        return {
            status: response.statusCode,
            data: response.data ?? safeJson(response.text),
            headers: {}
        };
    };
}

function safeJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}
```

Add:

```ts
export interface IinaTraktClient {
    sendPlayback(
        action: TraktScrobbleAction,
        context: PlaybackContext,
        progress: number
    ): Promise<void>;
    sync(history: WatchHistoryEntry[]): Promise<WatchHistoryEntry[]>;
}

export function createIinaTraktClient(
    http: IINA.API.HTTP,
    preferences: IINA.API.Preferences,
    onError: (error: unknown) => void
): IinaTraktClient {
    const transport = createIinaTransport(http);
    const read = () => parseTraktState(preferences.get("trakt"));
    const save = (state: ReturnType<typeof parseTraktState>) => {
        preferences.set("trakt", JSON.stringify(state));
        preferences.sync();
    };

    return {
        async sendPlayback(action, context, progress) {
            const state = read();
            if (!state.tokens) return;
            try {
                save(await scrobble(transport, state, action, context, progress));
            } catch (error) {
                onError(error);
            }
        },
        async sync(history) {
            const state = read();
            if (!state.tokens) return history;
            try {
                const result = await syncTraktHistory(transport, state, history);
                save(result.state);
                return result.history;
            } catch (error) {
                onError(error);
                return history;
            }
        }
    };
}
```

- [ ] **Step 4: Wire start, pause, resume, stop, and close events**

In `src/plugin/main.ts`, destructure `http` from `iina`, create one runtime
client, and add:

```ts
function sendTrakt(action: TraktScrobbleAction, percent: number): void {
    const context = activePlaybackContext;
    if (!context || !Number.isFinite(percent)) return;
    void trakt.sendPlayback(action, context, percent);
}

function checkpointPlayback(forceStop = false): void {
    const context = activePlaybackContext;
    if (!context) return;
    const percent = forceStop ? 100 : mpv.getNumber("percent-pos");
    if (!Number.isFinite(percent)) return;
    savePlaybackProgress(percent);
    void trakt.sendPlayback(
        forceStop || percent >= 90 ? "stop" : "pause",
        context,
        percent
    );
}
```

Wire it exactly:

- after a non-splash file loads and the optional seek runs: `start`
- `mpv.pause.changed`: call `checkpointPlayback()` when paused and `start` when resumed
- at the start of `playItem`, call `checkpointPlayback()` before replacing an
  existing `activePlaybackContext`; then assign the new context
- keep `isReplacingPlayback` so the resulting `mpv.end-file` returns without
  reporting the old item a second time
- normal `mpv.end-file`: call `checkpointPlayback(reachedNaturalEof)`, then clear
  the active context
- `iina.window-will-close`: call `checkpointPlayback()` before clearing context

Use the same sampled `percent-pos` for local save and the Trakt event.

- [ ] **Step 5: Run background history sync**

After the Popcorn sidebar/window initializes, run once:

```ts
void trakt.sync(watchHistory).then((history) => {
    watchHistory = history;
    preferences.set("watchHistory", JSON.stringify(history));
    preferences.sync();
    sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, { history });
});
```

Do not await this before rendering local configuration.

- [ ] **Step 6: Run plugin tests, full tests, and type checking**

Run:

```bash
bun test src/plugin/trakt.test.ts src/plugin/playback.test.ts src/shared/trakt.test.ts
bun test
bun run typecheck
```

Expected: all tests PASS and type checking succeeds.

- [ ] **Step 7: Verify identity and commit**

Run:

```bash
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
```

Expected for both: `Justaway41 <kritarthasapkota999@gmail.com>`.

Then:

```bash
git add src/plugin/trakt.ts src/plugin/trakt.test.ts src/plugin/main.ts
git commit -m "feat: scrobble playback to Trakt"
```

---

### Task 7: Document and Verify the Complete Feature

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: all completed Trakt and local-progress behavior
- Produces: user setup instructions and a locally built plugin bundle

- [ ] **Step 1: Document Trakt setup**

Add a concise README section:

```md
### Trakt progress sync

Popcorn always keeps local recent and watched progress. To sync across devices:

1. Create a Trakt API application at https://trakt.tv/oauth/applications.
2. Open IINA Settings → Plugins → Popcorn for IINA.
3. Enter the application's Client ID and Client Secret.
4. Choose **Connect Trakt** and approve the displayed device code.

When connected, Popcorn syncs watched history and unfinished playback progress.
Trakt failures do not interrupt playback; local progress continues offline.
Disconnecting Trakt keeps local history.
```

- [ ] **Step 2: Run the complete verification suite**

Run:

```bash
bun test
bun run typecheck
bun run build
bun run verify:built-client-version
```

Expected:

- all Bun tests pass
- plugin and UI type checking pass
- plugin and UI bundles build
- built client version verification passes

- [ ] **Step 3: Confirm the local development link receives the build**

Run:

```bash
readlink "/Users/justaway/Library/Application Support/com.colliderli.iina/plugins/xyz.brbc.popcorn.iinaplugin-dev"
rg -n "api.trakt.tv|Connect Trakt|poster-progress" xyz.brbc.popcorn.iinaplugin
```

Expected:

- the symlink targets `/Users/justaway/Developer/popcorn-iina/xyz.brbc.popcorn.iinaplugin`
- compiled output contains the Trakt and progress UI markers

- [ ] **Step 4: Verify identity and commit**

Run:

```bash
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
```

Expected for both: `Justaway41 <kritarthasapkota999@gmail.com>`.

Then:

```bash
git add README.md
git commit -m "docs: explain Trakt progress sync"
```

- [ ] **Step 5: Manual smoke test**

Fully quit and reopen IINA, then verify:

1. Local playback adds a Recent card with a progress bar after 30 seconds.
2. Reopening the item and selecting a stream seeks to the saved percentage.
3. Invalid Trakt credentials show an error in Preferences without affecting playback.
4. Device authorization connects and Sync Now updates the timestamp.
5. Pausing updates Trakt playback progress.
6. Finishing at or above 90 percent marks the movie or episode watched.
7. Disconnecting Trakt preserves the Recent grid.
