# Multiple Stremio Addons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single Stremio manifest setting with a compact multi-addon manager and merge streams from every enabled addon.

**Architecture:** Put addon URL validation, stored-data parsing, manifest validation, and concurrent stream merging in one shared TypeScript module. Build a small preferences-page entry beside the existing sidebar entry. Keep the sidebar flow unchanged except that stream loading fans out concurrently and renders addon source badges plus partial-failure status.

**Tech Stack:** TypeScript, Bun, IINA preferences/webviews, browser DOM APIs, native `Promise.allSettled`.

## Global Constraints

- Preserve the current `addonManifestUrl` preference for rollback and migration.
- Store new addon records in the `addons` preference as JSON.
- Never display credential-bearing URL paths or query strings after an addon is saved.
- Query enabled addons concurrently and preserve configured addon order.
- Deduplicate exact stream URLs, keeping the first configured addon.
- Partial addon failure must not hide successful streams.
- Add no dependency.
- Do not commit without explicit user authorization.

---

### Task 1: Shared addon model

**Files:**
- Create: `src/shared/addons.ts`
- Create: `src/shared/addons.test.ts`
- Modify: `src/shared/stremio.ts`
- Modify: `src/shared/stremio.test.ts`

**Interfaces:**
- Produces: `StremioAddon { name: string; manifestUrl: string; enabled: boolean }`
- Produces: `canonicalizeManifestUrl(value: string): string`
- Produces: `parseAddons(value: unknown, legacyUrl?: unknown): StremioAddon[]`
- Produces: `parseAddonManifest(value: unknown): string`
- Produces: `loadAddonStreams(addons, load): Promise<AddonStreamLoadResult>`
- Changes: `buildStremioStreamUrl(manifestUrl, type, videoId)` to derive a stream endpoint from a canonical manifest URL while preserving query parameters.

- [ ] **Step 1: Write failing URL, parsing, and manifest tests**

```ts
test("canonicalizes manifest URLs and preserves configuration queries", () => {
    expect(canonicalizeManifestUrl("stremio://addon.example/config?token=x")).toBe(
        "https://addon.example/config/manifest.json?token=x"
    );
    expect(buildStremioStreamUrl(
        "https://addon.example/config/manifest.json?token=x",
        "series",
        "tt1:1:2"
    )).toBe("https://addon.example/config/stream/series/tt1%3A1%3A2.json?token=x");
});

test("parses, deduplicates, and migrates addon preferences", () => {
    const stored = JSON.stringify([
        { name: "One", manifestUrl: "https://one.example/manifest.json", enabled: true },
        { name: "Duplicate", manifestUrl: "https://one.example/manifest.json", enabled: false },
        { name: "", manifestUrl: "bad", enabled: true }
    ]);
    expect(parseAddons(stored)).toEqual([
        { name: "One", manifestUrl: "https://one.example/manifest.json", enabled: true }
    ]);
    expect(parseAddons("[]", "https://legacy.example/manifest.json")).toEqual([
        { name: "legacy.example", manifestUrl: "https://legacy.example/manifest.json", enabled: true }
    ]);
});

test("requires a named stream addon manifest", () => {
    expect(parseAddonManifest({ name: "Debrid", resources: ["stream"] })).toBe("Debrid");
    expect(() => parseAddonManifest({ name: "Catalog", resources: ["catalog"] })).toThrow(
        "Manifest does not provide streams."
    );
});

test("merges successful addons in order and reports failures", async () => {
    const addons = [
        { name: "One", manifestUrl: "https://one.example/manifest.json", enabled: true },
        { name: "Broken", manifestUrl: "https://broken.example/manifest.json", enabled: true },
        { name: "Two", manifestUrl: "https://two.example/manifest.json", enabled: true }
    ];
    const result = await loadAddonStreams(addons, async (addon) => {
        if (addon.name === "Broken") throw new Error("offline");
        return [{
            title: addon.name,
            url: addon.name === "Two" ? "https://same.example/video" : "https://one.example/video",
            quality: "",
            size: "",
            language: ""
        }, {
            title: "Duplicate",
            url: "https://same.example/video",
            quality: "",
            size: "",
            language: ""
        }];
    });

    expect(result.streams.map((stream) => [stream.title, stream.addonName])).toEqual([
        ["One", "One"],
        ["Duplicate", "One"]
    ]);
    expect(result).toMatchObject({ failedAddons: 1, successfulAddons: 2 });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test src/shared/addons.test.ts src/shared/stremio.test.ts`

