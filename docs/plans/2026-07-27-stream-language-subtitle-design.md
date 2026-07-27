# Stream Language and Subtitle Badges

## Goal

Make stream rows answer two questions without opening playback:

- Which audio language is declared?
- Are English subtitles available?

## Design

Parse every recognized audio language from the stream name, title, and
description. A single language is shown directly. Multiple languages use a
`Multi (N)` badge whose native tooltip lists every language. Generic `Multi`
or `Dual Audio` labels remain when the provider does not name the languages.

Parse per-stream subtitle objects from the Stremio stream response and query
the official OpenSubtitles v3 subtitle resource once per movie or episode.
The row combines both sources:

- `EN Subs` when either source declares English subtitles.
- `No EN Subs` when the lookup completed and neither source has English.
- `Subs ?` when subtitle availability could not be determined.

Stream loading remains successful if the subtitle service fails. Audio and
subtitle parsing is defensive, deduplicated, and tested independently of the
DOM. The UI uses native `title` tooltips, avoiding a custom tooltip component.

