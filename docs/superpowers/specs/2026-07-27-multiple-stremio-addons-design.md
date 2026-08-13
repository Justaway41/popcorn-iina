# Multiple Stremio Addons Design

## Goal

Let users configure multiple Stremio addons without adding an addon-selection step before playback.

## Preferences UX

Replace the single manifest field with an Addons section:

- A manifest URL field and an **Add Addon** button.
- One compact row per configured addon.
- Each row shows the manifest name, hostname, enabled toggle, and Remove button.
- Credential-bearing paths and query strings are never displayed after adding.
- Editing is intentionally omitted; remove and re-add an incorrect URL.
- Addons keep insertion order. Reordering is intentionally omitted because results are merged.

When adding an addon, normalize the URL, fetch its manifest, require a non-empty manifest name and a stream resource, and reject duplicate normalized URLs. Show validation failures beside the input without discarding the entered value.

## Stored Data and Migration

Store a JSON array in the IINA preference `addons`:

```json
[
  {
    "name": "Example Addon",
    "manifestUrl": "https://addon.example/config/manifest.json",
    "enabled": true
  }
]
```

Parse this value defensively at every trust boundary. Store the canonical manifest URL and derive stream endpoints with a small shared parser compatible with IINA's JavaScriptCore environment, preserving configured paths and query parameters. The complete URL remains local because it may contain addon configuration credentials.

For existing installations, if `addons` is empty and `addonManifestUrl` contains a valid value, expose that URL as one enabled legacy addon with a hostname-derived temporary name. Persist it in the new format after the preferences page successfully reads its manifest. Keep the old preference during this release so rollback does not lose configuration.

## Stream Loading

The sidebar receives all enabled addons in its configuration payload. When opening a movie or episode:

1. Request every enabled addon concurrently.
2. Parse only direct HTTP(S) streams using the existing parser.
3. Attach the manifest name to each result.
4. Merge results in addon insertion order.
5. Remove exact duplicate stream URLs, keeping the first result.

Render one stream list. Each row retains title, quality, language, and size, plus a quiet addon-name badge. There are no addon tabs or manual provider selector.

## Failure Handling

- If one or more addons fail but another returns results, show the results and a compact warning such as `1 addon unavailable`.
- If enabled addons succeed but return no direct streams, keep the current no-stream empty state.
- If every enabled addon fails, show the normal error state with Retry.
- If no addon is enabled, direct the user to IINA’s Popcorn preferences.
- A stale navigation request aborts all in-flight addon fetches through the existing request signal.

## Testing

- Parse valid, malformed, duplicate, disabled, and legacy addon preferences.
- Validate manifest name and stream-resource detection.
- Verify concurrent results merge in addon order and deduplicate exact URLs.
- Verify partial failure returns successful streams and total failure returns an error.
- Typecheck both targets, run all tests, build, package, and verify archive integrity.

## Deliberate Omissions

- No addon tabs or per-play selection.
- No drag-and-drop ordering.
- No automatic ranking across providers.
- No account or cloud synchronization.
- No new dependency.