Expected: failure because the addon module and canonical manifest behavior do not exist.

- [ ] **Step 3: Implement the minimum shared model**

Use a small string parser compatible with IINA's JavaScriptCore environment. Convert `stremio://` to `https://`, accept only HTTP(S), remove fragments, ensure the pathname ends in `/manifest.json`, and preserve the query. Parse stored arrays defensively, discard malformed records, and deduplicate by canonical manifest URL.

Implement concurrent loading with:

```ts
export async function loadAddonStreams(
    addons: StremioAddon[],
    load: (addon: StremioAddon) => Promise<PlayableStream[]>
): Promise<AddonStreamLoadResult> {
    const results = await Promise.allSettled(addons.map(load));
    const seen = new Set<string>();
    const streams: AddonStream[] = [];
    let failedAddons = 0;
    let successfulAddons = 0;

    results.forEach((result, index) => {
        if (result.status === "rejected") {
            failedAddons += 1;
            return;
        }
        successfulAddons += 1;
        result.value.forEach((stream) => {
            if (seen.has(stream.url)) return;
            seen.add(stream.url);
            streams.push({ ...stream, addonName: addons[index].name });
        });
    });

    return { streams, failedAddons, successfulAddons };
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test src/shared/addons.test.ts src/shared/stremio.test.ts`

Expected: all addon and Stremio tests pass.

---

### Task 2: Addon preferences manager

**Files:**
- Create: `src/ui/preferences.ts`
- Modify: `src/ui/iina-webview.d.ts`
- Modify: `xyz.brbc.popcorn.iinaplugin/ui/preferences.html`
- Modify: `xyz.brbc.popcorn.iinaplugin/Info.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `canonicalizeManifestUrl`, `parseAddonManifest`, `parseAddons`, and `StremioAddon`.
- Stores: `preferences.set("addons", JSON.stringify(addons))`.
- Builds: `src/ui/preferences.ts` to `xyz.brbc.popcorn.iinaplugin/ui/dist/preferences.js`.

- [ ] **Step 1: Add the preferences webview API type**

Extend `Window.iina` with:

```ts
preferences: {
    get(key: string, callback: (value: unknown) => void): void;
    set(key: string, value: unknown): void;
    sync?(): void;
};
```

- [ ] **Step 2: Replace the single field with the compact manager markup**

Use one form containing `#addon-url`, `#add-addon`, and `#addon-error`, followed by `#addon-list`. Add a `<template id="addon-row-template">` with an enabled checkbox, name, hostname, and Remove button. Load `dist/preferences.js`.

Keep styling in the page using a short `<style>` block so no extra stylesheet or build step is introduced.

- [ ] **Step 3: Implement add, toggle, remove, and migration behavior**

On page load, read both `addons` and `addonManifestUrl`, then call `parseAddons`. Render only the addon name and `getAddonHostname(addon.manifestUrl)`.

On Add:

```ts
const manifestUrl = canonicalizeManifestUrl(input.value);
if (addons.some((addon) => addon.manifestUrl === manifestUrl)) {
    throw new Error("This addon is already added.");
}
const manifest = await fetch(manifestUrl, { headers: { Accept: "application/json" } });
if (!manifest.ok) throw new Error(`Manifest request failed with HTTP ${manifest.status}.`);
const name = parseAddonManifest(await manifest.json());
addons.push({ name, manifestUrl, enabled: true });
saveAndRender();
```

