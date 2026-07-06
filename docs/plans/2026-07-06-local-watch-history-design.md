# Local Watch History Design

## Goal

Track Popcorn playback locally and make recent and watched items visible without adding an account, server, or dependency.

## Behavior

- Add a movie or episode to local history once playback reaches 5%.
- Mark it watched at 90% or natural EOF.
- Store the newest 100 items in IINA plugin preferences.
- Show the newest 6 items above Trending on the home screen using the existing poster grid.
- Add a `See all` action that opens a full Recently Watched page, newest first.
- Make Back return from Recently Watched to the previous home/search state.
- Show a watched checkmark on matching movie cards and episode rows.
- Clicking a recent movie opens its streams. Clicking a recent episode reloads its series episodes, then opens that episode's streams so next-episode behavior remains available.

## Data Model

Each entry stores the media metadata already used by the UI, an optional episode, the last-played timestamp, and watched status. Stream URLs are not persisted because addon results can expire.

Malformed stored JSON or entries are ignored. History writes occur only when crossing the 5% and 90% thresholds, avoiding repeated preference writes during playback.

## Architecture

Pure history parsing and update logic lives in a shared module and is unit-tested. The main plugin owns IINA preference reads/writes and playback percentage checks. The sidebar receives history through plugin messages and renders the home section, full history view, and watched indicators.

## Testing

- Parse malformed and valid stored history defensively.
- Add, deduplicate, reorder, cap, and mark entries watched.
- Verify 5% and 90% playback thresholds.
- Run the complete test, typecheck, build, manifest, and package checks.
