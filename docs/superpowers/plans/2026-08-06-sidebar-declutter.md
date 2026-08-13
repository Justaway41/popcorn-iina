# Sidebar Declutter — Design Plan

Date: 2026-08-06
Status: implemented 2026-08-07, awaiting manual IINA verification
Scope: series screen, stream screen, app chrome
Decisions locked: season chip strip; text-only episode rows with mono numbers

## Problem

Measured from the current build, not from impressions.

**Stream screen.** `buildStreamDetails` (`src/ui/app.ts:756`) emits up to seven elements per
row and four of them fire unconditionally. Two real screenshots of the same episode:

| Screen | Chips rendered | Chips that vary between rows |
| --- | --- | --- |
| Dark S03E04, 3 rows | 15 | 1 (size) |
| Dark S03E04, 4 rows | 20 | 1 (`German`) |

`AIOStreams | ElfH…`, `Cache ?` / `Uncached`, `4K` / `WEBRip`, `EN Subs` repeat on every
row. `.row-detail` is `flex-wrap` (`ui/sidebar.css:258`), so each row wraps to two or three
ragged lines and one row costs ~130px. Three streams fit on screen at a time.

Row titles restate `Dark · S03…`, which the section header already shows. The one fact that
actually separates the rows — release group, audio language, size — is either truncated away
at the end of the title or set in the smallest muted text at the end of the wrap.

**`quality` conflates two different facts, and it breaks next-episode playback.**
`src/shared/stremio.ts:313` matches resolution and source type from a single alternation:

```ts
quality: metadata.match(
    /\b(4K|(?:2160|1440|1080|720|576|480|360|240)p|HDRip|BRRip|WEBRip)\b/i
)?.[0] || "",
```

Leftmost match wins, so the field holds whichever token happens to appear first in
`name + title + description + filename`. A stream with no resolution token anywhere reports
`WEBRip`; the same release with `2160p` earlier in the filename reports `2160p`. The value is
arbitrary, and `getQualityClass` (`src/ui/app.ts:849`) then paints a source type with
resolution styling.

This is a live functional bug, not only a visual one. `findClosestQualityStream`
(`src/shared/stremio.ts:161-165`) discards every stream whose `qualityHeight()` is null, and
`qualityHeight` parses only `4K` and `NNNp`. Streams whose `quality` came out as `WEBRip` are
invisible to it. When an addon returns a list with no resolution tokens — as in the second
Dark S03E04 screenshot, four of four `WEBRip` — `known.length === 0`, the function returns
`null`, and the **"Play Next Episode" row never renders at all**.

**Series screen.** `renderEpisodes` (`src/ui/app.ts:603`) builds every season as a closed
`<details>`, and `openSeasons` is empty on first load, so arriving at a show shows zero
episodes — a stack of accordion headers plus an `Oldest First` / `Newest First` toggle. Two
clicks minimum before an episode is visible. Episode rows print `formatDate(episode.aired)`
for already-aired episodes (`3/14/2008`), carry no resume indicator, and reduce watch state to
a binary check.

**Chrome.** 58px brand header + 46px search + 31px section header = 135px of sticky chrome
before any content. Search is rendered on episode and stream views, where submitting it throws
the user back to home.

**Color.** Six semantic hues compete: accent cyan, quality blue/green/amber/grey, cache
green/amber, subtitle green. Quality is colored — a fact that never changes whether the click
works — at the same visual weight as cache state, which does.

## Measured addon payload (2026-08-06)

One AIOStreams response for Dark S03E04, key shape only:

```
streams: 195
top-level keys:   behaviorHints, description, externalUrl, name, streamData, url
streamData keys:  error, id, type
behaviorHints.filename       193 / 195
behaviorHints.videoSize      190 / 195
streamData.service.cached      0 / 195
streamData.cached              0 / 195
streamData.torrent.seeders     0 / 195
subtitles[]                    0 / 195
```

Three consequences.

**No structured metadata beyond filename and size.** The structured-first paths in
`parsePlayableStreams` for cache, seeders, and subtitles never fire for this addon. Every badge
on screen is regex output.

