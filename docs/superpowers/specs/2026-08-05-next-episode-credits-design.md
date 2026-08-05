# Next Episode During Credits Design

**Date:** 2026-08-05

## Goal

Make Popcorn's next-episode control behave like the existing Jellyfin IINA plugin during end credits while preserving Popcorn's explicit no-autoplay requirement.

## Behavior

When an episode starts, Popcorn resolves the next released episode using the existing serial episode order. It fetches playable streams in the background and selects the stream whose numeric resolution is closest to the current stream, using the existing exact-match, smallest-difference, higher-on-tie rule.

During a verified end-credits interval, Popcorn shows a floating pill button in the same bottom-right style as Jellyfin's segment control. Its label is `Next Episode`. Clicking it immediately replaces the current file with the prefetched next episode. Ignoring it never advances playback.

Natural end of file remains a fallback: when credits cannot be detected, or no recommended stream was ready during credits, Popcorn opens the existing sidebar next-episode view after EOF. It never autoplays.

## Credits Detection

Credits timing is accepted only from verified metadata:

1. IINA chapters named exactly `ending`, `credits`, `outro`, or `ed`, case-insensitively. The interval starts at that chapter and ends at the next chapter or media duration.
2. AniSkip opening and ending results for Kitsu-backed anime. AniSkip v2 receives IINA's current `episodeLength`; an `ed` interval becomes the credits interval.

Missing, malformed, stale, or out-of-range timing is ignored. Popcorn does not guess based on remaining runtime.

## Playback and State

Next-episode prefetch uses enabled addons that currently declare the `stream` resource. Addon manifests and responses must pass the same validation used by the sidebar. Partial addon failure is silent because the current episode is already playing; any successful direct HTTP stream may be recommended.

The floating button appears only when all of these are true:

- playback is inside a verified credits interval;
- a released next episode exists;
- a playable recommended stream has been resolved;
- the current playback context still matches the prefetch request.

Clicking the button reuses the existing `playItem` path so history, Trakt, title, resume state, intro state, and next prefetch are reset consistently. A request revision prevents a result from a previous file from becoming active after replacement. State is cleared on file replacement, end-file, splash load, and window close.

## Overlay

The existing Popcorn overlay supports two mutually exclusive actions: `Skip Intro` and `Next Episode`. Intro takes priority if intervals overlap. The next-episode pill follows Jellyfin's white rounded styling, placement, and click feedback. Hiding the overlay disables click handling.

## Testing

Focused tests cover:

- exact credits chapter matching and duration fallback;
- AniSkip `ed` interval parsing alongside `op`;
- overlay action priority and visibility;
- closest-quality prefetch selection;
- stale prefetch rejection;
- click-to-play with no autoplay;
- natural-EOF sidebar fallback when the credits action was unavailable.

Before local handoff, run the complete test suite, both TypeScript typechecks, the production build, and refresh the existing `xyz.brbc.popcorn.iinaplugin-dev` bundle without installing a duplicate identifier.
