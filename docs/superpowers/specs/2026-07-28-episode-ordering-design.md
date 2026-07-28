# Episode Ordering Design

## Goal

Make long episode lists easier to navigate without changing their natural serial sequence or prioritizing watched state.

## Chosen UX

- Seasons remain ordered numerically: Season 0, Season 1, Season 2, and so on.
- Episodes default to **Oldest First**: S01E01, S01E02, S01E03.
- A compact **Newest First** toggle above the season list reverses both season and episode order.
- Changing the order never groups, hides, or promotes watched or unwatched episodes.
- The selected order is remembered locally and reused the next time the episode browser opens.
- Existing folded season sections, release availability, watched indicators, and playback behavior remain unchanged.

## Alternatives Considered

1. Fixed serial order only: simplest, but does not help users reach recent episodes in long-running shows.
2. Oldest/Newest serial toggle: chosen because it improves navigation without inventing a recommendation system.
3. Unwatched-first ordering: rejected because it breaks the expected episode sequence.

## Implementation

Add one defensively parsed episode-order preference using the existing IINA preference/message flow. Keep sorting as a small pure helper so season and episode ordering can be tested without DOM setup. Render two compact order controls in the existing episode view and re-render locally when the selection changes; do not refetch episode data.

## Testing

- Default order is ascending by season and episode.
- Newest First reverses season and episode order.
- Watched state does not influence order.
- Invalid stored values fall back to Oldest First.
- Run the full test suite, typecheck, build, package, and built-version verification.

## Deliberate Omissions

- No unwatched-first mode.
- No episode search or filters.
- No per-show ordering preference.
- No new dependency.