**`metadata` is the wrong parse input.** `src/shared/stremio.ts:302` concatenates
`name + title + description + filename`. `description` is ~161 characters of emoji, service
labels, and marketing text, and it is why resolution matching is arbitrary. `filename` is an
81-character scene release name with deterministic token positions
(`Dark.S03E04.2160p.NF.WEB-DL.DDP5.1.HDR.HEVC-GreenBlood.mkv`). Parse `filename` first and fall
back to the concatenation only when absent — 2 of 195 streams.

**English subtitles cannot vary per stream.** `stream.subtitles` is empty on all 195, so
`parseSubtitleLanguages` returns `null` every time and the badge is driven entirely by the
per-episode OpenSubtitles lookup. It is structurally constant across the list. It belongs in the
header, not the rows.

**195 streams is the real clutter.** At today's ~130px rows that is roughly 25,000px of scroll;
even at the 44px target it is ~8,500px. Row density alone does not make 195 options browsable —
the list needs grouping.

## Verified against live data (2026-08-06)

The proposed parser was run beside the repo's current `parsePlayableStreams` on a live
AIOStreams response for Dark S03E04 — 196 playable streams of 197 returned.

| Metric | Current | Candidate |
| --- | --- | --- |
| resolution parsed | 113 / 196 (58%) | **163 / 196 (83%)** |
| `quality` holds a source token instead | 66 / 196 (34%) | n/a — fields are separate |
| source parsed | n/a | 150 / 196 (77%) |
| invisible to `findClosestQualityStream` | 83 / 196 (42%) | **33 / 196 (17%)** |
| cache unknown | 51 | **0** |
| cache cached / uncached | 69 / 76 | 69 / 127 |
| regressions (current parsed, candidate lost) | — | **0** |

Resolution provenance: filename 157 (80%), other payload text 0 (0%), standard abbreviation
alias 6 (3%).

**The payload-text fallback is worthless for resolution and must not be built.** When a filename
carries no resolution, `name` is `💩 Unknown` — AIOStreams derives its own resolution from the
same filename, so no independent second source exists. The fallback is retained for `source`
only, where it lifted parsing from 61% to 77% by reading the `🎥 WEBRip` description line.

**83% is the data ceiling, not a parser shortfall.** The 33 unparsed streams genuinely contain
no resolution anywhere:

```
Dark.S03E04.avi
Dark - S03E04 - The Origin.mkv
Dark.3x04.WEBRip.XviD.Ita.Eng.Deu.Ac3.Earine.avi
Dark - Temporada 3 [HDTV][Cap.304][Castellano]
```

Legacy XviD/HDTV rips, which AIOStreams also labels `💩 Unknown`. They belong in a real `other`
tier, not hidden.

**Cache fix confirmed, and cache is known for every stream.** Marker coverage measured directly
on 193 playable streams:

| Marker in payload text | Count |
| --- | --- |
| `⚡Ready` | 69 (36%) |
| `❌ Not Ready` | 124 (64%) |
| neither | **0 (0%)** |
| debrid service tag `(TB)` | 193 (100%) |

The candidate's verdict matches marker presence exactly — 69 cached, 124 uncached, 0 unknown.
Every verdict traces to an explicit statement in the payload, not a heuristic guess. Unknown
fell 51 → 0 while the cached count stayed at exactly 69, so nothing was flipped into a false
positive; every resolved case was a genuine uncached stream the emoji collision had masked.

Two caveats that must stay true for this to hold. The template has to keep emitting its cache
line — `{service.cached::istrue["⚡Ready "]}` is the only channel, since `streamData.service.cached`
is 0/193. And a debrid service must be attached; `(TB)` on 100% confirms TorBox here. An addon
with no debrid cannot report cache at all, which the design handles by omitting the dot.

**64% of streams are uncached**, so clicking blind carries a two-in-three chance of a download
wait. Availability, not file size, is the real bottleneck — see the sort rule below.

**Measured tier distribution.**

