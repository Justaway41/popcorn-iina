# Season and Stream UI Design

## Goal

Make long series and stream lists easier to understand without adding network requests or dependencies.

## Design

- Render each season as a native `<details>` section, collapsed initially and independently expandable.
- Keep the current title and back button visible by making their existing row sticky below the app header.
- Treat an episode as unavailable only when Cinemeta's `firstAired` value is a valid future date. Disable and mute the row, and show `Available <date>`.
- Extract a recognizable language from addon stream text and show it beside quality and size. If no language can be inferred, omit the label.
- Preserve the addon's stream title. Continue using `Stream` when the addon provides no title, description, or name.

## Data Flow

Cinemeta episode metadata remains the only source of release availability. The configured Stremio addon remains the only source of stream metadata. No episode-by-episode availability requests are made.

## UI Direction

Keep the existing compact IINA-native dark interface. Season summaries become the navigation signature: a quiet disclosure chevron, season name, and episode count. Unavailable episodes use reduced contrast and no play icon. Stream metadata stays in small, scannable pills/text below the source title.

## Testing

- Unit-test future-date availability, including invalid and already-aired dates.
- Unit-test language extraction and fallback behavior in stream parsing.
- Run the full test, typecheck, and build commands.
