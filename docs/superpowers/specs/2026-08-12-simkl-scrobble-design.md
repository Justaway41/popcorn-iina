# Simkl Scrobble Target — Design

**Date:** 2026-08-12
**Status:** Approved, ready for implementation
**Supersedes:** `2026-08-12-crosswatch-scrobble-design.md`

## Why this replaces the CrossWatch design

The CrossWatch design existed to work around Trakt limiting a free account to one connected
community app: a self-hosted hub would hold the single Trakt connection and every client would
feed it.

Simkl has no such limit. Once Simkl is the tracker, the hub has nothing to solve — Nuvio has a
native Simkl provider (`WatchProgressSource.SIMKL`), and Plex, Jellyfin, and Kodi all have their
own Simkl integrations. Popcorn was the only client that could not reach Simkl on its own, so the
correct fix is to give Popcorn a Simkl client rather than to run a container that relays it.

The CrossWatch implementation is preserved on the `feat/crosswatch-scrobble` branch.

## Approach

Add Simkl as a second scrobble target beside Trakt. Both run side by side and each is enabled
purely by its own credentials being present. The Trakt integration is not modified or removed.

Simkl's scrobble API is the same shape as Trakt's, which is what makes this small:

| | Trakt (existing) | Simkl |
| --- | --- | --- |
| Scrobble paths | `/scrobble/{start,pause,stop}` | identical |
| Body | `{progress, movie:{ids}}` / `{progress, show:{ids}, episode:{season,number}}` | identical |
| Login | device code | PIN flow, same structure |
| Client secret | required | **not needed** |
| Token refresh | full refresh and expiry handling | **none** — tokens are long-lived |

So `src/shared/simkl.ts` is `src/shared/trakt.ts` with the refresh machinery, the client secret,
and the reconnect-on-expiry state removed.

### API

Base: `https://api.simkl.com`

Headers on every request:

```
Accept: application/json
Content-Type: application/json
simkl-api-key: <client_id>
Authorization: Bearer <access_token>      // once connected
```

PIN flow:

```
GET /oauth/pin?client_id=<id>              → { result: "OK", user_code, verification_url, expires_in, interval }
GET /oauth/pin/<user_code>?client_id=<id>  → { result: "OK", access_token }   once approved
                                           → { result: "KO" }                 while pending
```

The user enters the code at `https://simkl.com/pin`. This mirrors Popcorn's existing Trakt device
flow closely enough to reuse its UI shape: show the code, poll, report status.

Scrobble:

```
POST /scrobble/start
POST /scrobble/pause
POST /scrobble/stop
```

with the payload `buildScrobblePayload` already produces for Trakt — same field names, so that
function is reused rather than duplicated.

## Components

### `src/shared/simkl.ts` (new, pure)

```ts
export interface SimklState {
    clientId: string;
    accessToken: string;
    lastError: string;
    retryAt: number;
}

export interface SimklPin {
    userCode: string;
    verificationUrl: string;
    expiresAt: number;
    intervalMs: number;
}

export function parseSimklState(value: unknown): SimklState;
export function isSimklConnected(state: SimklState): boolean;
export function requestSimklPin(transport, state, now?): Promise<SimklPin>;
export function pollSimklPin(transport, state, pin, wait): Promise<SimklState>;
export function simklScrobble(transport, state, action, context, progress, now?): Promise<SimklState>;
export function parseSimklExternalLinkRequest(value: unknown): string;
```

`SimklState` carries no tokens object and no `reconnectRequired`, because there is nothing to
expire. `retryAt` is kept: Simkl rate-limits, and the existing `Retry-After` handling is worth
having.

Reused from `src/shared/trakt.ts`: the `TraktTransport` signature (aliased on import as
`HttpTransport` — it is a plain method/url/body/headers function with nothing Trakt-specific in
it), `TraktScrobbleAction`, and `buildScrobblePayload`.

`simklScrobble` guards on `isImdbId(context.media.imdbId)` exactly as `scrobble()` does, returns
the state unchanged when disconnected or inside a retry window, and never throws — it folds
failures into `lastError` the way the Trakt version does.

### `src/plugin/simkl.ts` (new, IINA glue)

Mirrors `src/plugin/trakt.ts`, reusing its exported `createIinaTransport`. It serializes calls
through the same `enqueue` pattern and writes state back only when the connection has not changed
underneath it, so a scrobble cannot clobber a disconnect made in the preferences window.

### `src/plugin/main.ts` (modified)

`sendTrakt` (`:161`) is the single funnel every scrobble already passes through. Rename it
`sendScrobble` and `traktStopSent` → `scrobbleStopSent`, construct a Simkl client beside the Trakt
one, and call both. Each no-ops when unconfigured. No new timer.

### Preferences

New key `simkl` in `Info.json` `preferenceDefaults`, holding `{ clientId, accessToken, lastError,
retryAt }` — the same structured-object pattern as `trakt`.

`ui/preferences.html` gains a Simkl section modelled on the Trakt one: a Client ID field, Connect
and Disconnect buttons, a PIN display, and a status line. No secret field — the PIN flow does not
use one.

`src/ui/preferences.ts` performs the PIN flow in the webview using the existing `browserTransport`
and `element` helpers, following `connectTrakt` / `disconnectTrakt`.

## Security

- The access token and client id are credentials. Never logged, never in an error message, never
  in a fixture or doc. Plugin-side failures log `formatError(error)` only.
- Errors thrown by this module carry a status code and nothing else, and a transport rejection is
  replaced rather than propagated, because a rejected HTTP call can quote the request URL.
- External links from the preferences page are allowlisted through
  `parseSimklExternalLinkRequest`, matching how `parseTraktExternalLinkRequest` restricts Trakt's.

## Out of scope

- **History sync.** Trakt's module also pulls `/sync/playback` and `/sync/history` into Popcorn's
  Recently Watched and backfills upward. Simkl's equivalents return a different shape and are a
  comparable amount of work again. Scrobbling is the stated goal; this can follow.
- Removing or changing the Trakt integration.
- Simkl's anime id space (MAL, AniDB, AniList, Kitsu). Popcorn keys on IMDb ids, which Simkl
  accepts for movies and shows.
- Ratings, watchlist, and collection.

## Testing

`src/shared/simkl.test.ts`:

- `parseSimklState` against `null`, a string, missing keys, wrong types
- `isSimklConnected` false without a client id or without a token
- `requestSimklPin` parses a valid response and rejects one missing `user_code`
- `pollSimklPin` returns state on `result: "OK"` with a token, keeps polling while pending, and
  gives up at expiry
- `simklScrobble` posts to the right path per action, sends the Trakt-shaped body, skips a
  non-IMDb id, skips while disconnected, and respects `retryAt`
- a transport rejection quoting the URL does not survive into the resulting `lastError`

Full chain per `AGENTS.md`: `bun test`, `bun run typecheck`, `git diff --check`, `bun run package`,
`bun run verify:root-info`, `bun run verify:built-client-version`, `unzip -t`.

Manual in IINA: register a Simkl app for its client id, connect via PIN, play a movie and an
episode, confirm both land on Simkl, disconnect and confirm no further requests.