```
1080p: 84    720p: 41    2160p: 33    other: 33    480p: 3    576p: 2
```

This overturns the assumption that the top resolution tier is the largest — 2160p is third.
Defaulting to the highest tier would open 33 rows while the 84-row 1080p tier stays collapsed.
Default to the highest tier that contains cached streams, falling back to the largest tier.

**Audio is the remaining weak field**, 64% with no language parsed. The payload carries flag
emoji on 36% of streams (`🗣️ 🇬🇧 / 🇮🇹`, emitted by `{stream.languageEmojis}`) and filename
language hints on 31%. Decoding Unicode regional-indicator pairs is generic and addon-neutral;
it is the highest-value follow-up after this plan and is not included in it.

**AIOStreams is wrapping Comet.** Descriptions show `📡 Comet|StremThru`, `📡 Comet|DMM`, and
`🔍Comet`, with `(TB)` as the service. A separately configured Comet addon may duplicate results
already arriving through AIOStreams — confirm before designing multi-addon behavior.

## Root cause: template label collision

The user's AIOStreams custom formatter maps resolutions to decorated labels before they reach
Stremio's `name` field:

```
'2160p' -> '🔥4K UHD'   '1440p' -> '✨ QHD'   '1080p' -> '🚀 FHD'   '720p' -> '💿 HD'
'576p'/'480p'/'360p'/'240p'/'144p' -> '💩 Low Quality'   (none) -> '💩 Unknown'
```

Confirmed by the probe: `streams[0].name` is 8 characters, matching `🔥4K UHD`.

**Resolution.** `src/shared/stremio.ts:313` matches literal `4K|2160p|1080p|720p…`. After the
mapping only `🔥4K UHD` still contains a literal token (`4K`). Every non-4K stream parses no
resolution, falls through to the source alternation, and renders `WEBRip` in the resolution
slot. This is the difference between the two screenshots of the same episode — the 4K tier
parsed, the FHD tier did not.

**Cache.** `parseCacheStatus` (`src/shared/stremio.ts:375-379`) lists `🚀` as a *cached* marker.
The 1080p label is `🚀 FHD`, and the template's cache line emits `❌ Not Ready`, which is an
*uncached* marker. Both sets match, `cached === uncached`, the function returns `null`, and the
row shows `Cache ?`. Every 1080p stream reports unknown cache regardless of its true state. The
4K label uses `🔥`, does not collide, and parses correctly.

Both defects are the same failure: scraping decorated presentation text for facts. Any template
edit reshuffles them. The plan's parser changes must remove that dependency rather than
accommodate one particular template.

## AIOStreams parsed model

The formatter exposes a full parsed model, which settles two open design questions.

`stream.resolution` and `stream.quality` are **separate fields** — `2160p` versus
`BluRay`/`WEB-DL`. The `resolution` / `source` split proposed below mirrors the addon's own
model rather than inventing a distinction.

Available and currently unread by Popcorn: `stream.encode`, `stream.audioTags`,
`stream.audioChannels`, `stream.releaseGroup`, `stream.indexer`, `stream.bitrate`,
`stream.type` (`p2p` / `usenet` / `http` / `live`), `stream.duration`, `service.shortName`,
`stream.proxied`, `stream.private`, `stream.library`.

`service.cached` exists **only** as a formatter variable and never appears in `streamData`
(0/195 measured). Cache state cannot be obtained structurally from this addon; text remains the
only channel, which is why the cache heuristic below must be made collision-proof.

## Direction

The sidebar sits beside a playing video. It is an instrument panel, not a page. Its only job is
the shortest path from "I want this" to "playing".

One rule drives every change below:

> **Anything identical on every row is chrome. Hoist it once to the top and delete it from the
> rows. Only what varies earns per-row space.**

This is why the current screen feels cluttered despite each individual badge being defensible.
Each badge is defensible; twenty of them saying four things is not.

### Tokens

**Color** — cut from six semantic hues to three. Quality and subtitle colors are deleted
outright; they become plain mono text.

