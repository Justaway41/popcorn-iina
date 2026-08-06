# Stream Display Metadata Design

## Goal

Make decorated AIOStreams and Comet results readable while showing cache state and seeders without claiming metadata the addon did not provide.

## Data normalization

Extend `PlayableStream` with:

- `rawTitle`: untouched provider title for the tooltip.
- `cached`: `true`, `false`, or `null` when unknown.
- `seeders`: a non-negative integer or `null` when unknown.

Build the visible title from `behaviorHints.filename` when present, otherwise use the existing title/description/name fallback. Remove the file extension and decorative emoji, normalize dot and underscore separators, collapse whitespace, join separate season and episode tokens, and remove resolution and file-size tokens already shown elsewhere. If cleanup produces no useful text, retain the existing provider title.

Read metadata in this order:

1. Structured AIOStreams `streamData` fields.
2. Standard `behaviorHints` fields for filename and size.
3. Conservative, documented AIOStreams and Comet markers in `name`, `title`, and `description`.

Cache parsing is tri-state. Recognized cached and uncached markers produce a badge; conflicting or absent markers produce `Cache ?`. Seeder parsing accepts structured non-negative integers and explicit labels or known seeder symbols followed by an integer. It never treats unrelated numbers as seeders.

## Interface

Keep the existing stream row layout. The primary line uses the cleaned title and exposes the untouched provider text through its tooltip. The metadata line keeps addon, quality, audio, subtitle, and size information, and adds:

- `Cached` in green when verified.
- `Uncached` in a warning color when verified.
- `Cache ?` in the neutral style when unknown.
- `<count> seeders` only when a value is available.

Do not show a zero or unknown seeder badge unless the addon explicitly reports zero.

## Failure handling

All new fields are optional at the provider boundary. Malformed structured metadata or unfamiliar formatter text falls back to `null`; the stream remains playable and retains a usable title.

## Verification

Add parser tests covering structured AIOStreams data, Comet markers, custom formatted text, conflicts, missing metadata, filename cleanup, and fallback titles. Add UI tests for the three cache states, known seeders including zero, hidden unknown seeders, and the raw-title tooltip. Run the full test suite, both TypeScript typechecks, production build, manifest verification, and package integrity check.
