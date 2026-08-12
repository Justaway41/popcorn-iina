# CrossWatch Scrobble Target — Design

**Date:** 2026-08-12
**Status:** Approved, ready for planning

## Problem

Trakt now limits a free account to **one connected community app**. Popcorn, the home media
server (Plex/Jellyfin/Kodi), and Nuvio on the phone are three separate community apps competing
for one slot, so at most one of them can reach Trakt.

Popcorn currently scrobbles to Trakt directly (`src/plugin/trakt.ts`, `src/shared/trakt.ts`),
which means Popcorn *is* the app consuming the slot whenever it is connected.

## Approach

Move the Trakt connection out of every client and into a single self-hosted hub,
[CrossWatch](https://github.com/cenodude/CrossWatch). CrossWatch holds the one Trakt connection;
every client feeds CrossWatch instead.

```
Popcorn ──POST /webhook/jellyfin──┐
Plex / Jellyfin / Kodi ──native───┼── CrossWatch ──> Trakt   (the one slot)
Nuvio phone ──native──────────────┘         └──> writes back into Nuvio
```

Popcorn's side of this is one new scrobble target that posts a Jellyfin-shaped webhook. Trakt
support in Popcorn is **not** removed — both targets run side by side, each independently
enabled by its own configuration being present.

### Why the Jellyfin webhook and not something else

CrossWatch accepts inbound events on exactly four routes — `/webhook/jellyfin`,
`/webhook/emby`, `/webhook/plex`, `/webhook/plexwatcher` (`api/scrobbleAPI.py:1275-1723`). There
is no generic ingest. Of those, Jellyfin is plain JSON with a URL token; Plex is multipart
form-encoded and tied to a real Plex server UUID.

Three properties of the Jellyfin handler were verified against
`providers/webhooks/jellyfin.py` before choosing it:

1. **IMDb ids resolve without a Jellyfin server.** `_ids_from_providerids` (`:446`) reads
   `Item.ProviderIds.Imdb`, and resolution goes through Trakt's own `/search/imdb/…` (`:609`).
   No library lookup is involved.
2. **Both filters are off by default.** `username_whitelist` defaults to `[]` (`:39`), and
   `_jf_passes_scrobble_library` returns `True` immediately when no library list is configured
   (`:173`).
3. **Progress is accepted as a plain percent.** `_progress` (`:901`) returns
   `payload["Progress"]` clamped to 0–100 before trying any tick arithmetic.

CrossWatch also owns the completion thresholds itself — `complete_at`, `watched_at`,
`stop_pause_threshold`, pause debounce, and seek/regress detection (`:1189-1240`). Popcorn
therefore emits raw lifecycle events and derives nothing, making this module **simpler** than
`src/shared/trakt.ts`: no OAuth, no token refresh, no retry state machine, no history merge.

### Approaches rejected

- **Trakt VIP (~$30/yr).** Zero code, zero infrastructure. Rejected by the user in favour of
  self-hosting; recorded here because it remains the cheaper option in maintenance terms.
- **A Nuvio Sync module in Popcorn.** Nuvio's `WatchProgressSource` enum
  (`features/tracking/TrackingSources.kt`) is `{ TRAKT, SIMKL, NUVIO_SYNC }` — mutually
  exclusive, with no forwarding between them. Pushing to Nuvio Sync can therefore never reach
  Trakt. CrossWatch already speaks the same Supabase API (`providers/sync/nuvio/_common.py:385`)
  and writes back (`_history.py:202`), so phone↔Mac sync comes for free at the hub layer.
- **A Simkl module in Popcorn.** Would be roughly the size of `src/shared/trakt.ts` including a
  full OAuth flow. Unnecessary once CrossWatch supports Nuvio directly.
- **A reverse proxy for `api.trakt.tv`.** Requires DNS override plus a trusted TLS certificate on
  every device, and breaks on any cert pinning. Rejected as permanent maintenance.

## Components

### `src/shared/crosswatch.ts` (new, pure)

No IINA APIs, no I/O beyond an injected transport — mirrors how `src/shared/trakt.ts` is
structured so it can be tested under Bun.

```ts
export interface CrossWatchState {
    url: string;       // base URL of the CrossWatch instance
    token: string;     // webhook token from CrossWatch's /api/webhooks/urls
    username: string;  // sent as NotificationUsername; defaults to "popcorn"
}

export function parseCrossWatchState(value: unknown): CrossWatchState;
export function isCrossWatchConfigured(state: CrossWatchState): boolean;
export function buildJellyfinPayload(
    action: TraktScrobbleAction,
    context: PlaybackContext,
    percent: number
): Record<string, unknown> | null;
export function sendCrossWatchPlayback(
    transport: HttpTransport,
    state: CrossWatchState,
    action: TraktScrobbleAction,
    context: PlaybackContext,
    percent: number
): Promise<void>;
```

`parseCrossWatchState` is defensive in the same way `parseTraktState` is: any malformed input
yields empty strings, and `username` falls back to `"popcorn"`. `isCrossWatchConfigured` requires
a non-empty `url` **and** `token`; anything else means the feature is off and no request is made.

The transport type is reused from `src/shared/trakt.ts` via
`import type { TraktTransport as HttpTransport }`. It is a plain
`(method, url, body, headers) => Promise<{ status, data, headers }>` signature with nothing
Trakt-specific in it, and aliasing avoids moving a shared type for one consumer.

#### Payload

`buildJellyfinPayload` returns `null` — and no request is sent — when
`isImdbId(context.media.imdbId)` is false, matching the guard `scrobble()` already applies at
`src/shared/trakt.ts:246`. `percent` is clamped to 0–100 and rejected when non-finite.

Action mapping:

| Popcorn action | `NotificationType` |
| --- | --- |
| `start` | `PlaybackStart` |
| `pause` | `PlaybackPause` |
| `stop`  | `PlaybackStop` |

Movie:

```json
{
  "NotificationType": "PlaybackStart",
  "NotificationUsername": "popcorn",
  "Progress": 12.5,
  "Item": {
    "Type": "Movie",
    "Name": "Spider-Man",
    "ProductionYear": 2002,
    "ProviderIds": { "Imdb": "tt0145487" }
  }
}
```

`ProductionYear` comes from the four-digit year in `media.releaseInfo`, and is omitted when that
field holds no parseable year.

Episode:

```json
{
  "NotificationType": "PlaybackPause",
  "NotificationUsername": "popcorn",
  "Progress": 44.0,
  "Item": {
    "Type": "Episode",
    "SeriesName": "Dark",
    "Name": "The Travellers",
    "ParentIndexNumber": 3,
    "IndexNumber": 4,
    "SeriesProviderIds": { "Imdb": "tt5753856" }
  }
}
```

**The series id must go in `SeriesProviderIds`, never in `ProviderIds`.** CrossWatch merges the
two as `ids_all = {**ids_show, **ids_epi}` (`jellyfin.py:1131`), so an id placed in `ProviderIds`
is treated as an *episode* id. Popcorn only ever holds a series-level `media.imdbId`, so putting
it in the wrong key silently resolves to the wrong thing or to nothing at all. This is the single
most important detail in the module and it gets a dedicated test.

Request target: `POST {url}/webhook/jellyfin?token={token}` with `Content-Type: application/json`.

### `src/plugin/crosswatch.ts` (new, IINA glue)

Mirrors `src/plugin/trakt.ts` but is smaller, because CrossWatch needs no credential lifecycle:

```ts
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
): IinaCrossWatchClient;
```

It reuses `createIinaTransport` already exported from `src/plugin/trakt.ts`. There is no
serialization queue and no preference writing — the client never mutates state, so the `enqueue`
and `saveIfCurrent` machinery in the Trakt client has no counterpart here. Failures are passed to
`onError` and swallowed; a scrobble must never interrupt playback.

### `src/plugin/main.ts` (modified)

`sendTrakt` (`:161`) is already the single funnel every scrobble passes through — called from
`updatePlaybackMonitoring` (`:139`), `checkpointPlayback` (`:174`), and the playback lifecycle
handlers (`:693`, `:702`). Fan out there:

- Rename `sendTrakt` → `sendScrobble` and `traktStopSent` → `scrobbleStopSent`. Mechanical, about
  eight lines across the file, and it keeps the names honest once there are two targets.
- Construct the CrossWatch client beside the Trakt client (`:52`), with the same
  `logDebug("Popcorn: …", formatError(error))` error handler shape.
- Inside `sendScrobble`, call both clients. Each no-ops when unconfigured, so the fan-out is safe
  with either, both, or neither target set up.

No new timer. `updatePlaybackMonitoring` already ticks on `PLAYBACK_TICK_INTERVAL_MS`, and
`AGENTS.md` forbids adding `setInterval` to plugin runtime entries.

### Preferences

One structured key, matching the existing `trakt: {}` pattern rather than three loose strings.

`Info.json` → `preferenceDefaults`:

```json
"crosswatch": {}
```

There is a single `Info.json` at the repository root; `bun run verify:root-info` checks it.

`ui/preferences.html` — a new section modelled on `.trakt-section` (`:99-119`):

- CrossWatch URL — `type="text"`
- Webhook token — `type="password"`, following `#trakt-client-secret` (`:111`)
- Username — `type="text"`, placeholder `popcorn`

`src/ui/preferences.ts` — read through the existing `getPreference` helper (`:248`) in the
`loadPreferences` batch (`:108`), write with `preferences.set("crosswatch", next)` following
`saveTrakt` (`:275`).

No migration is needed. The key is new, and `parseCrossWatchState` treats a missing or malformed
value as unconfigured.

## Security

- The webhook token travels in the query string. It falls under the same rule `AGENTS.md` sets
  for manifest URLs: never logged, never included in an error message, never committed to a
  fixture or a doc. Failures log `formatError(error)` only, matching `main.ts:53`.
- The token field is `type="password"` in the preferences UI.
- The CrossWatch instance is expected on the LAN. No public exposure, no TLS, and no port
  forwarding are required or assumed.
- Nothing about the Trakt integration changes. Its credentials keep their existing handling.

## Error handling

- Unconfigured (missing URL or token) → no request, no log, no error.
- Non-IMDb media → no request. Popcorn cannot identify the title to CrossWatch, and a title-only
  guess would risk scrobbling the wrong thing.
- Transport failure, non-2xx, timeout → `onError`, swallowed. Playback is unaffected.
- CrossWatch down → that watch never reaches Trakt. Webhooks are fire-and-forget with no queue,
  and there is deliberately no retry or outbox in this design. Popcorn's local history
  (`src/shared/history.ts`) still records the play, and the other CrossWatch sources are pulled on
  a schedule so only the Popcorn path is live-only. An outbox can be added later if this proves
  to matter in practice.

## Testing

`src/shared/crosswatch.test.ts` (new), alongside the existing shared-module suites:

- Movie payload shape, including `ProductionYear` derived from `releaseInfo` and omitted when
  `releaseInfo` carries no year
- Episode payload shape, asserting the series id appears in `SeriesProviderIds` and that
  `ProviderIds` is absent
- Action mapping for all three actions
- `percent` clamped at both ends; non-finite rejected
- `null` returned for a non-IMDb `media.imdbId`
- `parseCrossWatchState` against malformed input: `null`, a string, missing keys, wrong types
- `isCrossWatchConfigured` false when either URL or token is empty
- `sendCrossWatchPlayback` makes no transport call when unconfigured or when the payload is `null`

Full chain per `AGENTS.md`:

```sh
bun test
bun run typecheck
git diff --check
bun run build
bun run package
bun run verify:root-info
bun run verify:built-client-version
unzip -t xyz.brbc.popcorn.iinaplugin.iinaplgz
```

`dist/` and `ui/dist/` are tracked but must never be hand-edited — they are regenerated by
`bun run package`.

Manual verification in IINA, which is the only thing that proves the integration:

1. Movie with CrossWatch configured → CrossWatch `SCROBBLE` log shows the event, Trakt shows the play
2. Episode → correct season and episode land on Trakt, not a mismatched title
3. Pause and resume → CrossWatch reports pause and start rather than a completion
4. Watch past the completion threshold → Trakt marks it watched
5. CrossWatch URL cleared → no outbound request
6. CrossWatch stopped → playback is unaffected, failure logged with no token in the message
7. Trakt configured **and** CrossWatch configured → both receive the events
8. Title with no IMDb id → no request attempted

## CrossWatch-side setup (user-owned, no code)

Recorded here so the plugin side can be verified end to end.

```bash
docker run -d --name crosswatch -p 8787:8787 \
  -v crosswatch_config:/config -e TZ=Asia/Kathmandu --restart unless-stopped \
  ghcr.io/cenodude/crosswatch:latest
```

1. Connect Trakt to CrossWatch — this becomes the one connected app on the Trakt account
2. Disconnect Trakt and Simkl inside Nuvio on the phone, so `effectiveWatchProgressSource` falls
   back to `NUVIO_SYNC` and the phone's progress lands in the Nuvio account
3. Add Nuvio to CrossWatch by device pairing (`providers/auth/_auth_NUVIO.py` hardcodes
   `auth_method = "tv_login"`), then select the profile
4. Add sync pairs: Nuvio↔Trakt, and Plex/Jellyfin/Kodi→Trakt
5. Leave the Jellyfin scrobble **library whitelist empty**. If it is set, CrossWatch resolves the
   incoming `ItemId` against a real Jellyfin server, and Popcorn's synthetic ids are dropped
6. Copy the webhook token from CrossWatch's `/api/webhooks/urls` into Popcorn's preferences

## Out of scope

- Removing or changing Popcorn's Trakt integration
- A retry queue or outbox for missed webhooks
- Emitting `PlaybackProgress` ticks — CrossWatch derives completion from the stop event
- Reading anything back from CrossWatch; this is write-only
- Emby and Plex webhook formats
