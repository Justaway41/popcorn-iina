# Stream Quality Sorting

## Goal

Make long stream lists easier to scan by sorting them by detected video quality.

## Interaction

Show one compact sort toggle above the stream list. It starts at **Highest First**,
switches to **Lowest First** when clicked, and switches back on the next click.
Sorting updates the existing results immediately without another network request.

## Quality detection and ordering

Detect quality from the addon-provided stream name, title, and description. Rank
recognized resolutions numerically, including `4K` as `2160p`. Preserve addon
order between streams with the same quality. Streams without a recognized
resolution stay at the bottom in both directions.

## Verification

Unit-test resolution detection, stable ascending and descending ordering, and
unknown-quality placement. Verify the toggle uses the sorted results without
refetching.