| Token | Value | Sole use |
| --- | --- | --- |
| `--bg` | `#151516` | page (unchanged) |
| `--surface` | `#212124` | raised chrome, hover (unchanged) |
| `--text` | `#f5f5f7` | primary (unchanged) |
| `--muted` | `#98989f` | all metadata text (unchanged) |
| `--accent` | `#22b8e6` | focus ring, resume bar, active chip — interaction only |
| `--ok` | `#3bd37f` | cache-ready dot only |
| `--warn` | `#eab131` | uncached dot only |

`--ok` and `--warn` may only appear as a 6px dot. No filled pills, no colored text.

**Type** — two roles, both already on macOS, no webfont and no dependency.

- Body / UI: `-apple-system, "SF Pro Text"` at 13px (unchanged).
- Data: `ui-monospace, "SF Mono", Menlo` at 11px for episode numbers, sizes, resolutions.

The mono column is not decoration. Tabular figures give the list a straight vertical edge, so
comparing forty stream sizes is a single downward read instead of forty separate fixations.

**Layout**

| Surface | Now | Target |
| --- | --- | --- |
| Chrome above content | 135px | ~78px (home), ~40px (detail views) |
| Stream row | ~130px | ~44px |
| Streams visible | 3 | 9 |
| Episode row | ~42px | 40px, second line only when resuming |

**Signature** — the straight edge. Every row in every list aligns on a right-hand mono column,
and the only color in the entire list is a single state dot. The list reads as one instrument
scale rather than a stack of cards.

## Stream screen

### Parse the filename, split `quality` into `resolution` and `source`

Prerequisite for everything below, and a bug fix in its own right. Parse from `filename` when
present, falling back to the concatenated metadata only when it is not (2 of 195 streams).
Two independent matches, either allowed to be empty:

```ts
const RES = /\b(4K|(?:2160|1440|1080|720|576|480|360|240)p)\b/i;
const SRC = /\b(WEB-?DL|WEBRip|BluRay|BRRip|HDRip|REMUX)\b/i;
// Standard abbreviations, not addon-specific. Last resort; 3% of streams measured.
const ALIAS: Array<[RegExp, string]> = [
    [/\b(?:4K\s*)?UHD\b/i, "2160p"], [/\bQHD\b/i, "1440p"],
    [/\bFHD\b/i, "1080p"], [/\bHD\b/i, "720p"]
];

// Filename only. Measured: payload text yields 0 additional resolutions, because the
// addon derives its own label from this same filename. Do not add that fallback.
resolution: normalize(filename.match(RES)?.[0]) || aliasResolution(metadata) || "",
// Payload text does help here — measured 61% -> 77%.
source: (filename.match(SRC) || metadata.match(SRC))?.[0] || "",
```

`parseAudioLanguages` takes the same input for the same reason — `description` is what injects
false language hits, since it lists service and subtitle languages alongside audio ones.

Filename is immune to template decoration. All four AIOStreams preview scenarios carry a literal
resolution there, including the anime bracket form:

```
Movie.Title.2023.2160p.BluRay.HEVC.DV.TrueHD.Atmos.7.1.iTA.ENG-GROUP.mkv
Series.Title.S02E05.The.Episode.Name.1080p.WEB-DL.DDP5.1.H.264-GROUP.mkv
[SubsPlease] Anime Title - 13 (1080p) [A1B2C3D4].mkv
Series.Title.S02.COMPLETE.2160p.WEB-DL.DV.HDR10.DDP5.1.H.265-GROUP
```

This works for Comet and any other addon without configuration, which is why it is preferred
over asking the user to keep a template in sync.

`normalize` folds `4K` to `2160p` so grouping does not split one tier across two spellings.
`aliasResolution` is the 3% last resort; it must run only after the filename match fails, and
`\bHD\b` is safe against `HDTV`/`HDR` because those have no word boundary after `HD`.

### Make cache detection collision-proof

`parseCacheStatus` currently treats a decorative `🚀` as a cache marker, so a resolution label
can invert a cache reading. Word markers are unambiguous; emoji are decoration. Check words
first and consult emoji only when no word matches:

