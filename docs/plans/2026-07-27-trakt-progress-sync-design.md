# Trakt Progress Sync Design

## Goal

Add optional, cross-device playback progress and watched-history sync through
Trakt while preserving the plugin's existing local history as an offline
fallback.

## Authentication

The plugin remains serverless. Each user creates a Trakt application and enters
its Client ID and Client Secret in Popcorn's preferences.

The preferences UI provides:

- Client ID and Client Secret fields
- Connect Trakt
- connection status
- Sync Now
- Disconnect

Connect Trakt uses Trakt device authentication. The plugin requests a device
code, opens the supplied activation page, and polls only at Trakt's requested
interval until authorization succeeds, expires, is denied, or fails.

Credentials, access tokens, refresh tokens, and expiry data are stored locally
in IINA plugin preferences. Access tokens are refreshed automatically.
Disconnect removes tokens while retaining credentials and local watch history.

## Local Progress

Local history remains the immediate source for the UI and the fallback when
Trakt is unavailable. Each history entry stores an exact playback percentage in
addition to its existing metadata, timestamp, and watched state.

Progress is persisted:

- every 30 seconds while playing
- when playback pauses
- when playback stops or the window closes
- at natural end-of-file

Legacy history entries without a progress value continue to load. Watched
entries migrate to 100 percent and unfinished entries retain their existing
recent status without inventing an exact position.

## Trakt Playback Events

The plugin identifies movies with IMDb IDs. Episodes use the show's IMDb ID
plus the existing season and episode numbers.

When connected:

- file playback or resume sends a Trakt scrobble start event
- pause sends a scrobble pause event
- closing or stopping below the plugin's watched threshold sends pause
- reaching the watched threshold or natural end sends stop

Network activity is asynchronous and never delays or interrupts playback.

## Synchronization

Synchronization runs after connecting, when Popcorn opens, and when the user
chooses Sync Now.

The plugin retrieves Trakt playback progress and watched history and merges it
with local history by media identity:

- the newest timestamp determines unfinished playback progress
- watched state is sticky if either source marks the item watched
- duplicate movie or episode entries collapse into one local entry
- remote-only entries are added using Trakt titles and identifiers
- Cinemeta supplies posters and other display metadata when available

The first successful connection uploads existing locally watched items to
Trakt. Partial local items remain local until they are played again, avoiding
synthetic scrobble events for old sessions.

## User Experience

The existing Recent poster grid remains the single place for local and Trakt
history. Unfinished cards show a thin progress bar and percentage.

Opening an unfinished item follows the existing episode and stream selection
flow. After a stream loads, IINA automatically seeks to the saved percentage.
Watched items start from the beginning.

Remote items without artwork use the existing poster fallback until Cinemeta
metadata is available.

## Failure Handling

- Trakt failures never prevent local tracking or playback.
- Expired access tokens refresh automatically.
- Failed refresh changes the status to reconnect required.
- Rate-limit responses respect `Retry-After`.
- Device authorization polling respects Trakt's interval and expiry values.
- Sync errors are displayed in Preferences without repeated playback alerts.
- Disconnect removes authentication tokens but preserves local history.

## Testing

Automated tests cover:

- defensive parsing and migration of local progress
- merge ordering, deduplication, watched-state behavior, and conflicts
- Trakt authentication and token refresh responses
- correct movie and episode scrobble payloads
- playback event to scrobble action mapping
- resume-position selection
- offline and API-failure behavior
- rate-limit and device-code polling rules

Build, type checking, and the existing plugin tests must continue to pass.

## Alternatives Rejected

### Hosted authentication proxy

This protects a shared client secret but adds hosting, operations, and a service
dependency. It is unnecessary when users supply their own Trakt credentials.

### Bundled shared Trakt credentials

This is easier for users but exposes one shared secret in an open-source plugin
and allows abuse to affect every installation.

### Local-only exact progress

This requires the least code but cannot provide cross-device progress or import
watched history from other clients.
