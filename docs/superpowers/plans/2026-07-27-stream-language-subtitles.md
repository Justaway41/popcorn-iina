# Stream Language and Subtitle Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show declared audio languages and English subtitle availability on every stream row.

**Architecture:** Extend the existing defensive Stremio response parser with normalized audio and subtitle language metadata. Fetch OpenSubtitles v3 once per selected video, combine that result with each stream's embedded subtitle metadata, and render compact native-tooltip badges.

**Tech Stack:** TypeScript, Bun tests, DOM APIs, existing CSS.

## Global Constraints

- Do not add dependencies or a custom tooltip component.
- Subtitle lookup failure must not prevent streams from rendering.
- Unknown metadata must remain unknown rather than being reported as absent.

---

### Task 1: Parse stream language and subtitle metadata

**Files:**
- Modify: `src/shared/stremio.ts`
- Test: `src/shared/stremio.test.ts`
- Modify: `src/shared/addons.test.ts`

**Interfaces:**
- Produces: `PlayableStream.audioLanguages: string[]`
- Produces: `PlayableStream.subtitleLanguages: string[] | null`
- Produces: `buildOpenSubtitlesUrl(type: MediaType, videoId: string): string`
- Produces: `parseEnglishSubtitleAvailability(value: unknown): boolean`

- [ ] **Step 1: Write failing parser tests**

Add cases proving that `English Hindi Dual Audio` returns both named audio
languages, `ENG Subs Japanese Audio` does not misclassify English as audio,
stream subtitle objects normalize `eng` to `English`, and an OpenSubtitles
response reports whether any entry has `en`, `eng`, or `English`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `bun test src/shared/stremio.test.ts src/shared/addons.test.ts`

Expected: FAIL because the new fields and exports do not exist.

- [ ] **Step 3: Implement the minimal parser changes**

Replace the single `language` field with:

```ts
audioLanguages: string[];
subtitleLanguages: string[] | null;
```

Collect and deduplicate recognized audio languages after masking subtitle
phrases. Normalize subtitle `lang` values defensively. Add the fixed official
OpenSubtitles v3 URL builder and English availability parser.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test src/shared/stremio.test.ts src/shared/addons.test.ts`

Expected: all focused tests pass.

### Task 2: Fetch availability and render badges

**Files:**
- Modify: `src/ui/app.ts`
- Modify: `xyz.brbc.popcorn.iinaplugin/ui/sidebar.css`

**Interfaces:**
- Consumes: `buildOpenSubtitlesUrl`
- Consumes: `parseEnglishSubtitleAvailability`
- Consumes: `PlayableStream.audioLanguages`
- Consumes: `PlayableStream.subtitleLanguages`

- [ ] **Step 1: Add a non-blocking subtitle lookup**

Start the OpenSubtitles request beside stream loading. Convert successful
responses to `boolean`; convert non-abort failures to `null`. Pass
`boolean | null` into `renderStreams`.

- [ ] **Step 2: Render compact badges**

Render:

```text
English                 # one declared audio language
Multi (2)               # multiple; title="Audio: English, Hindi"
Audio ?                 # no declared audio metadata
EN Subs / No EN Subs / Subs ?
```

Embedded English subtitles override a negative external lookup. Use native
`title` attributes for full language details.

- [ ] **Step 3: Add minimal badge styles**

Reuse the existing pill dimensions. Add muted audio/unknown states and green
English-subtitle styling without changing row layout.

- [ ] **Step 4: Verify the complete build**

Run:

```bash
bun test
bun run typecheck
bun run build
```

Expected: all tests pass, both TypeScript projects typecheck, and the local
development bundle rebuilds successfully.

