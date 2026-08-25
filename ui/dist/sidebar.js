(() => {
  // src/shared/addons.ts
  function canonicalizeManifestUrl(value) {
    const trimmed = value.trim();
    const normalized = trimmed.replace(/^stremio:\/\//i, "https://");
    const parts = parseUrl(normalized);
    const basePath = parts.path.replace(/\/manifest\.json\/?$/i, "").replace(/\/+$/, "");
    return `${parts.scheme}://${parts.authority}${basePath}/manifest.json${parts.query}`;
  }
  function getAddonHostname(manifestUrl) {
    const authority = parseUrl(canonicalizeManifestUrl(manifestUrl)).authority.split("@").pop() || "";
    if (authority.startsWith("["))
      return authority.slice(0, authority.indexOf("]") + 1);
    return authority.replace(/:\d+$/, "");
  }
  function parseAddons(value, legacyUrl) {
    let stored = value;
    try {
      if (typeof stored === "string")
        stored = JSON.parse(stored);
    } catch {
      stored = [];
    }
    const seen = new Set;
    const addons = Array.isArray(stored) ? stored.flatMap((entry) => {
      const item = getRecord(entry);
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      if (!name || typeof item?.manifestUrl !== "string" || typeof item.enabled !== "boolean")
        return [];
      try {
        const manifestUrl = canonicalizeManifestUrl(item.manifestUrl);
        if (seen.has(manifestUrl))
          return [];
        seen.add(manifestUrl);
        return [{ name, manifestUrl, enabled: item.enabled }];
      } catch {
        return [];
      }
    }) : [];
    if (addons.length > 0 || typeof legacyUrl !== "string" || !legacyUrl.trim())
      return addons;
    try {
      const manifestUrl = canonicalizeManifestUrl(legacyUrl);
      return [{ name: getAddonHostname(manifestUrl), manifestUrl, enabled: true }];
    } catch {
      return [];
    }
  }
  function parseAddonManifest(value) {
    const manifest = getRecord(value);
    const name = typeof manifest?.name === "string" ? manifest.name.trim() : "";
    if (!name)
      throw new Error("Manifest is missing a name.");
    const supported = new Set(["catalog", "meta", "stream", "subtitles"]);
    const resources = [...new Set((Array.isArray(manifest?.resources) ? manifest.resources : []).map((resource) => typeof resource === "string" ? resource : getString(getRecord(resource)?.name)).filter((resource) => supported.has(resource)))];
    if (resources.length === 0)
      throw new Error("Manifest does not provide a supported resource.");
    return {
      name,
      resources,
      types: Array.isArray(manifest?.types) ? manifest.types.filter((type) => typeof type === "string" && Boolean(type)) : [],
      catalogs: Array.isArray(manifest?.catalogs) ? manifest.catalogs.flatMap(parseCatalog) : []
    };
  }
  async function loadAddonStreams(addons, load) {
    const results = await Promise.allSettled(addons.map(load));
    const seen = new Set;
    const streams = [];
    let failedAddons = 0;
    let successfulAddons = 0;
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        failedAddons += 1;
        return;
      }
      successfulAddons += 1;
      result.value.forEach((stream) => {
        if (seen.has(stream.url))
          return;
        seen.add(stream.url);
        streams.push({ ...stream, addonName: addons[index].name });
      });
    });
    return { streams, failedAddons, successfulAddons };
  }
  async function loadEnabledAddonStreams(addons, loadManifest, loadStreams) {
    const enabled = addons.filter((addon) => addon.enabled);
    const manifests = await Promise.allSettled(enabled.map(async (addon) => ({
      addon,
      manifest: await loadManifest(addon)
    })));
    const streamAddons = manifests.flatMap((result2) => result2.status === "fulfilled" && result2.value.manifest.resources.includes("stream") ? [result2.value.addon] : []);
    const result = await loadAddonStreams(streamAddons, loadStreams);
    return {
      ...result,
      failedAddons: result.failedAddons + manifests.filter((item) => item.status === "rejected").length
    };
  }
  function getRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  }
  function getString(value) {
    return typeof value === "string" ? value.trim() : "";
  }
  function parseCatalog(value) {
    const item = getRecord(value);
    const id = getString(item?.id);
    const type = getString(item?.type);
    if (!id || !type)
      return [];
    return [{
      id,
      type,
      ...getString(item?.name) ? { name: getString(item?.name) } : {},
      extra: Array.isArray(item?.extra) ? item.extra.flatMap((value2) => {
        const extra = getRecord(value2);
        const name = getString(extra?.name);
        return name ? [{ name, ...extra?.isRequired === true ? { isRequired: true } : {} }] : [];
      }) : []
    }];
  }
  function parseUrl(value) {
    const match = value.match(/^(https?):\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(?:#.*)?$/i);
    if (!match || /\s/.test(match[2])) {
      throw new Error("Addon URL must start with http://, https://, or stremio://");
    }
    return {
      scheme: match[1].toLowerCase(),
      authority: match[2],
      path: match[3] || "",
      query: match[4] || ""
    };
  }

  // src/shared/history.ts
  var MAX_HISTORY_ITEMS = 100;
  function parseWatchHistory(value) {
    try {
      const items = typeof value === "string" ? JSON.parse(value) : value;
      if (!Array.isArray(items))
        return [];
      return items.flatMap(parseEntry).slice(0, MAX_HISTORY_ITEMS);
    } catch {
      return [];
    }
  }
  function latestPerTitle(entries) {
    const seen = new Set;
    return entries.filter((entry) => {
      const id = historyTitleId(entry);
      if (seen.has(id))
        return false;
      seen.add(id);
      return true;
    });
  }
  function historyTitleId(entry) {
    return entry.media.imdbId || entry.media.providerId || entry.media.id;
  }
  function getResumePercent(progress, watched) {
    return !watched && progress !== null && progress >= 5 && progress < 90 ? progress : null;
  }
  function parseEntry(value) {
    const item = getRecord2(value);
    const media = parseMedia(item?.media);
    const episode = item?.episode == null ? null : parseEpisode(item.episode);
    const id = getString2(item?.id);
    const lastPlayedAt = getString2(item?.lastPlayedAt);
    const watched = item?.watched;
    if (!item || !media || item.episode != null && !episode || !id || !lastPlayedAt || typeof watched !== "boolean") {
      return [];
    }
    if (id !== (episode?.id || media.imdbId || media.providerId || media.id))
      return [];
    return [{
      id,
      media,
      ...episode ? { episode } : {},
      lastPlayedAt,
      watched,
      progress: normalizeProgress(item.progress, watched)
    }];
  }
  function normalizeProgress(value, watched) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return watched ? 100 : null;
    }
    return Math.max(0, Math.min(100, value));
  }
  function parseMedia(value) {
    const item = getRecord2(value);
    const type = item?.type === "movie" || item?.type === "series" ? item.type : null;
    const id = getString2(item?.id);
    const imdbId = getString2(item?.imdbId);
    const name = getString2(item?.name);
    if (!item || !type || !id || !(imdbId || getString2(item.providerId)) || !name)
      return null;
    return {
      id,
      imdbId,
      type,
      name,
      releaseInfo: getString2(item.releaseInfo),
      poster: getString2(item.poster),
      ...getString2(item.sourceManifestUrl) ? { sourceManifestUrl: getString2(item.sourceManifestUrl) } : {},
      ...getString2(item.providerId) ? { providerId: getString2(item.providerId) } : {},
      ...getString2(item.providerType) ? { providerType: getString2(item.providerType) } : {},
      ...getString2(item.malId) ? { malId: getString2(item.malId) } : {}
    };
  }
  function parseEpisode(value) {
    const item = getRecord2(value);
    const id = getString2(item?.id);
    const name = getString2(item?.name);
    const season = getNumber(item?.season);
    const episode = getNumber(item?.episode);
    if (!item || !id || !name || season === null || episode === null)
      return null;
    return {
      id,
      name,
      season,
      episode,
      aired: getString2(item.aired),
      description: getString2(item.description),
      thumbnail: getString2(item.thumbnail)
    };
  }
  function getRecord2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  }
  function getString2(value) {
    return typeof value === "string" ? value : "";
  }
  function getNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  // src/shared/messages.ts
  var MESSAGE_NAMES = {
    PlayItem: "playItem",
    RequestConfiguration: "requestConfiguration",
    Configuration: "configuration",
    SetMediaType: "setMediaType",
    SetEpisodeOrder: "setEpisodeOrder",
    HistoryUpdated: "historyUpdated",
    RemoveHistoryEntry: "removeHistoryEntry",
    ShowNextEpisode: "showNextEpisode"
  };
  // Info.json
  var Info_default = {
    name: "Popcorn for IINA",
    identifier: "xyz.brbc.popcorn",
    version: "2.3.1",
    ghRepo: "Justaway41/popcorn-iina",
    ghVersion: 12,
    description: "Discover media and play direct Stremio addon streams in IINA",
    author: {
      name: "Justaway41"
    },
    entry: "dist/main.js",
    globalEntry: "dist/global.js",
    sidebarTab: {
      name: "Popcorn"
    },
    preferencesPage: "ui/preferences.html",
    preferenceDefaults: {
      addonManifestUrl: "",
      addons: [],
      mediaType: "movie",
      episodeOrder: "oldest",
      watchHistory: [],
      trakt: {},
      skipSegments: true,
      simkl: {}
    },
    permissions: [
      "network-request",
      "show-osd",
      "show-alert",
      "video-overlay",
      "sidebar",
      "file-system"
    ],
    allowedDomains: [
      "*"
    ]
  };

  // src/shared/version.ts
  var CLIENT_VERSION = Info_default.version;

  // src/shared/stremio.ts
  var CINEMETA_BASE_URL = "https://v3-cinemeta.strem.io";
  var CINEMETA_MANIFEST_URL = `${CINEMETA_BASE_URL}/manifest.json`;
  var OPEN_SUBTITLES_BASE_URL = "https://opensubtitles-v3.strem.io";
  var LANGUAGE_ALIASES = [
    ["English", ["english", "eng"]],
    ["Japanese", ["japanese", "jpn"]],
    ["Hindi", ["hindi", "hin"]],
    ["Korean", ["korean", "kor"]],
    ["Chinese", ["chinese", "chi", "zho"]],
    ["Spanish", ["spanish", "spa"]],
    ["French", ["french", "fre", "fra"]],
    ["German", ["german", "ger", "deu"]],
    ["Italian", ["italian", "ita"]],
    ["Portuguese", ["portuguese", "por", "pob"]],
    ["Russian", ["russian", "rus"]],
    ["Arabic", ["arabic", "ara"]],
    ["Tamil", ["tamil", "tam"]],
    ["Telugu", ["telugu", "tel"]]
  ];
  function buildCinemetaSearchUrl(type, query) {
    return `${CINEMETA_BASE_URL}/catalog/${type}/all/search=${encodeURIComponent(query.trim())}.json`;
  }
  function buildCinemetaTrendingUrl(type) {
    return `${CINEMETA_BASE_URL}/catalog/${type}/top.json`;
  }
  function buildCinemetaSeriesUrl(imdbId) {
    return `${CINEMETA_BASE_URL}/meta/series/${encodeURIComponent(imdbId)}.json`;
  }
  function buildCinemetaPosterUrl(imdbId) {
    return `https://images.metahub.space/poster/medium/${encodeURIComponent(imdbId)}/img`;
  }
  function buildOpenSubtitlesUrl(type, videoId) {
    return `${OPEN_SUBTITLES_BASE_URL}/subtitles/${type}/${encodeURIComponent(videoId)}.json`;
  }
  function buildStremioStreamUrl(manifestUrl, type, videoId) {
    return buildStremioResourceUrl(manifestUrl, "stream", type, videoId);
  }
  function buildStremioResourceUrl(manifestUrl, resource, type, id, extra = {}) {
    const canonical = canonicalizeManifestUrl(manifestUrl);
    const queryIndex = canonical.indexOf("?");
    const path = queryIndex === -1 ? canonical : canonical.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : canonical.slice(queryIndex);
    const extraPath = Object.entries(extra).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    return path.replace(/\/manifest\.json$/i, `/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extraPath.length ? `/${extraPath.join("/")}` : ""}.json`) + query;
  }
  function getSearchableCatalogs(manifest, mediaType) {
    const types = mediaType === "movie" ? new Set(["movie"]) : new Set(["series", "anime"]);
    return manifest.catalogs.filter((catalog) => types.has(catalog.type) && catalog.extra.some((extra) => extra.name === "search"));
  }
  function parseMediaTypePreference(value) {
    return value === "series" ? "series" : "movie";
  }
  function parseEpisodeOrder(value) {
    return value === "newest" ? "newest" : "oldest";
  }
  function parseSkipSegments(value) {
    return value !== false;
  }
  function sortEpisodes(episodes, order) {
    const direction = order === "newest" ? -1 : 1;
    return [...episodes].sort((a, b) => direction * (a.season - b.season || a.episode - b.episode));
  }
  function sortStreamsBySize(streams, order) {
    return streams.map((stream, index) => ({ stream, index, bytes: parseByteSize(stream.size) })).sort((a, b) => {
      if (a.bytes === null)
        return b.bytes === null ? a.index - b.index : 1;
      if (b.bytes === null)
        return -1;
      const difference = order === "largest" ? b.bytes - a.bytes : a.bytes - b.bytes;
      return difference || a.index - b.index;
    }).map(({ stream }) => stream);
  }
  function cacheRank(cached) {
    return cached === true ? 0 : cached === null ? 1 : 2;
  }
  function sortStreamsForPlayback(streams, order) {
    return sortStreamsBySize(streams, order).sort((a, b) => cacheRank(a.cached) - cacheRank(b.cached));
  }
  function groupStreamsByResolution(streams) {
    const groups = new Map;
    streams.forEach((stream) => {
      const key = RESOLUTION_ORDER.includes(stream.resolution) ? stream.resolution : "other";
      groups.set(key, [...groups.get(key) || [], stream]);
    });
    const rank = (value) => {
      const index = RESOLUTION_ORDER.indexOf(value);
      return index < 0 ? RESOLUTION_ORDER.length : index;
    };
    return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([resolution, items]) => ({ resolution, streams: items }));
  }
  function parseByteSize(value) {
    const match = value.trim().match(/^([\d.]+)\s*([KMGT])B$/i);
    if (!match)
      return null;
    const amount = Number(match[1]);
    const power = ["K", "M", "G", "T"].indexOf(match[2].toUpperCase()) + 1;
    return Number.isFinite(amount) && amount >= 0 ? amount * 1024 ** power : null;
  }
  function findClosestQualityStream(streams, previousQuality) {
    const known = streams.flatMap((stream, index) => {
      const height = qualityHeight(stream.resolution);
      return height === null ? [] : [{ stream, index, height }];
    });
    if (known.length === 0)
      return null;
    const target = qualityHeight(previousQuality);
    known.sort((a, b) => {
      if (target === null)
        return b.height - a.height || a.index - b.index;
      return Math.abs(a.height - target) - Math.abs(b.height - target) || b.height - a.height || a.index - b.index;
    });
    return known[0].stream;
  }
  function parseMediaResponse(value, source = { manifestUrl: CINEMETA_MANIFEST_URL }) {
    const metas = getRecord3(value)?.metas;
    if (!Array.isArray(metas)) {
      return [];
    }
    return metas.flatMap((entry) => {
      const item = getRecord3(entry);
      const id = getString3(item?.id);
      const providerType = getString3(item?.type);
      const type = providerType === "movie" ? "movie" : providerType === "series" || providerType === "anime" ? "series" : null;
      const name = getString3(item?.name);
      if (!id || !type || !name) {
        return [];
      }
      const imdbId = firstImdbId(item?.imdb_id, id, getRecord3(item?.behaviorHints)?.defaultVideoId);
      return [{
        id,
        imdbId,
        type,
        name,
        releaseInfo: getString3(item?.releaseInfo) || getStringOrNumber(item?.year),
        poster: getString3(item?.poster),
        sourceManifestUrl: source.manifestUrl,
        providerId: id,
        providerType,
        malId: getStringOrNumber(item?.mal_id)
      }];
    });
  }
  function parseMediaMetadata(value, source, preview) {
    const meta = getRecord3(getRecord3(value)?.meta);
    if (!meta)
      return { media: preview, episodes: [] };
    const parsed = parseMediaResponse({ metas: [meta] }, source)[0];
    const media = parsed ? {
      ...preview,
      ...parsed,
      name: parsed.name || preview.name,
      releaseInfo: parsed.releaseInfo || preview.releaseInfo,
      poster: parsed.poster || preview.poster,
      imdbId: parsed.imdbId || preview.imdbId,
      malId: parsed.malId || preview.malId || ""
    } : preview;
    return { media, episodes: parseSeriesEpisodes(value) };
  }
  function mergeMediaResults(groups) {
    const seen = new Set;
    return groups.flatMap((group) => group.flatMap((media) => {
      const key = isImdbId(media.imdbId) ? `imdb:${media.imdbId.toLowerCase()}` : `title:${media.type}:${normalizeTitle(media.name)}:${releaseYear(media.releaseInfo)}`;
      if (seen.has(key))
        return [];
      seen.add(key);
      return [media];
    }));
  }
  function isImdbId(value) {
    return /^tt\d+$/i.test(value.trim());
  }
  function isCompatibleSubtitleId(value) {
    return /^tt\d+(?::\d+:\d+)?$/i.test(value.trim());
  }
  function parseSeriesEpisodes(value) {
    const videos = getRecord3(getRecord3(value)?.meta)?.videos;
    if (!Array.isArray(videos)) {
      return [];
    }
    return videos.flatMap((entry) => {
      const item = getRecord3(entry);
      const providerId = getString3(item?.id);
      const name = getString3(item?.name) || getString3(item?.title);
      const season = getNumber2(item?.season);
      const episode = getNumber2(item?.number);
      if (!providerId || !name || season === null || episode === null) {
        return [];
      }
      const imdbId = firstImdbId(item?.imdb_id);
      const imdbSeason = getNumber2(item?.imdbSeason);
      const imdbEpisode = getNumber2(item?.imdbEpisode);
      const id = imdbId && imdbSeason !== null && imdbEpisode !== null ? `${imdbId}:${imdbSeason}:${imdbEpisode}` : providerId;
      return [{
        id,
        name,
        season,
        episode,
        aired: getString3(item?.firstAired) || getString3(item?.released),
        description: getString3(item?.description) || getString3(item?.overview),
        thumbnail: getString3(item?.thumbnail)
      }];
    });
  }
  function parsePlayableStreams(value) {
    const streams = getRecord3(value)?.streams;
    if (!Array.isArray(streams)) {
      return [];
    }
    return streams.flatMap((entry) => {
      const stream = getRecord3(entry);
      const url = getString3(stream?.url);
      if (!isHttpUrl(url)) {
        return [];
      }
      const name = getString3(stream?.name);
      const description = getString3(stream?.description);
      const providerTitle = getString3(stream?.title) || description || name || "Stream";
      const behaviorHints = getRecord3(stream?.behaviorHints);
      const streamData = getRecord3(stream?.streamData);
      const service = getRecord3(streamData?.service);
      const torrent = getRecord3(streamData?.torrent);
      const filename = getString3(behaviorHints?.filename) || getString3(streamData?.filename);
      const rawTitle = filename || providerTitle;
      const metadata = [name, providerTitle, description, filename].join(" ");
      const structuredCached = getBoolean(service?.cached) ?? getBoolean(streamData?.cached);
      const structuredSeeders = getNonNegativeInteger(torrent?.seeders) ?? getNonNegativeInteger(streamData?.seeders);
      const structuredSize = formatByteSize(getPositiveNumber(behaviorHints?.videoSize) ?? getPositiveNumber(streamData?.size));
      return [{
        title: cleanStreamTitle(rawTitle),
        rawTitle,
        url,
        resolution: parseResolution(filename || metadata, metadata),
        source: (filename.match(SOURCE_PATTERN) || metadata.match(SOURCE_PATTERN))?.[0] || "",
        size: structuredSize || metadata.match(/(?:💾\s*)?([\d.]+\s*[KMGT]B)\b/i)?.[1] || "",
        audioLanguages: parseAudioLanguages(metadata),
        subtitleLanguages: parseSubtitleLanguages(stream?.subtitles),
        cached: structuredCached ?? parseCacheStatus(metadata),
        seeders: structuredSeeders ?? parseSeeders(metadata)
      }];
    });
  }
  function parseEnglishSubtitleAvailability(value) {
    return parseSubtitleLanguages(getRecord3(value)?.subtitles)?.includes("English") || false;
  }
  function isEpisodeAvailable(episode, now = new Date) {
    const aired = Date.parse(episode.aired);
    return !Number.isFinite(aired) || aired <= now.getTime();
  }
  function findNextEpisode(episodes, current, now = new Date) {
    const sorted = episodes.filter((episode) => isEpisodeAvailable(episode, now)).sort((a, b) => {
      if (a.season !== b.season)
        return a.season - b.season;
      if (a.episode !== b.episode)
        return a.episode - b.episode;
      return a.id.localeCompare(b.id);
    });
    const index = sorted.findIndex((episode) => episode.id === current.id);
    if (index !== -1) {
      return sorted[index + 1] || null;
    }
    return sorted.find((episode) => episode.season > current.season || episode.season === current.season && episode.episode > current.episode) || null;
  }
  function isHttpUrl(value) {
    return /^https?:\/\/[^/]+/i.test(value.trim());
  }
  function cleanStreamTitle(value) {
    const firstLine = value.split(/\r?\n/).find((line) => line.trim())?.trim() || value.trim();
    const cleaned = firstLine.replace(/\.(?:mkv|mp4|avi|mov|m4v|ts|m2ts|webm|iso)$/i, "").replace(/【[^】]*】/g, " ").replace(/\[[^\]]*(?:www\s*\.|\.com|\.net|\.org|\.tv|[一-鿿])[^\]]*\]/gi, " ").replace(/\b(?:www\s*\.\s*)?[a-z0-9-]+\s*\.\s*(?:com|net|org|tv|me)\b/gi, " ").replace(/\p{Extended_Pictographic}|[\uFE0F\u200D]/gu, " ").replace(/[._]+/g, " ").replace(/\bH\s*26([45])\b/gi, "H.26$1").replace(/\bS(\d{1,2})\s+E(\d{1,3})\b/gi, "S$1E$2").replace(/\bWEB\s+DL\b/gi, "WEB-DL").replace(/\b(?:4K|(?:2160|1440|1080|720|576|480|360|240)p)\b/gi, " ").replace(/\b\d+(?:\.\d+)?\s*[KMGT]B\b/gi, " ").replace(/[|•]+/g, " ").replace(/\s+/g, " ").trim().replace(/\s+(?=(?:S\d{1,2}E\d{1,3}|WEB(?:-?DL|Rip)|BluRay|REMUX|HDR(?:10\+?)?|DV|DoVi|HEVC|AVC|AV1|x26[45]|H\.26[45])\b)/gi, " · ");
    return cleaned || firstLine || "Stream";
  }
  var RESOLUTION_PATTERN = /\b(4K|(?:2160|1440|1080|720|576|480|360|240)p)\b/i;
  var SOURCE_PATTERN = /\b(WEB-?DL|WEBRip|BluRay|BRRip|HDRip|REMUX)\b/i;
  var RESOLUTION_ALIASES = [
    [/\b(?:4K\s*)?UHD\b/i, "2160p"],
    [/\bQHD\b/i, "1440p"],
    [/\bFHD\b/i, "1080p"],
    [/\bHD\b/i, "720p"]
  ];
  var RESOLUTION_ORDER = ["2160p", "1440p", "1080p", "720p", "576p", "480p", "360p", "240p"];
  function normalizeResolution(value) {
    if (!value)
      return "";
    return /^4k$/i.test(value) ? "2160p" : value.toLowerCase();
  }
  function parseResolution(primary, metadata) {
    const literal = normalizeResolution(primary.match(RESOLUTION_PATTERN)?.[0] || "");
    if (literal)
      return literal;
    return RESOLUTION_ALIASES.find(([pattern]) => pattern.test(metadata))?.[1] || "";
  }
  function parseCacheStatus(value) {
    if (/\b(?:uncached|not\s+ready|download(?:ing)?)\b/i.test(value))
      return false;
    if (/\b(?:cached|instant|ready)\b/i.test(value))
      return true;
    const cached = /⚡|\[[^\]\r\n]{1,20}\+\]/.test(value);
    const uncached = /⬇|⏳/.test(value);
    return cached === uncached ? null : cached;
  }
  function parseSeeders(value) {
    const match = value.match(/(?:\bseeders?\s*[:=]?\s*|[👤👥🌱⇄⇋]\s*)(\d+)\b/iu) ?? value.match(/\bS:\s*(\d+)\b/i);
    return match ? Number(match[1]) : null;
  }
  function formatByteSize(value) {
    if (value === null)
      return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const amount = value / 1024 ** exponent;
    const precision = amount >= 10 || exponent === 0 ? 1 : 2;
    return `${Number(amount.toFixed(precision))} ${units[exponent]}`;
  }
  function parseAudioLanguages(value) {
    let audioMetadata = value.replace(/\be[\s._-]*subs?\b/gi, " ");
    LANGUAGE_ALIASES.forEach(([, aliases]) => {
      const language = `(?:${aliases.join("|")})`;
      audioMetadata = audioMetadata.replace(new RegExp(`\\b${language}\\b[\\s._-]*(?:subtitles?|subs?|cc)\\b`, "gi"), " ").replace(new RegExp(`\\b(?:subtitles?|subs?|cc)\\b[\\s:._-]*${language}\\b`, "gi"), " ");
    });
    const languages = LANGUAGE_ALIASES.flatMap(([name, aliases]) => new RegExp(`\\b(?:${aliases.join("|")})\\b`, "i").test(audioMetadata) ? [name] : []);
    if (languages.length > 1)
      return languages;
    const generic = /\bdual[\s._-]*audio\b/i.test(audioMetadata) ? "Dual Audio" : /\bmulti(?:[\s._-]*(?:audio|dub))?\b/i.test(audioMetadata) ? "Multi" : "";
    if (!generic)
      return languages;
    return languages.length === 0 ? [generic] : [...languages, "Other"];
  }
  function qualityHeight(quality) {
    if (/^4k$/i.test(quality))
      return 2160;
    const match = quality.match(/^(\d{3,4})p$/i);
    return match ? Number(match[1]) : null;
  }
  function parseSubtitleLanguages(value) {
    if (!Array.isArray(value))
      return null;
    return [...new Set(value.flatMap((entry) => {
      const language = normalizeLanguage(getString3(getRecord3(entry)?.lang));
      return language ? [language] : [];
    }))];
  }
  function normalizeLanguage(value) {
    const normalized = value.trim().toLowerCase();
    if (!normalized)
      return "";
    const language = LANGUAGE_ALIASES.find(([, aliases]) => aliases.includes(normalized))?.[0];
    if (language)
      return language;
    return normalized.length <= 3 ? normalized.toUpperCase() : value.trim();
  }
  function getRecord3(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  }
  function getString3(value) {
    return typeof value === "string" ? value : "";
  }
  function getBoolean(value) {
    return typeof value === "boolean" ? value : null;
  }
  function getPositiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  }
  function getNonNegativeInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
  }
  function getStringOrNumber(value) {
    return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  }
  function firstImdbId(...values) {
    return values.map(getString3).find(isImdbId) || "";
  }
  function normalizeTitle(value) {
    return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
  function releaseYear(value) {
    return value.match(/\b\d{4}\b/)?.[0] || "";
  }
  function getNumber2(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  // src/ui/app.ts
  var ui;
  var mediaType = "movie";
  var pendingMediaType = null;
  var episodeOrder = "oldest";
  var addons = [];
  var watchHistory = [];
  var seriesEpisodes = new Map;
  var homeQuery = "";
  var view = { kind: "home", query: "" };
  var retryAction = null;
  var pendingConfigurationResolvers = [];
  var activeRequest = null;
  var addonManifests = new Map;
  function replaceRequest(previous) {
    previous?.abort();
    return new AbortController;
  }
  function mergeSettledCatalogResults(results) {
    const groups = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    return {
      items: mergeMediaResults(groups),
      failedSources: results.length - groups.length,
      successfulSources: groups.length
    };
  }
  function getProgressDisplay(progress, watched) {
    if (watched || progress === null || progress < 5 || progress >= 90)
      return null;
    const percent = Math.round(progress);
    return { percent, label: `${percent}% watched` };
  }
  function getEpisodeOrderLabel(order) {
    return order === "newest" ? "Newest First" : "Oldest First";
  }
  function getEpisodeOrderButtonId(order) {
    return `episode-order-${order}`;
  }
  function getSizeSortControl(order) {
    return order === "largest" ? { label: "Largest File", next: "smallest" } : { label: "Smallest File", next: "largest" };
  }
  function initApp() {
    iina.onMessage(MESSAGE_NAMES.Configuration, (data) => {
      applyConfiguration(data);
      const resolvers = pendingConfigurationResolvers;
      pendingConfigurationResolvers = [];
      resolvers.forEach((resolve) => resolve());
    });
    iina.onMessage(MESSAGE_NAMES.HistoryUpdated, (data) => {
      watchHistory = parseWatchHistory(data?.history);
      if (view.kind === "history")
        renderHistory();
    });
    iina.onMessage(MESSAGE_NAMES.ShowNextEpisode, (data) => {
      const payload = data;
      if (!payload?.media || !payload?.episode || !Array.isArray(payload?.episodes)) {
        return;
      }
      loadStreams(payload.media, payload.episode, payload.episodes, payload.resolution, true);
    });
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.dataset.version = CLIENT_VERSION;
      ui = {
        back: element("back-btn"),
        content: element("content"),
        error: element("error-state"),
        errorMessage: element("error-message"),
        loading: element("loading"),
        movies: element("movies-btn"),
        retry: element("retry-btn"),
        searchClear: element("search-clear"),
        searchForm: element("search-form"),
        searchInput: element("search-input"),
        title: element("section-title"),
        tv: element("tv-btn")
      };
      ui.searchForm.addEventListener("submit", (event) => {
        event.preventDefault();
        loadHome(ui.searchInput.value.trim());
      });
      ui.searchInput.addEventListener("input", updateSearchClear);
      ui.searchClear.addEventListener("click", () => {
        ui.searchInput.value = "";
        updateSearchClear();
        ui.searchInput.focus();
        if (homeQuery)
          loadHome("");
      });
      ui.movies.addEventListener("click", () => switchType("movie"));
      ui.tv.addEventListener("click", () => switchType("series"));
      ui.back.addEventListener("click", () => void goBack());
      ui.retry.addEventListener("click", () => retryAction && void retryAction());
      updateTypeButtons();
      refreshConfiguration().then(() => loadHome(""));
    });
  }
  function applyConfiguration(data) {
    const payload = data;
    addons = parseAddons(payload?.addons);
    const incoming = parseMediaTypePreference(payload?.mediaType);
    if (pendingMediaType === null || incoming === pendingMediaType) {
      pendingMediaType = null;
      mediaType = incoming;
    }
    episodeOrder = parseEpisodeOrder(payload?.episodeOrder);
    watchHistory = parseWatchHistory(payload?.history);
    updateTypeButtons();
  }
  function refreshConfiguration() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled)
          return;
        settled = true;
        window.clearTimeout(timeout);
        pendingConfigurationResolvers = pendingConfigurationResolvers.filter((item) => item !== finish);
        resolve();
      };
      const timeout = window.setTimeout(finish, 1000);
      pendingConfigurationResolvers.push(finish);
      iina.postMessage(MESSAGE_NAMES.RequestConfiguration, {});
    });
  }
  function element(id) {
    const value = document.getElementById(id);
    if (!value)
      throw new Error(`Missing element: ${id}`);
    return value;
  }
  function switchType(type) {
    if (mediaType === type && view.kind === "home")
      return;
    mediaType = type;
    pendingMediaType = type;
    updateTypeButtons();
    iina.postMessage(MESSAGE_NAMES.SetMediaType, { mediaType });
    loadHome(ui.searchInput.value.trim());
  }
  function updateTypeButtons() {
    ui.movies.classList.toggle("active", mediaType === "movie");
    ui.tv.classList.toggle("active", mediaType === "series");
  }
  function updateSearchClear() {
    ui.searchClear.classList.toggle("hidden", ui.searchInput.value.length === 0);
  }
  async function loadHome(query) {
    const request = replaceRequest(activeRequest);
    activeRequest = request;
    homeQuery = query;
    view = { kind: "home", query };
    ui.searchInput.value = query;
    updateSearchClear();
    ui.back.classList.add("hidden");
    ui.title.textContent = query ? "Search Results" : watchHistory.length > 0 ? "Browse" : "Trending";
    setLoading("grid");
    retryAction = () => loadHome(query);
    try {
      if (!query) {
        const items = parseMediaResponse(await fetchJson(buildCinemetaTrendingUrl(mediaType), request.signal));
        if (request.signal.aborted)
          return;
        renderMedia(items, query);
        return;
      }
      const result = await searchCatalogs(query, request.signal);
      if (request.signal.aborted)
        return;
      if (result.successfulSources === 0) {
        throw new Error("Could not search any catalog.");
      }
      renderMedia(result.items, query, result.failedSources);
    } catch (error) {
      if (!request.signal.aborted)
        showError(readError(error, "Could not load Cinemeta."));
    }
  }
  async function searchCatalogs(query, signal) {
    await refreshConfiguration();
    if (signal.aborted)
      throw new DOMException("Aborted", "AbortError");
    const enabledAddons = addons.filter((addon) => addon.enabled);
    const [cinemetaResults, manifestResults] = await Promise.all([
      Promise.allSettled([
        fetchJson(buildCinemetaSearchUrl(mediaType, query), signal).then(parseMediaResponse)
      ]),
      Promise.allSettled(enabledAddons.map(async (addon) => ({
        addon,
        manifest: await loadAddonManifest(addon, signal)
      })))
    ]);
    const sources = manifestResults.flatMap((result2) => result2.status === "fulfilled" ? getSearchableCatalogs(result2.value.manifest, mediaType).map((catalog) => ({
      addon: result2.value.addon,
      catalog
    })) : []);
    const catalogResults = await Promise.allSettled(sources.map(({ addon, catalog }) => fetchJson(buildStremioResourceUrl(addon.manifestUrl, "catalog", catalog.type, catalog.id, { search: query }), signal).then((value) => parseMediaResponse(value, { manifestUrl: addon.manifestUrl }))));
    const result = mergeSettledCatalogResults([...cinemetaResults, ...catalogResults]);
    return {
      ...result,
      failedSources: result.failedSources + manifestResults.filter((item) => item.status === "rejected").length
    };
  }
  async function loadAddonManifest(addon, signal) {
    const cached = addonManifests.get(addon.manifestUrl);
    if (cached)
      return cached;
    const manifest = parseAddonManifest(await fetchJson(addon.manifestUrl, signal));
    addonManifests.set(addon.manifestUrl, manifest);
    return manifest;
  }
  async function loadMediaDetails(media, signal) {
    const sourceUrl = media.sourceManifestUrl || "";
    const providerId = media.providerId || media.id;
    const providerType = media.providerType || media.type;
    if (!sourceUrl || sourceUrl.includes("v3-cinemeta.strem.io")) {
      if (media.type === "movie")
        return { media, episodes: [], metadataAvailable: true };
      const value2 = await fetchJson(buildCinemetaSeriesUrl(media.imdbId || providerId), signal);
      const details2 = parseMediaMetadata(value2, { manifestUrl: sourceUrl }, media);
      return { ...details2, metadataAvailable: true };
    }
    const addon = addons.find((item) => item.manifestUrl === sourceUrl) || {
      name: media.name,
      manifestUrl: sourceUrl,
      enabled: true
    };
    const manifest = await loadAddonManifest(addon, signal);
    if (manifest.resources.includes("meta")) {
      const value2 = await fetchJson(buildStremioResourceUrl(sourceUrl, "meta", providerType, providerId), signal);
      const details2 = parseMediaMetadata(value2, { manifestUrl: sourceUrl }, media);
      return { ...details2, metadataAvailable: true };
    }
    if (media.type === "movie")
      return { media, episodes: [], metadataAvailable: true };
    if (!isImdbId(media.imdbId))
      return { media, episodes: [], metadataAvailable: false };
    const value = await fetchJson(buildCinemetaSeriesUrl(media.imdbId), signal);
    const details = parseMediaMetadata(value, { manifestUrl: sourceUrl }, media);
    return { ...details, metadataAvailable: true };
  }
  async function loadEpisodes(media, season) {
    const request = replaceRequest(activeRequest);
    activeRequest = request;
    view = { kind: "episodes", media };
    ui.back.classList.remove("hidden");
    ui.title.textContent = media.name;
    setLoading("episodes");
    retryAction = () => loadEpisodes(media, season);
    try {
      const details = await loadMediaDetails(media, request.signal);
      if (request.signal.aborted)
        return;
      if (!details.metadataAvailable) {
        renderEmpty("Episode metadata unavailable.");
        return;
      }
      renderEpisodes(details.media, details.episodes, undefined, season);
    } catch (error) {
      if (!request.signal.aborted)
        showError(readError(error, "Could not load episodes."));
    }
  }
  async function loadMovie(media) {
    const request = replaceRequest(activeRequest);
    activeRequest = request;
    ui.back.classList.remove("hidden");
    ui.title.textContent = media.name;
    setLoading();
    retryAction = () => loadMovie(media);
    try {
      const details = await loadMediaDetails(media, request.signal);
      if (!request.signal.aborted)
        await loadStreams(details.media);
    } catch (error) {
      if (!request.signal.aborted)
        showError(readError(error, "Could not load metadata."));
    }
  }
  async function loadStreams(media, episode, episodes = [], preferredQuality, recommendNext = false) {
    const request = replaceRequest(activeRequest);
    activeRequest = request;
    view = { kind: "streams", media, episode, episodes };
    ui.back.classList.remove("hidden");
    ui.title.textContent = episode ? formatEpisodeTitle(media, episode) : media.name;
    setLoading("rows", recommendNext);
    retryAction = () => loadStreams(media, episode, episodes, preferredQuality, recommendNext);
    try {
      await refreshConfiguration();
      if (request.signal.aborted)
        return;
      const videoId = episode?.id || media.imdbId || media.providerId || media.id;
      const [result, englishSubtitles] = await Promise.all([
        loadEnabledAddonStreams(addons, (addon) => loadAddonManifest(addon, request.signal), async (addon) => parsePlayableStreams(await fetchJson(buildStremioStreamUrl(addon.manifestUrl, media.type, videoId), request.signal))),
        isCompatibleSubtitleId(videoId) ? fetchJson(buildOpenSubtitlesUrl(media.type, videoId), request.signal).then(parseEnglishSubtitleAvailability).catch(() => null) : Promise.resolve(null)
      ]);
      if (request.signal.aborted)
        return;
      if (result.successfulAddons === 0) {
        throw new Error("Enable a stream addon in IINA Settings → Plugins → Popcorn for IINA.");
      }
      renderStreams(media, episode, episodes, result.streams, result.failedAddons, englishSubtitles, preferredQuality, recommendNext);
    } catch (error) {
      if (!request.signal.aborted)
        showError(readError(error, "Could not load streams."));
    }
  }
  async function goBack() {
    if (view.kind === "episodes") {
      await loadHome(homeQuery);
    } else if (view.kind === "streams" && view.episode) {
      await loadEpisodes(view.media, view.episode.season);
    } else if (view.kind === "streams") {
      await loadHome(homeQuery);
    } else if (view.kind === "history") {
      await loadHome(homeQuery);
    }
  }
  function renderMedia(items, query, failedSources = 0) {
    if (items.length === 0) {
      renderEmpty("No titles found.");
      return;
    }
    const fragment = document.createDocumentFragment();
    if (failedSources > 0)
      fragment.appendChild(addonWarning(failedSources, "catalog"));
    if (!query && watchHistory.length > 0) {
      const history = historySection(continueWatching(), true);
      const heading = contentHeading("Trending");
      history.dataset.historyChrome = "";
      heading.dataset.historyChrome = "";
      fragment.append(history, heading);
    }
    fragment.appendChild(mediaGrid(items.map((media) => mediaCard(media, media.name, media.releaseInfo, () => {
      if (media.type === "series")
        loadEpisodes(media);
      else
        loadMovie(media);
    }, isWatched(mediaIdentity(media)), null))));
    showContent(fragment);
  }
  function renderHistory() {
    view = { kind: "history" };
    ui.back.classList.remove("hidden");
    ui.title.textContent = "Recently Watched";
    retryAction = null;
    if (watchHistory.length === 0) {
      renderEmpty("Nothing watched yet.");
      return;
    }
    showContent(historySection(latestPerTitle(watchHistory), false));
  }
  function continueWatching() {
    return latestPerTitle(watchHistory).filter((entry) => Boolean(entry.episode) || getResumePercent(entry.progress, entry.watched) !== null);
  }
  function isUpNext(entry) {
    return Boolean(entry.episode) && getResumePercent(entry.progress, entry.watched) === null;
  }
  var HOME_HISTORY_CARDS = 6;
  var homeStrip = null;
  function historySection(entries, home) {
    const section = document.createElement("section");
    section.className = "history-section";
    if (!home) {
      section.appendChild(mediaGrid(entries.map((entry) => historySlot(entry, false))));
      return section;
    }
    section.appendChild(contentHeading("Continue Watching", renderHistory));
    const grid = mediaGrid([]);
    section.appendChild(grid);
    let next = 0;
    const fill = () => {
      while (grid.childElementCount < HOME_HISTORY_CARDS && next < entries.length) {
        const entry = entries[next];
        next += 1;
        if (!watchHistory.some((item) => item.id === entry.id))
          continue;
        const upNext = isUpNext(entry);
        const slot = historySlot(entry, upNext);
        grid.appendChild(slot);
        if (upNext)
          resolveUpNext(entry, slot).then(fill);
      }
    };
    fill();
    homeStrip = { section, fill };
    return section;
  }
  function historySlot(entry, upNext) {
    const episode = entry.episode;
    return removableSlot(entry, mediaCard(entry.media, entry.media.name, !episode ? entry.media.releaseInfo : upNext ? `After S${pad(episode.season)}E${pad(episode.episode)}` : `S${pad(episode.season)}E${pad(episode.episode)} · ${episode.name}`, () => upNext ? void loadEpisodes(entry.media) : void openHistoryEntry(entry), upNext ? false : entry.watched, upNext ? null : entry.progress));
  }
  async function resolveUpNext(entry, slot) {
    const current = entry.episode;
    if (!current)
      return;
    const details = await loadSeriesEpisodes(entry.media);
    if (!details || details.episodes.length === 0 || !slot.isConnected)
      return;
    const next = findNextEpisode(details.episodes, current);
    if (!next) {
      slot.remove();
      refillHomeStrip();
      return;
    }
    slot.replaceWith(removableSlot(entry, mediaCard(entry.media, entry.media.name, `Next · S${pad(next.season)}E${pad(next.episode)} · ${next.name}`, () => void loadStreams(details.media, next, details.episodes), false, null)));
  }
  function loadSeriesEpisodes(media) {
    const key = mediaIdentity(media);
    const cached = seriesEpisodes.get(key);
    if (cached)
      return cached;
    const request = loadMediaDetails(media, new AbortController().signal).then((details) => ({ media: details.media, episodes: details.episodes })).catch(() => {
      seriesEpisodes.delete(key);
      return null;
    });
    seriesEpisodes.set(key, request);
    return request;
  }
  function removableSlot(entry, card) {
    const slot = document.createElement("div");
    slot.className = "card-slot";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "card-remove";
    remove.textContent = "×";
    remove.title = `Remove ${entry.media.name} from Recently Watched`;
    remove.setAttribute("aria-label", remove.title);
    remove.setAttribute("data-clickable", "");
    remove.addEventListener("click", () => removeFromHistory(entry, slot));
    slot.append(card, remove);
    return slot;
  }
  function removeFromHistory(entry, slot) {
    watchHistory = watchHistory.filter((item) => historyTitleId(item) !== historyTitleId(entry));
    iina.postMessage(MESSAGE_NAMES.RemoveHistoryEntry, { id: entry.id });
    slot.remove();
    if (view.kind !== "home") {
      if (view.kind === "history" && watchHistory.length === 0) {
        renderEmpty("Nothing watched yet.");
      }
      return;
    }
    refillHomeStrip();
  }
  function refillHomeStrip() {
    const strip = homeStrip;
    if (!strip || !strip.section.isConnected)
      return;
    strip.fill();
    if (continueWatching().length > 0)
      return;
    strip.section.remove();
    homeStrip = null;
    if (homeQuery)
      return;
    if (watchHistory.length === 0) {
      ui.content.querySelectorAll("[data-history-chrome]").forEach((node) => node.remove());
    }
    ui.title.textContent = watchHistory.length > 0 ? "Browse" : "Trending";
  }
  function contentHeading(title, action) {
    const heading = document.createElement("div");
    heading.className = "content-heading";
    const label = document.createElement("h3");
    label.textContent = title;
    heading.appendChild(label);
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "See all";
      button.setAttribute("data-clickable", "");
      button.addEventListener("click", action);
      heading.appendChild(button);
    }
    return heading;
  }
  function mediaGrid(cards) {
    const grid = document.createElement("div");
    grid.className = "media-grid";
    grid.append(...cards);
    return grid;
  }
  function mediaCard(media, title, subtitle, action, watched, progress = null) {
    const card = document.createElement("button");
    card.className = "media-card";
    card.type = "button";
    card.setAttribute("data-clickable", "");
    card.setAttribute("aria-label", watched ? `${title}, watched` : title);
    card.addEventListener("click", action);
    const poster = document.createElement("div");
    poster.className = "poster";
    const posterUrl = media.poster || (isImdbId(media.imdbId) ? buildCinemetaPosterUrl(media.imdbId) : "");
    if (posterUrl) {
      const image = document.createElement("img");
      image.src = posterUrl;
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener("error", () => image.remove(), { once: true });
      poster.appendChild(image);
    }
    if (watched) {
      const badge = document.createElement("span");
      badge.className = "watched-badge";
      badge.textContent = "✓";
      badge.title = "Watched";
      poster.appendChild(badge);
    }
    const progressDisplay = getProgressDisplay(progress, watched);
    if (progressDisplay) {
      const track = document.createElement("span");
      track.className = "poster-progress";
      track.title = progressDisplay.label;
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(progressDisplay.percent));
      const fill = document.createElement("span");
      fill.style.width = `${progressDisplay.percent}%`;
      track.appendChild(fill);
      poster.appendChild(track);
    }
    const name = document.createElement("span");
    name.className = "media-name";
    name.textContent = title;
    const detail = document.createElement("span");
    detail.className = "media-year";
    detail.textContent = subtitle;
    card.append(poster, name, detail);
    return card;
  }
  async function openHistoryEntry(entry) {
    if (!entry.episode) {
      await loadStreams(entry.media);
      return;
    }
    ui.back.classList.remove("hidden");
    ui.title.textContent = entry.media.name;
    setLoading();
    retryAction = () => openHistoryEntry(entry);
    const request = replaceRequest(activeRequest);
    activeRequest = request;
    try {
      const details = await loadMediaDetails(entry.media, request.signal);
      const episode = details.episodes.find((item) => item.id === entry.episode?.id) || entry.episode;
      await loadStreams(details.media, episode, details.episodes);
    } catch (error) {
      if (!request.signal.aborted)
        showError(readError(error, "Could not open this episode."));
    }
  }
  function addonWarning(count, subject) {
    const warning = document.createElement("div");
    warning.className = "addon-warning";
    warning.textContent = `${count} ${subject}${count === 1 ? "" : "s"} unavailable`;
    return warning;
  }
  function isWatched(id) {
    return watchHistory.some((entry) => entry.id === id && entry.watched);
  }
  function getEntryProgress(id) {
    const entry = watchHistory.find((item) => item.id === id);
    return entry ? getResumePercent(entry.progress, entry.watched) : null;
  }
  function mediaIdentity(media) {
    return media.imdbId || media.providerId || media.id;
  }
  function getDefaultSeason(episodes, watched, available = isEpisodeAvailable) {
    const ordered = sortEpisodes(episodes, "oldest");
    const next = ordered.find((episode) => available(episode) && !watched(episode));
    return (next || ordered[0])?.season ?? 0;
  }
  function renderEpisodes(media, episodes, focusOrder, selectedSeason) {
    if (episodes.length === 0) {
      renderEmpty("No episodes found.");
      return;
    }
    const seasons = new Map;
    sortEpisodes(episodes, episodeOrder).forEach((episode) => {
      seasons.set(episode.season, [...seasons.get(episode.season) || [], episode]);
    });
    const numbers = [...seasons.keys()].sort((a, b) => a - b);
    const nextSeason = getDefaultSeason(episodes, (episode) => isWatched(episode.id));
    const active = selectedSeason !== undefined && seasons.has(selectedSeason) ? selectedSeason : seasons.has(nextSeason) ? nextSeason : numbers[0];
    const fragment = document.createDocumentFragment();
    const nav = document.createElement("div");
    nav.className = "season-nav";
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", "Seasons");
    numbers.forEach((season) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "season-chip";
      chip.textContent = season === 0 ? "Specials" : `S${season}`;
      chip.title = season === 0 ? "Specials" : `Season ${season}`;
      chip.setAttribute("role", "tab");
      chip.setAttribute("aria-selected", String(season === active));
      chip.classList.toggle("active", season === active);
      if (season === nextSeason)
        chip.dataset.next = "";
      chip.setAttribute("data-clickable", "");
      chip.addEventListener("click", () => {
        if (season === active)
          return;
        renderEpisodes(media, episodes, undefined, season);
      });
      nav.appendChild(chip);
    });
    const order = episodeOrder === "newest" ? "oldest" : "newest";
    const orderButton = document.createElement("button");
    orderButton.type = "button";
    orderButton.className = "season-order";
    orderButton.id = getEpisodeOrderButtonId(episodeOrder);
    orderButton.textContent = episodeOrder === "newest" ? "NEWEST ↑" : "OLDEST ↓";
    orderButton.title = `Sort ${getEpisodeOrderLabel(order)}`;
    orderButton.setAttribute("data-clickable", "");
    orderButton.addEventListener("click", () => {
      episodeOrder = order;
      iina.postMessage(MESSAGE_NAMES.SetEpisodeOrder, { episodeOrder });
      renderEpisodes(media, episodes, order, active);
    });
    nav.appendChild(orderButton);
    fragment.appendChild(nav);
    const list = document.createElement("div");
    list.className = "episode-list";
    (seasons.get(active) || []).forEach((episode) => {
      list.appendChild(episodeRow(media, episode, episodes));
    });
    fragment.appendChild(list);
    showContent(fragment);
    if (focusOrder)
      document.getElementById(getEpisodeOrderButtonId(focusOrder))?.focus();
  }
  function episodeRow(media, episode, episodes) {
    const available = isEpisodeAvailable(episode);
    const watched = available && isWatched(episode.id);
    const progress = available && !watched ? getEntryProgress(episode.id) : null;
    const resume = getProgressDisplay(progress, watched);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "erow";
    button.disabled = !available;
    button.classList.toggle("erow--watched", watched);
    if (available) {
      button.setAttribute("data-clickable", "");
      button.addEventListener("click", () => void loadStreams(media, episode, episodes));
    }
    const number = document.createElement("span");
    number.className = "erow-num";
    number.textContent = pad(episode.episode);
    const name = document.createElement("span");
    name.className = "erow-name";
    name.textContent = episode.name;
    name.title = episode.name;
    button.append(number, name);
    if (!available) {
      const airs = document.createElement("span");
      airs.className = "erow-airs";
      const date = formatDate(episode.aired);
      airs.textContent = date ? `Airs ${date}` : "Unaired";
      button.appendChild(airs);
    } else if (watched) {
      const mark = document.createElement("span");
      mark.className = "erow-mark";
      mark.textContent = "✓";
      mark.title = "Watched";
      button.appendChild(mark);
    } else {
      button.appendChild(document.createElement("span"));
    }
    if (resume) {
      const track = document.createElement("span");
      track.className = "erow-bar";
      track.title = resume.label;
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(resume.percent));
      const fill = document.createElement("span");
      fill.style.width = `${resume.percent}%`;
      track.appendChild(fill);
      button.appendChild(track);
      button.classList.add("erow--resuming");
    }
    return button;
  }
  function renderStreams(media, episode, episodes, streams, failedAddons, englishSubtitles, preferredQuality, recommendNext = false) {
    if (streams.length === 0) {
      renderEmpty("No direct HTTP streams. The enabled addons may only return torrent entries.");
      return;
    }
    const content = document.createDocumentFragment();
    if (failedAddons > 0)
      content.appendChild(addonWarning(failedAddons, "addon"));
    const playStream = (stream) => {
      const resumePercent = getEntryProgress(episode?.id || mediaIdentity(media));
      iina.postMessage(MESSAGE_NAMES.PlayItem, {
        url: stream.url,
        title: episode ? formatEpisodeTitle(media, episode) : media.name,
        playbackContext: {
          media,
          ...episode ? { episode } : {},
          episodes,
          resolution: stream.resolution
        },
        ...resumePercent === null ? {} : { resumePercent }
      });
    };
    const varying = getVaryingStreamFields(streams);
    if (recommendNext) {
      const recommendation = findClosestQualityStream(streams, preferredQuality || "");
      if (recommendation) {
        const button = rowButton("Play Next Episode", buildNextEpisodeDetail(recommendation), () => playStream(recommendation), false, false, recommendation.rawTitle);
        button.classList.add("next-episode");
        content.appendChild(button);
      }
    }
    const seriesPrefix = episode ? buildSeriesPrefixPattern(media, episode) : null;
    let sizeOrder = "largest";
    const summary = document.createElement("div");
    summary.className = "stream-summary";
    const summaryText = document.createElement("span");
    const sortButton = document.createElement("button");
    sortButton.type = "button";
    sortButton.className = "stream-sort-toggle";
    sortButton.title = "Toggle file-size sorting";
    sortButton.setAttribute("data-clickable", "");
    summary.append(summaryText, sortButton);
    const list = document.createElement("div");
    const renderList = () => {
      sortButton.textContent = getSizeSortControl(sizeOrder).label;
      summaryText.textContent = buildStreamSummary(streams, varying, englishSubtitles);
      list.replaceChildren(...buildStreamTiers(streams, sizeOrder, varying, seriesPrefix, playStream));
    };
    sortButton.addEventListener("click", () => {
      sizeOrder = getSizeSortControl(sizeOrder).next;
      renderList();
    });
    renderList();
    content.append(summary, list);
    showContent(content);
  }
  function buildNextEpisodeDetail(stream) {
    return [
      stream.resolution,
      stream.source,
      stream.audioLanguages.length > 0 ? getAudioBadge(stream.audioLanguages).label : "",
      stream.size,
      stream.cached === true ? "Ready" : stream.cached === false ? "Not cached" : ""
    ].filter(Boolean).join(" · ");
  }
  function getVaryingStreamFields(streams) {
    const differs = (read) => new Set(streams.map(read)).size > 1;
    return {
      addon: differs((stream) => stream.addonName),
      cache: differs((stream) => stream.cached),
      source: differs((stream) => stream.source)
    };
  }
  function buildStreamSummary(streams, varying, englishSubtitles) {
    const first = streams[0];
    const parts = [`${streams.length} ${streams.length === 1 ? "stream" : "streams"}`];
    if (!varying.addon && first)
      parts.push(first.addonName);
    if (englishSubtitles === true)
      parts.push("EN subs");
    else if (englishSubtitles === false)
      parts.push("no EN subs");
    if (!varying.source && first?.source)
      parts.push(first.source);
    if (!varying.cache && first) {
      parts.push(first.cached === null ? "cache unknown" : first.cached ? "all ready" : "none cached");
    }
    return parts.join(" · ");
  }
  function getTierRowCap(readyCount) {
    return Math.min(Math.max(readyCount, 5), 15);
  }
  function buildSeriesPrefixPattern(media, episode) {
    const name = media.name.trim();
    if (!name)
      return null;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const season = String(episode.season);
    const number = String(episode.episode);
    return new RegExp(`^\\s*${escaped}[\\s(]*(?:\\d{4}\\)?)?[\\s\\-–·()]*` + `(?:s0?${season}\\s*[.\\s]?e0?${number}|s0?${season}|0?${season}x0?${number}` + `|season\\s*0?${season})?[\\s\\-–·]*`, "i");
  }
  function buildStreamTiers(streams, sizeOrder, varying, seriesPrefix, playStream) {
    const tiers = groupStreamsByResolution(streams);
    const openTier = getDefaultTier(tiers);
    return tiers.map(({ resolution, streams: tierStreams }) => {
      const ordered = sortStreamsForPlayback(tierStreams, sizeOrder);
      const ready = ordered.filter((stream) => stream.cached === true).length;
      const cap = getTierRowCap(ready);
      const section = document.createElement("details");
      section.className = "tier";
      section.dataset.tier = resolution;
      section.open = resolution === openTier;
      const heading = document.createElement("summary");
      const name = document.createElement("span");
      name.className = "tier-name";
      name.textContent = resolution;
      heading.appendChild(name);
      if (ready > 0) {
        const readyLabel = document.createElement("span");
        readyLabel.className = "tier-ready";
        readyLabel.textContent = `${ready} ready`;
        readyLabel.title = `${ready} ready to play without downloading`;
        heading.appendChild(readyLabel);
      }
      const count = document.createElement("span");
      count.className = "tier-count";
      count.textContent = String(ordered.length);
      heading.appendChild(count);
      section.appendChild(heading);
      const body = document.createElement("div");
      body.className = "tier-body";
      const draw = (limit) => {
        body.replaceChildren(...ordered.slice(0, limit).map((stream) => streamRow(stream, varying, seriesPrefix, () => playStream(stream))));
        if (limit < ordered.length) {
          const more = document.createElement("button");
          more.type = "button";
          more.className = "show-more";
          more.textContent = `Show ${ordered.length - limit} more`;
          more.setAttribute("data-clickable", "");
          more.addEventListener("click", () => draw(ordered.length));
          body.appendChild(more);
        }
      };
      draw(cap);
      section.appendChild(body);
      section.addEventListener("toggle", () => {
        if (section.open)
          lastOpenTier = resolution;
      });
      return section;
    });
  }
  function getDefaultTier(tiers, remembered = lastOpenTier) {
    if (remembered && tiers.some(({ resolution }) => resolution === remembered))
      return remembered;
    const withReady = tiers.find(({ streams }) => streams.some((stream) => stream.cached === true));
    if (withReady)
      return withReady.resolution;
    return tiers.reduce((best, tier) => tier.streams.length > best.streams.length ? tier : best, tiers[0])?.resolution || "";
  }
  function streamRow(stream, varying, seriesPrefix, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "srow";
    button.setAttribute("data-clickable", "");
    button.addEventListener("click", action);
    if (varying.cache) {
      const dot = document.createElement("span");
      const state = stream.cached === true ? "ok" : stream.cached === false ? "warn" : "unknown";
      dot.className = `dot dot--${state}`;
      dot.title = getCacheBadge(stream.cached).title;
      button.appendChild(dot);
    } else {
      button.classList.add("srow--nodot");
    }
    const main = document.createElement("span");
    main.className = "srow-main";
    const title = document.createElement("span");
    title.className = "srow-title";
    title.textContent = stripSeriesPrefix(stream.title, seriesPrefix);
    title.title = stream.rawTitle;
    main.appendChild(title);
    const meta = buildRowMeta(stream, varying);
    if (meta) {
      const line = document.createElement("span");
      line.className = "srow-meta";
      line.textContent = meta;
      main.appendChild(line);
    }
    button.appendChild(main);
    const size = document.createElement("span");
    size.className = "srow-size";
    size.textContent = stream.size || "—";
    button.appendChild(size);
    if (stream.cached === false)
      button.classList.add("srow--uncached");
    return button;
  }
  function stripSeriesPrefix(title, pattern) {
    if (!pattern)
      return title;
    const stripped = title.replace(pattern, "").replace(/^[-–·(\s]+/, "").trim();
    return stripped || title;
  }
  function buildRowMeta(stream, varying) {
    const parts = [];
    if (varying.source && stream.source)
      parts.push(stream.source);
    if (stream.audioLanguages.length > 0)
      parts.push(getAudioBadge(stream.audioLanguages).label);
    if (varying.addon)
      parts.push(stream.addonName);
    if (stream.cached !== true && stream.seeders !== null)
      parts.push(`${stream.seeders} seeders`);
    return parts.join(" · ");
  }
  var lastOpenTier = null;
  function getAudioBadge(languages) {
    if (languages.length === 0) {
      return { label: "Audio ?", title: "Audio language not provided" };
    }
    if (languages.length === 1) {
      const language = languages[0];
      const title = language === "Multi" || language === "Dual Audio" ? "Multiple audio languages (not specified)" : `Audio: ${language}`;
      return { label: language, title };
    }
    return {
      label: `Multi (${languages.length})`,
      title: `Audio: ${languages.map((language) => language === "Other" ? "other languages" : language).join(", ")}`
    };
  }
  function getCacheBadge(cached) {
    if (cached === true) {
      return { label: "Cached", title: "Ready to play from debrid cache", state: "cached" };
    }
    if (cached === false) {
      return { label: "Uncached", title: "Not currently available in debrid cache", state: "uncached" };
    }
    return { label: "Cache ?", title: "Cache status not provided", state: "unknown" };
  }
  function rowButton(title, subtitle, action, disabled = false, watched = false, titleTooltip = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "row";
    button.disabled = disabled;
    if (!disabled)
      button.setAttribute("data-clickable", "");
    const body = document.createElement("span");
    body.className = "row-body";
    const heading = document.createElement("span");
    heading.className = "row-title";
    heading.textContent = title;
    if (titleTooltip)
      heading.title = titleTooltip;
    const detail = document.createElement("span");
    detail.className = "row-detail";
    if (typeof subtitle === "string") {
      detail.textContent = subtitle;
    } else {
      detail.appendChild(subtitle);
    }
    const play = document.createElement("span");
    play.className = `row-play${watched ? " row-play--watched" : ""}`;
    play.textContent = watched ? "✓" : disabled ? "" : "▶";
    if (watched)
      play.title = "Watched";
    body.append(heading, detail);
    button.append(body, play);
    if (!disabled)
      button.addEventListener("click", action);
    return button;
  }
  async function fetchJson(url, signal) {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal });
    if (!response.ok)
      throw new Error(`Request failed with HTTP ${response.status}.`);
    return await response.json();
  }
  function setLoading(shape = "rows", leadCard = false) {
    ui.loading.className = `loading loading--${shape}`;
    ui.loading.replaceChildren(...buildSkeleton(shape, leadCard));
    ui.content.classList.add("hidden");
    ui.error.classList.add("hidden");
  }
  var SKELETON_RUNS = {
    "sk-tile": 0,
    "sk-lead": 2,
    "sk-summary": 2,
    "sk-tier": 2,
    "sk-row": 3,
    "sk-chips": 4,
    "sk-erow": 2
  };
  function getSkeletonCells(shape, leadCard = false) {
    if (shape === "grid")
      return Array.from({ length: 6 }, () => "sk-tile");
    if (shape === "episodes") {
      return ["sk-chips", ...Array.from({ length: 8 }, () => "sk-erow")];
    }
    return [
      ...leadCard ? ["sk-lead"] : [],
      "sk-summary",
      "sk-tier",
      ...Array.from({ length: 6 }, () => "sk-row")
    ];
  }
  function buildSkeleton(shape, leadCard) {
    return getSkeletonCells(shape, leadCard).map((className) => {
      const node = document.createElement("div");
      node.className = className;
      for (let index = 0;index < (SKELETON_RUNS[className] || 0); index += 1) {
        node.appendChild(document.createElement("span"));
      }
      return node;
    });
  }
  function showContent(content) {
    ui.loading.classList.add("hidden");
    ui.error.classList.add("hidden");
    ui.content.classList.remove("hidden");
    ui.content.replaceChildren(content);
  }
  function renderEmpty(message) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = message;
    showContent(empty);
  }
  function showError(message) {
    ui.loading.classList.add("hidden");
    ui.content.classList.add("hidden");
    ui.error.classList.remove("hidden");
    ui.errorMessage.textContent = message;
  }
  function readError(error, fallback) {
    return error instanceof Error && error.message ? error.message : fallback;
  }
  function formatEpisodeTitle(media, episode) {
    return `${media.name} · S${pad(episode.season)}E${pad(episode.episode)} · ${episode.name}`;
  }
  function pad(value) {
    return String(value).padStart(2, "0");
  }
  function formatDate(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleDateString() : "";
  }

  // src/ui/sidebar.ts
  initApp();
})();