```ts
function parseCacheStatus(value: string): boolean | null {
    const positive = /\b(?:cached|instant|ready)\b/i.test(value);
    const negative = /\b(?:uncached|not\s+ready|download(?:ing)?)\b/i.test(value);
    if (negative) return false;          // explicit negative always wins
    if (positive) return true;
    const cachedEmoji = /⚡|\[[^\]\r\n]{1,20}\+\]/.test(value);
    const uncachedEmoji = /⬇|⏳/.test(value);
    return cachedEmoji === uncachedEmoji ? null : cachedEmoji;
}
```

`🚀` is dropped from the marker set entirely — it is a common decorative label glyph and cannot
be trusted. Negative precedence is deliberate: showing a cached stream as uncached costs a
wasted click, while showing an uncached stream as ready sends the user into a download wait with
no warning.

Regression test: a stream whose text contains both a decorative `🚀` and `❌ Not Ready` must
parse as uncached, not `null`.

`findClosestQualityStream` then reads `resolution`, which is what it always meant, and stops
discarding streams that merely lacked a resolution token. `PlayItem`'s `playbackContext.quality`
carries `resolution` for the same reason. `source` is display-only and folds into the title
line; it never occupies the resolution slot.

Keep `quality` as a deprecated alias only if a migration needs it — otherwise delete it, since
`src/plugin/main.ts` and `src/shared/messages.ts` are the only other readers.

Regression tests to add in `src/shared/stremio.test.ts`:

- title with a source token and no resolution → `resolution: ""`, `source: "WEBRip"`
- title with both, source first → both parsed correctly, resolution not shadowed
- a list where every stream lacks a resolution → `findClosestQualityStream` still returns a
  stream (the current failure that kills the next-episode row)

### Constants hoisting

Before rendering, compute which fields are actually constant across the returned streams.
Constants render once in a summary line under the header; everything that varies stays on the
row. Hoisting is computed from the real list at render time and never assumed — a field only
leaves the rows when every stream agrees on it.

For the measured Dark S03E04 list, addon name and EN subs are constant and hoist; resolution
and cache vary and stay on the rows.

### Grouping by resolution

Density alone does not solve ~196 streams. Group into resolution tiers, counts in the header,
one tier open, the rest collapsed. Render ~8 rows per tier before a "show N more" control. The
existing size sort operates inside the open tier.

Measured distribution is `1080p:84  720p:41  2160p:33  other:33  480p:3  576p:2`. The top
resolution tier is **not** the largest, so "open the highest tier" would expose 33 rows while
84 rows stay hidden. Open the highest tier that contains cached streams; fall back to the
largest tier when none are cached.

Each tier header carries a ready count next to its total — `2160p · 14 ready · 33`. Tiers with
no cached streams omit the ready label rather than printing a zero, so the label only ever
appears when it means something. Measured: `2160p 14/33`, `1080p 33/84`, `720p 10/41`,
`other 12/33`, and none in 480p or 576p.

### Cached-first sort

The existing control sorts by file size only, which optimizes for quality while the actual
bottleneck is availability — 64% of the measured list is uncached.

Cache state becomes the **primary** sort key inside a tier; the existing Largest/Smallest
toggle becomes the secondary key. No new control, one comparator:

```ts
const rank = (cached: boolean | null) => cached === true ? 0 : cached === null ? 1 : 2;
// cached first, unknown next, uncached last; then the user's size preference
streams.sort((a, b) => rank(a.cached) - rank(b.cached) || sizeCompare(a, b, sizeOrder));
```

Unknown sits between cached and uncached deliberately: it might play instantly, so it should
not be buried below streams known to require a download.

Uncached rows also step their title back one shade, so the ready options lead the eye without
the uncached ones being hidden or disabled.

The accordion pattern is wrong on seasons — you always want to see episodes — and right here,
where you want exactly one resolution tier at a time.

Wireframe reproduces the rendered mock, which is generated from the live response.