Disable the Add button while validating. Preserve input text on failure, clear it on success, and call `preferences.sync?.()` after add, toggle, or remove.

If a legacy entry has only a hostname-derived name, validate its manifest when preferences load; replace the temporary name and persist the new array only after validation succeeds.

- [ ] **Step 4: Add the new preference default and build entry**

Add `"addons": "[]"` beside the existing `addonManifestUrl`. Change `build:ui` to:

```json
"build:ui": "bun build src/ui/sidebar.ts src/ui/preferences.ts --outdir xyz.brbc.popcorn.iinaplugin/ui/dist --target=browser --format=iife"
```

- [ ] **Step 5: Verify preferences compilation**

Run: `bun run typecheck && bun run build:ui`

Expected: both TypeScript targets pass and both `sidebar.js` and `preferences.js` are emitted.

---

### Task 3: Multi-addon stream loading

**Files:**
- Modify: `src/shared/messages.ts`
- Modify: `src/plugin/main.ts`
- Modify: `src/ui/app.ts`
- Modify: `xyz.brbc.popcorn.iinaplugin/ui/sidebar.css`

**Interfaces:**
- Changes: `ConfigurationPayload.addons: StremioAddon[]` replaces sidebar use of `addonManifestUrl`.
- Consumes: `loadAddonStreams`.
- Renders: addon source badge and partial-failure warning.

- [ ] **Step 1: Send parsed addon configuration**

In the main plugin configuration handler, read:

```ts
addons: parseAddons(
    preferences.get("addons"),
    preferences.get("addonManifestUrl")
)
```

Keep `addonManifestUrl` stored but remove it from `ConfigurationPayload`.

- [ ] **Step 2: Replace the single stream request**

In `loadStreams`, filter enabled addons. If none remain, show:

```text
Enable a Stremio addon in IINA Settings → Plugins → Popcorn for IINA.
```

Call `loadAddonStreams(enabledAddons, async (addon) => parsePlayableStreams(await fetchJson(
    buildStremioStreamUrl(addon.manifestUrl, media.type, videoId),
    request.signal
)))`.

If `successfulAddons === 0`, throw `new Error("Could not load streams from any enabled addon.")`. Pass `streams` and `failedAddons` to `renderStreams`.

- [ ] **Step 3: Render source and partial failures**

Add `addonName` to the stream detail fragment using `.stream-addon`. If `failedAddons > 0`, prepend:

```html
<div class="addon-warning">1 addon unavailable</div>
```

Use plural `addons` when needed. Keep the existing empty state when successful addons return no direct streams.

- [ ] **Step 4: Add minimal styles**

Style `.stream-addon` like the existing neutral metadata labels. Style `.addon-warning` as compact muted text with no modal, icon dependency, or separate error screen.

- [ ] **Step 5: Run focused verification**

Run: `bun test src/shared/addons.test.ts src/shared/stremio.test.ts && bun run typecheck && bun run build`

Expected: focused tests, both TypeScript targets, and all bundles pass.

---

### Task 4: Documentation and complete verification

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Update user-facing documentation**

Change single-addon wording to multiple enabled addons, explain that streams are merged and labeled by source, and retain the warning that configured manifest URLs may contain private credentials.

- [ ] **Step 2: Run all checks**

Run separately:

```sh
bun test
bun run typecheck
bun run verify:root-info
bun run build
bun run verify:built-client-version
git diff --check
```

Expected: zero test failures, successful compilation/build, synchronized manifests, correct bundled version, and no whitespace errors.

- [ ] **Step 3: Build and verify the local package**

Run separately:

```sh
bun run package
zip -T xyz.brbc.popcorn.iinaplugin.iinaplgz
```

Expected: a fresh package is created and archive integrity reports `OK`.
