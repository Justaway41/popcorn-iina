# Popcorn for IINA

Browse Cinemeta movies and TV shows, choose a direct stream from your Stremio addons, and play it in IINA.

## Features

- Trending and search for movies and TV series
- Season and episode browsing
- Local recently watched history and watched indicators
- Multiple enabled Stremio addons with merged, source-labeled results
- Direct HTTP(S) stream selection and playback in IINA
- Next episode stream choices when an episode ends
- Native IINA sidebar, window titles, and display-sleep prevention

Popcorn does not bundle a content provider, torrent client, or debrid service. It ignores torrent-only results such as `infoHash`; addons must return direct HTTP(S) `url` streams. Only access content you have the legal right to view.

## Install from GitHub

1. In IINA, open Settings → Plugins.
2. Select **Install from GitHub**.
3. Enter `Justaway41/popcorn-iina`.
4. Restart IINA if Popcorn does not appear immediately.
5. Add one or more **Stremio addon manifest URLs** under Popcorn for IINA.

Open Popcorn with `Shift+P` or IINA's Plugin menu.

## Install from source

```sh
git clone https://github.com/Justaway41/popcorn-iina.git
cd popcorn-iina
bun install
bun run package
```

In IINA Settings → Plugins, click **Install Package…** and choose `xyz.brbc.popcorn.iinaplugin.iinaplgz`. Restart IINA, then add one or more **Stremio addon manifest URLs** under Popcorn for IINA.

Accepted manifest forms:

- `https://addon.example/manifest.json`
- `http://localhost:7000/manifest.json`
- `stremio://addon.example/manifest.json` (normalized to HTTPS)

Enabled addons are queried together, and each stream is labeled with its source. Manifest URLs may contain private debrid credentials; Popcorn hides their paths and query strings after adding. Do not share them.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

## Data sources and protocol

Discovery metadata comes from [Cinemeta](https://v3-cinemeta.strem.io/). Stream providers use the [Stremio addon protocol](https://stremio.github.io/stremio-addon-guide/).

Inspired by the MIT-licensed [Raycast Popcorn extension](https://www.raycast.com/martipops/popcorn). This project is not affiliated with Raycast, Stremio, Cinemeta, IINA, or any stream provider.

## License

[GPL-3.0](LICENSE), inherited from the IINA plugin shell this project was forked from.