```
┌──────────────────────────────────────────┐
│ ‹  Dark · S03E04 · The Origin            │
├──────────────────────────────────────────┤
│ 196 streams · AIOStreams · EN subs       │
│                              LARGEST ⇅   │
├──────────────────────────────────────────┤
│ ⌄ 2160p    ● 14 ready              33    │
│   ● Der Ursprung WEBRip DV HDR10  11.9 GB│
│     WEBRip · Dual Audio                  │
│   ● NF WEBRip DDP5 1 x265-NTb      7.94 GB│
│     WEBRip                               │
│   ● The Origin NF WEB-DL DUAL      7.26 GB│
│     WEB-DL · Dual Audio                  │
│   ⌄ show 25 more                         │
│ › 1080p    ● 33 ready              84    │
│ › 720p     ● 10 ready              41    │
│ › 576p                              2    │
│ › 480p                              3    │
│ › other    ● 12 ready              33    │
└──────────────────────────────────────────┘
```

Filled dot = ready now, hollow amber ring = will download, no dot = not reported.

Streams with no parsed resolution land in `other` rather than being hidden. This grouping is
only as good as the resolution parse, which is why the filename fix above is a prerequisite
rather than a nicety.

Row anatomy:

- Line 1: cleaned release title, single line, ellipsis, `rawTitle` on hover (already built).
  Right-aligned mono size — the primary discriminator, promoted from last-and-dimmest.
- Line 2: rendered **only if** something varies. Muted mono, plain text, no pills:
  `2160p · German · no EN`.
- Leading dot: cache state. Filled `--ok` = cached, hollow `--warn` ring = uncached, absent =
  unknown. Suppressed entirely when cache state is constant across the list (it moves to the
  summary line).
- `▶` affordance appears on hover/focus only, not painted on every row.

### Field rules

| Field | Now | Proposed |
| --- | --- | --- |
| Addon name | pill, every row, truncated to `AIOStreams \| ElfH…` | summary line when constant; short mono suffix on the row only when sources differ |
| Cache | pill, every row, incl. `Cache ?` | dot when varying, summary line when constant, nothing when unknown |
| Resolution | colored pill, shares a field with source | own parsed field, mono text on line 2, no color |
| Source (`WEBRip`) | colored pill in the resolution slot | own parsed field, folded into the title line, never the resolution slot |
| Audio | pill, `Audio ?` on every row | line 2 only when a language is known and varies |
| Subtitles | green `EN Subs` pill every row | header summary. Measured: `stream.subtitles` is empty on 195/195, so this is a per-episode fact and can never vary per row. Per-row `no EN` only if an addon actually populates `stream.subtitles` and they differ |
| Seeders | pill when present | line 2 only when cache is uncached or unknown, i.e. when it predicts the wait |
| Size | smallest muted text, last | mono, right-aligned, line 1 |

**Handbook rule preserved.** "Keep unknown states distinct from negative states" still holds:
cached is a filled dot, uncached a hollow ring, unknown nothing at all; subtitles are `EN` in
the summary, `no EN` on the row, or absent. Absence is the unknown state — it is distinct from
both, and it does not cost a line on every row to say so. Every hoisted constant keeps its
tooltip on the summary line.

### Title cleaning

`parsePlayableStreams` in `src/shared/stremio.ts` already cleans display titles and retains
`rawTitle`. Extend the cleaner to strip a leading series/season/episode prefix that duplicates
the header (`Dark S03 ·`, `Dark Season 3`, `Dark · S03E04`). `Dark S03 · WEBRip KvK CasStudio
TK` becomes `KvK CasStudio TK`. Fix at the parser, not per caller — the handbook names this as
the normalization boundary.

## Series screen

Season chip strip. Chips are horizontal, mono, one season's episodes shown at a time. Default
selection is the season containing the next unwatched episode; first season otherwise.

```
┌──────────────────────────────────────┐
│ ‹  Breaking Bad                      │
├──────────────────────────────────────┤
│ [S1]  S2   S3   S4   S5              │
├──────────────────────────────────────┤
│ 01   Pilot                       ✓   │
│ 02   Cat's in the Bag…           ✓   │
│ 03   …and the Bag's in the River  ✓  │
│ 04   Cancer Man                      │
│      ▰▰▰▰▱▱▱▱▱▱                      │
│ 05   Gray Matter                     │
│ 06   Crazy Handful of Nothin'        │
│ 07   A No-Rough-Stuff-Type Deal      │
│ 08   Seven Thirty-Seven          ·   │
└──────────────────────────────────────┘
```

- Mono episode number in a fixed left column — the straight edge again.
- Second line appears only for a partially watched episode (resume bar, `--accent`).
- Aired date deleted for aired episodes. Unaired episodes keep `Airs 14 Mar` and stay disabled.
- Watched is a dimmed title plus a trailing check, not a badge.
- Season chip carries a small dot when that season holds the next unwatched episode.

**Episode order toggle stays inline.** Decided. It keeps its current behavior and the stored
`episodeOrder` preference, but it moves onto the season chip row as a right-aligned control
rather than occupying its own full-width band, so it costs no extra vertical space. Existing
tests in `src/ui/app.test.ts` around `getEpisodeOrderLabel` and `getEpisodeOrderButtonId` stay
valid.

## Chrome

- Brand block collapses to a 22px icon plus the Movies/TV switch on one 40px row, home only.
- Detail views (`episodes`, `streams`, `history`) render a single 40px bar: back chevron plus
  title. Search is hidden there — submitting it currently discards the view.
- Section header merges into that bar instead of stacking a third sticky strip.
- `Largest File` / `Smallest File` toggle moves inline into the summary line so it stops
  colliding with the right edge as it does in the screenshot.

## Files

Per the handbook repository map. Owner file first, colocated test with it.

| Change | File | Test |
| --- | --- | --- |
| Split `quality` into `resolution` + `source`; fix `findClosestQualityStream` | `src/shared/stremio.ts` | `src/shared/stremio.test.ts` |
| Carry `resolution` in `playbackContext.quality` | `src/shared/messages.ts`, `src/plugin/main.ts` | `src/plugin/playback.test.ts` |
| Strip duplicated series prefix from stream titles | `src/shared/stremio.ts` | `src/shared/stremio.test.ts` |
| Constants hoisting, row rendering, season chips, episode rows | `src/ui/app.ts` | `src/ui/app.test.ts` |
| Token cut, mono data column, row/chip/chrome styles | `ui/sidebar.css` | — |
| Header collapse, search visibility | `ui/sidebar.html` | — |
| Episode order preference, only if moved | `src/ui/preferences.ts` | `src/ui/preferences.test.ts` |
| Regenerated, never hand-edited | `ui/dist/sidebar.js` | — |
| Behavior and ownership changes | `AGENTS.md` | — |

New pure helpers, exported and unit-tested alongside the existing `getAudioBadge` /
`getCacheBadge` group:

- `sortStreamsBySize` gains a cache-rank primary key (or a sibling `sortStreamsForPlayback`)
  so cached streams lead inside a tier while the size preference still orders within that.
- `getVaryingStreamFields(streams)` → which of addon / cache / resolution / audio / subtitles
  differ across the list. One function replaces five per-row badge builders; it deletes more
  code than it adds. Ceiling: recomputed on every render — fine at 195 streams, revisit only if
  a list an order of magnitude larger shows up. Mark with a `ponytail:` comment.
- `buildStreamSummary(streams, varying)` → the constants line.
- `groupStreamsByResolution(streams)` → ordered tiers plus an `other` bucket for unparsed.
- `getDefaultSeason(episodes, history)` → season holding the next unwatched episode.

## Deferred: structured addon output

Considered and deliberately not built. The formatter can emit labeled fields that parse
deterministically, and AIOStreams' parsed model is rich enough to supply everything Popcorn
displays.

Deferred because the filename fix covers resolution, source, encode, group, and audio with no
user configuration, and the cache precedence fix covers the one fact filenames cannot carry.
Building a template contract on top would add a second parse path, a fallback path, and a
document the user must keep in sync with a manifest URL that changes on every reconfigure — to
buy facts the plan already gets for free.

The user runs Comet as well as AIOStreams. Comet's config surface has not been verified and must
not be assumed to match. A filename parser serves both today; a template contract would have to
be designed twice.

Revisit only if, after both fixes ship, re-running the probes still shows frequent `?` states.
If built, it must be a generic labeled convention Popcorn documents and parses from any addon
that emits it — never an `if (addon is AIOStreams)` branch, which `AGENTS.md:99` forbids.
Surface it per-addon in `src/ui/preferences.ts` alongside a parse-quality indicator showing
whether that addon's last response parsed cleanly or fell back; the indicator is the more useful
half, and it would have surfaced the label collision above immediately.

### Optional template tweak

Independent of any code. Replacing `🚀` in the 1080p label removes the cache collision today,
before the parser fix ships. It is relief, not a dependency — the cache precedence fix must make
Popcorn correct under any template, including this one unchanged.

`rowButton` (`src/ui/app.ts:860`) is shared by episode and stream rows. Change it once there
rather than forking two row builders.

## Verification

```sh
bun test src/shared/stremio.test.ts src/ui/app.test.ts
bun run typecheck
```

Then full source verification:

```sh
bun test
bun run typecheck
git diff --check
```

Then, because `src/ui/` affects runtime bundles:

```sh
bun run build
bun run package
bun run verify:root-info
bun run verify:built-client-version
unzip -t xyz.brbc.popcorn.iinaplugin.iinaplgz
```

Manual IINA checks required: sidebar at 260px and at wide widths, season chip strip on a
20-season show, a stream list where addons genuinely differ (constants hoisting must not hide a
real difference), keyboard focus through chips and rows, an uncached/cached mixed list, and
next-episode prefetch on a series whose addons return no resolution tokens — that path is
currently broken and must produce a "Play Next Episode" row after the fix.

## Constraints carried in

- The working tree already holds an uncommitted uninstall-crash fix awaiting manual IINA
  verification. Do not overwrite, revert, or stage it. Preserve all unrelated dirty files.
- No new dependencies. Both typefaces ship with macOS; the resume bar and chips are CSS.
- No `setInterval` anywhere in plugin runtime entries.
- Never hand-edit `dist/` or `ui/dist/`.
- Manifest URLs may carry private debrid credentials. Addon labels shown in the summary line
  use the addon **name** only — never the manifest URL, path, or query string, and never in a
  screenshot or fixture.
- Quality floor: visible keyboard focus on chips and rows, `prefers-reduced-motion` respected,
  layout holds at the 260px breakpoint.

## Expected result

Dark S03E04, 195 streams: addon name and EN subs collapse into one summary line, the list
groups into four resolution tiers with the top tier open, and each row becomes a title plus a
mono size. Rows drop from ~130px to ~44px, and the initial render goes from 195 rows and
~25,000px of scroll to roughly 8 rows plus three collapsed headers. Arriving at a series shows
episodes immediately instead of a closed accordion stack. The only color left in either list is
one state dot and the resume bar. Separately, resolution parsing becomes reliable and
next-episode prefetch starts working on addons that omit resolution tokens from their titles.

## Open questions

- No screenshot of the real IINA series screen has been reviewed; the implementation was verified
  by rendering the shipping `ui/dist/sidebar.js` in headless Chrome against the live response.

Closed: `streamData.error` is populated on 0 of 197 streams. The only non-playable entry is an
informational `🚫 Removal Reasons` banner with no `url`, which the existing `isHttpUrl` check
already drops - no filtering work needed. The tier row cap follows the ready count
(`clamp(ready, 5, 15)`), and the last opened tier is remembered for the session and reused when it
still has streams.

Closed: the episode order toggle stays inline. Comet needs no dedicated work — the filename
parser is addon-neutral by construction and covers it, and constants hoisting is computed from
whatever list arrives, so multi-addon users are served without a Comet-specific path.
