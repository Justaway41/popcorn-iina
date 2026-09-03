(() => {
  // src/shared/messages.ts
  var MESSAGE_NAMES = {
    PlayItem: "playItem",
    RequestConfiguration: "requestConfiguration",
    Configuration: "configuration",
    SetMediaType: "setMediaType",
    SetEpisodeOrder: "setEpisodeOrder",
    HistoryUpdated: "historyUpdated",
    RemoveHistoryEntry: "removeHistoryEntry",
    ShowNextEpisode: "showNextEpisode",
    NowPlaying: "nowPlaying"
  };

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
  async function loadAddonStreams(addons, load, options = {}) {
    const { timeoutMs, onProgress } = options;
    const answers = addons.map(() => null);
    let failedAddons = 0;
    let successfulAddons = 0;
    let pending = addons.length;
    const collect = () => {
      const seen = new Set;
      const streams = [];
      answers.forEach((answer, index) => {
        answer?.forEach((stream) => {
          if (seen.has(stream.url))
            return;
          seen.add(stream.url);
          streams.push({ ...stream, addonName: addons[index].name });
        });
      });
      return { streams, failedAddons, successfulAddons };
    };
    await Promise.all(addons.map(async (addon, index) => {
      try {
        const answer = await withinTimeout(load(addon), timeoutMs);
        if (answer !== null) {
          answers[index] = answer;
          successfulAddons += 1;
        }
      } catch {
        failedAddons += 1;
      }
      pending -= 1;
      if (pending > 0)
        onProgress?.(collect());
    }));
    return collect();
  }
  async function loadEnabledAddonStreams(addons, loadManifest, loadStreams, options = {}) {
    const manifestTimeoutMs = options.manifestTimeoutMs ?? options.timeoutMs;
    return loadAddonStreams(addons.filter((addon) => addon.enabled), async (addon) => {
      const manifest = await withinTimeout(loadManifest(addon), manifestTimeoutMs);
      return manifest.resources.includes("stream") ? await loadStreams(addon) : null;
    }, options);
  }
  function withinTimeout(promise, timeoutMs) {
    if (!timeoutMs || timeoutMs <= 0)
      return promise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Addon did not answer within ${timeoutMs} ms.`)), timeoutMs);
      promise.then((value) => {
        clearTimeout(timer);
        resolve(value);
      }, (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
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
  function parseEpisodeWatchState(value, legacyHistory = []) {
    let stored = value;
    try {
      stored = typeof value === "string" ? JSON.parse(value) : value;
    } catch {
      stored = null;
    }
    const item = getRecord2(stored);
    const state = {
      local: parseWatchedShows(item?.local),
      simkl: parseWatchedShows(item?.simkl),
      simklCours: parseWatchedCours(item?.simklCours)
    };
    for (const entry of legacyHistory) {
      if (!entry.watched || !entry.episode)
        continue;
      addWatchedEpisode(state.local, historyTitleId(entry), episodeCoordinate(entry.episode));
    }
    return state;
  }
  function episodeCoordinate(episode) {
    return `${episode.season}:${episode.episode}`;
  }
  function markEpisodeWatched(state, context) {
    if (!context.episode)
      return state;
    const next = parseEpisodeWatchState(state);
    addWatchedEpisode(next.local, mediaTitleId(context.media), episodeCoordinate(context.episode));
    return next;
  }
  function applySimklWatchedPatches(state, patches) {
    const next = parseEpisodeWatchState(state);
    for (const patch of parseWatchedShows(patches)) {
      next.simkl = next.simkl.filter((show) => show.id !== patch.id);
      if (patch.episodes.length > 0)
        next.simkl.push(patch);
    }
    return next;
  }
  function addSimklWatchedEpisodes(state, patches) {
    const next = parseEpisodeWatchState(state);
    for (const patch of parseWatchedShows(patches)) {
      for (const episode of patch.episodes)
        addWatchedEpisode(next.simkl, patch.id, episode);
    }
    return next;
  }
  function mergeSimklCours(state, cours) {
    const next = parseEpisodeWatchState(state);
    for (const cour of parseWatchedCours(cours)) {
      next.simklCours = next.simklCours.filter((item) => item.malId !== cour.malId);
      next.simklCours.push(cour);
    }
    return next;
  }
  function parseWatchedCours(value) {
    if (!Array.isArray(value))
      return [];
    return value.flatMap((item) => {
      const record = getRecord2(item);
      const malId = readString(record?.malId);
      if (!malId)
        return [];
      const episodes = Array.isArray(record?.episodes) ? [...new Set(record.episodes.filter(isCourEpisode))] : [];
      const paused = getRecord2(record?.paused);
      const pausedEpisode = paused ? paused.episode : null;
      const progress = typeof paused?.progress === "number" ? paused.progress : null;
      const cour = {
        malId,
        imdbId: readString(record?.imdbId),
        name: readString(record?.name),
        year: readString(record?.year),
        ownsImdb: record?.ownsImdb !== false,
        simklId: readString(record?.simklId),
        episodes,
        lastWatchedAt: readString(record?.lastWatchedAt)
      };
      if (isCourEpisode(pausedEpisode) && progress !== null && Number.isFinite(progress)) {
        cour.paused = {
          episode: pausedEpisode,
          at: readString(paused?.at),
          progress: Math.max(0, Math.min(100, progress))
        };
      }
      return episodes.length > 0 || cour.paused ? [cour] : [];
    });
  }
  function isCourEpisode(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
  }
  function readString(value) {
    return typeof value === "string" ? value : "";
  }
  function recordPlayback(entries, context, percent, playedAt) {
    if (!Number.isFinite(percent) || percent < 5)
      return entries;
    const id = historyContextId(context);
    const existing = entries.find((entry2) => entry2.id === id);
    const progress = Math.max(0, Math.min(100, percent));
    const entry = {
      id,
      media: context.media,
      ...context.episode ? { episode: context.episode } : {},
      lastPlayedAt: playedAt,
      watched: Boolean(existing?.watched || progress >= 90),
      progress
    };
    const titleId = mediaTitleId(context.media);
    return [entry, ...entries.filter((item) => item.id !== id && (entry.watched || item.watched || historyTitleId(item) !== titleId))].slice(0, MAX_HISTORY_ITEMS);
  }
  function removeHistoryEntry(entries, id) {
    const target = entries.find((entry) => entry.id === id);
    if (!id || !target)
      return entries;
    return entries.filter((entry) => historyTitleId(entry) !== historyTitleId(target));
  }
  function historyTitleId(entry) {
    return mediaTitleId(entry.media);
  }
  function getHistoryEntry(entries, context) {
    const id = historyContextId(context);
    return entries.find((entry) => entry.id === id) || null;
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
  function parseWatchedShows(value) {
    if (!Array.isArray(value))
      return [];
    const shows = [];
    for (const valueShow of value) {
      const item = getRecord2(valueShow);
      const id = getString2(item?.id).trim();
      if (!id || !Array.isArray(item?.episodes))
        continue;
      const existing = shows.find((show2) => show2.id === id);
      const show = existing || { id, episodes: [] };
      if (!existing)
        shows.push(show);
      for (const coordinate of item.episodes) {
        if (typeof coordinate !== "string" || !isEpisodeCoordinate(coordinate))
          continue;
        if (!show.episodes.includes(coordinate))
          show.episodes.push(coordinate);
      }
      show.episodes.sort(compareEpisodeCoordinates);
    }
    return shows;
  }
  function addWatchedEpisode(shows, id, coordinate) {
    if (!id || !isEpisodeCoordinate(coordinate))
      return;
    let show = shows.find((item) => item.id === id);
    if (!show) {
      show = { id, episodes: [] };
      shows.push(show);
    }
    if (!show.episodes.includes(coordinate))
      show.episodes.push(coordinate);
    show.episodes.sort(compareEpisodeCoordinates);
  }
  function isEpisodeCoordinate(value) {
    const match = /^(\d+):(\d+)$/.exec(value);
    if (!match)
      return false;
    return match.slice(1).every((part) => Number.isSafeInteger(Number(part)));
  }
  function compareEpisodeCoordinates(first, second) {
    const [firstSeason, firstEpisode] = first.split(":").map(Number);
    const [secondSeason, secondEpisode] = second.split(":").map(Number);
    return firstSeason - secondSeason || firstEpisode - secondEpisode;
  }
  function mediaTitleId(media) {
    return media.imdbId || media.providerId || media.id;
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
  function historyContextId(context) {
    return context.episode?.id || context.media.imdbId || context.media.providerId || context.media.id;
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

  // src/shared/stremio.ts
  var CINEMETA_BASE_URL = "https://v3-cinemeta.strem.io";
  var CINEMETA_MANIFEST_URL = `${CINEMETA_BASE_URL}/manifest.json`;
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
  function buildCinemetaSeriesUrl(imdbId) {
    return `${CINEMETA_BASE_URL}/meta/series/${encodeURIComponent(imdbId)}.json`;
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
  function parseMediaTypePreference(value) {
    return value === "series" ? "series" : "movie";
  }
  function parseEpisodeOrder(value) {
    return value === "newest" ? "newest" : "oldest";
  }
  function parseSkipSegments(value) {
    return value !== false;
  }
  function cacheRank(cached) {
    return cached === true ? 0 : cached === null ? 1 : 2;
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
  function isImdbId(value) {
    return /^tt\d+$/i.test(value.trim());
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
  function parseReleaseShowTitle(description) {
    const line = (description.split(`
`)[0] || "").replace(/[^\x20-\x7E]+/g, " ");
    const marker = /\bS\d{1,2}(?:-\d{1,2})?\b|\bE\d{1,4}\b|\(\d{4}\)/i.exec(line);
    if (!marker || marker.index === 0)
      return "";
    return line.slice(0, marker.index).trim().replace(/\s+/g, " ");
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
        seeders: structuredSeeders ?? parseSeeders(metadata),
        showTitle: parseReleaseShowTitle(description)
      }];
    });
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
  function getNumber2(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  // src/shared/stream-choice.ts
  function titleKey(value) {
    return value.replace(/\([^)]*\)/g, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function showRank(streamTitle, wanted) {
    if (!wanted || !streamTitle)
      return 0;
    return titleKey(streamTitle) === titleKey(wanted) ? 0 : 1;
  }
  function releaseTokens(name) {
    return new Set(name.toLowerCase().replace(/\.[a-z0-9]{2,4}$/, "").replace(/\d+/g, " ").split(/[^a-z]+/).filter((token) => token.length > 1));
  }
  var SAME_RELEASE_OVERLAP = 0.6;
  function releaseRank(name, previous) {
    if (previous.size === 0)
      return 0;
    const tokens = releaseTokens(name);
    if (tokens.size === 0)
      return 1;
    let shared = 0;
    tokens.forEach((token) => {
      if (previous.has(token))
        shared += 1;
    });
    return shared / Math.max(tokens.size, previous.size) >= SAME_RELEASE_OVERLAP ? 0 : 1;
  }
  function pickNextEpisodeStream(streams, options = {}) {
    const target = qualityHeight(options.previousResolution || "");
    const preferredAudio = (options.preferredAudio || "").trim().toLowerCase();
    const preferredSubtitle = (options.preferredSubtitle || "").trim().toLowerCase();
    const previousRelease = releaseTokens(options.previousRelease || "");
    let bestStream = null;
    let bestRank = [];
    streams.forEach((stream, index) => {
      const height = qualityHeight(stream.resolution);
      if (height === null)
        return;
      const rank = [
        showRank(stream.showTitle || "", options.showTitle || ""),
        cacheRank(stream.cached),
        releaseRank(stream.rawTitle || "", previousRelease),
        languageRank(stream.audioLanguages, preferredAudio),
        languageRank(stream.subtitleLanguages, preferredSubtitle),
        target !== null && height === target ? 0 : 1,
        -height,
        index
      ];
      if (!bestStream || compareRanks(rank, bestRank) < 0) {
        bestStream = stream;
        bestRank = rank;
      }
    });
    return bestStream;
  }
  var UNNAMED_AUDIO_LABELS = ["dual audio", "multi", "other"];
  function languageRank(languages, preferred) {
    if (!preferred)
      return 0;
    if (!languages || languages.length === 0)
      return 1;
    const normalized = languages.map((language) => language.trim().toLowerCase());
    if (normalized.includes(preferred))
      return 0;
    return normalized.every((language) => UNNAMED_AUDIO_LABELS.includes(language)) ? 1 : 2;
  }
  function compareRanks(a, b) {
    for (let index = 0;index < a.length; index += 1) {
      if (a[index] !== b[index])
        return a[index] - b[index];
    }
    return 0;
  }
  function qualityHeight(quality) {
    if (/^4k$/i.test(quality))
      return 2160;
    const match = quality.match(/^(\d{3,4})p$/i);
    return match ? Number(match[1]) : null;
  }

  // src/shared/trakt.ts
  class TraktError extends Error {
    status;
    retryAt;
    constructor(status, retryAt = 0, message = `Trakt request failed with status ${status}.`) {
      super(message);
      this.status = status;
      this.retryAt = retryAt;
      this.name = "TraktError";
    }
  }
  var TRAKT_API = "https://api.trakt.tv";
  var MAX_HISTORY_ITEMS2 = 100;
  var TOKEN_REFRESH_WINDOW_MS = 60000;
  var DEFAULT_RETRY_MS = 60000;
  function apiHeaders(state) {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "trakt-api-key": state.clientId,
      "trakt-api-version": "2",
      ...state.tokens ? { Authorization: `Bearer ${state.tokens.accessToken}` } : {}
    };
  }
  function parseTraktState(value) {
    const item = getRecord4(parseJson(value));
    const tokens = getRecord4(item?.tokens);
    const accessToken = getString4(tokens?.accessToken);
    const refreshToken = getString4(tokens?.refreshToken);
    const expiresAt = getPositiveNumber2(tokens?.expiresAt);
    return {
      clientId: getString4(item?.clientId),
      clientSecret: getString4(item?.clientSecret),
      tokens: accessToken && refreshToken && expiresAt ? { accessToken, refreshToken, expiresAt } : null,
      reconnectRequired: item?.reconnectRequired === true,
      initialHistoryUploaded: item?.initialHistoryUploaded === true,
      lastSyncAt: getString4(item?.lastSyncAt),
      lastError: getString4(item?.lastError),
      retryAt: getNonNegativeNumber(item?.retryAt)
    };
  }
  function buildScrobblePayload(context, progress) {
    const value = Math.max(0, Math.min(100, progress));
    if (!context.episode) {
      return { movie: { ids: { imdb: context.media.imdbId } }, progress: value };
    }
    return {
      show: { ids: { imdb: context.media.imdbId } },
      episode: { season: context.episode.season, number: context.episode.episode },
      progress: value
    };
  }
  async function refreshTraktTokens(transport, state, now = Date.now()) {
    if (!state.tokens || state.tokens.expiresAt - now >= TOKEN_REFRESH_WINDOW_MS) {
      return state;
    }
    try {
      const data = await request(transport, state, "POST", "/oauth/token", {
        refresh_token: state.tokens.refreshToken,
        client_id: state.clientId,
        client_secret: state.clientSecret,
        redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
        grant_type: "refresh_token"
      }, now);
      return {
        ...state,
        tokens: parseTokens(data),
        reconnectRequired: false,
        lastError: "",
        retryAt: 0
      };
    } catch (error) {
      if (isRefreshRejection(error))
        return reconnectState(state);
      throw error;
    }
  }
  async function scrobble(transport, state, action, context, progress, now = Date.now()) {
    if (!isImdbId(context.media.imdbId))
      return state;
    if (state.retryAt > now)
      return state;
    let current = state;
    try {
      current = await refreshTraktTokens(transport, current, now);
      if (!current.tokens) {
        return current.reconnectRequired ? current : { ...current, lastError: "Trakt is not connected." };
      }
      await request(transport, current, "POST", `/scrobble/${action}`, buildScrobblePayload(context, progress), now);
      return { ...current, lastError: "", retryAt: 0 };
    } catch (error) {
      if (isAuthenticationError(error))
        return reconnectState(current);
      return {
        ...current,
        lastError: error instanceof Error ? error.message : "Trakt request failed.",
        retryAt: error instanceof TraktError ? error.retryAt : 0
      };
    }
  }
  async function syncTraktHistory(transport, state, local, now = Date.now()) {
    if (state.retryAt > now)
      return { state, history: local };
    let current = state;
    try {
      current = await refreshTraktTokens(transport, state, now);
      if (!current.tokens) {
        return {
          state: current.reconnectRequired ? current : { ...current, lastError: "Trakt is not connected." },
          history: local
        };
      }
      const playback = await request(transport, current, "GET", "/sync/playback", null, now);
      const watched = await request(transport, current, "GET", "/sync/history?limit=100", null, now);
      const history = mergeWatchHistory(local, parseTraktHistory(playback, watched));
      if (!current.initialHistoryUploaded) {
        const remoteWatched = new Set(parseTraktHistory([], watched).map(historyKey));
        const pending = local.filter((entry) => entry.watched && isImdbId(entry.media.imdbId) && !remoteWatched.has(historyKey(entry)));
        if (pending.length > 0) {
          await request(transport, current, "POST", "/sync/history", historyUploadPayload(pending), now);
        }
      }
      return {
        state: {
          ...current,
          initialHistoryUploaded: true,
          lastSyncAt: new Date(now).toISOString(),
          lastError: "",
          retryAt: 0
        },
        history
      };
    } catch (error) {
      if (isAuthenticationError(error)) {
        return { state: reconnectState(current), history: local };
      }
      if (!(error instanceof TraktError) || error.status !== 429)
        throw error;
      return {
        state: { ...current, lastError: error.message, retryAt: error.retryAt },
        history: local
      };
    }
  }
  function isAuthenticationError(error) {
    return error instanceof TraktError && error.status === 401;
  }
  function isRefreshRejection(error) {
    return error instanceof TraktError && (error.status === 400 || error.status === 401);
  }
  function reconnectState(state) {
    return {
      ...state,
      tokens: null,
      reconnectRequired: true,
      lastError: "Trakt connection expired. Reconnect required.",
      retryAt: 0
    };
  }
  function parseTraktHistory(playback, watched) {
    const entries = [
      ...Array.isArray(playback) ? playback.flatMap((item) => parseRemote(item, false)) : [],
      ...Array.isArray(watched) ? watched.flatMap((item) => parseRemote(item, true)) : []
    ];
    return mergeWatchHistory([], entries);
  }
  function mergeWatchHistory(local, remote) {
    const entries = new Map;
    for (const entry of [...local, ...remote]) {
      const key = historyKey(entry);
      const existing = entries.get(key);
      entries.set(key, existing ? mergeEntry(existing, entry) : entry);
    }
    const unfinishedTitles = new Set;
    return [...entries.values()].sort((a, b) => timestamp(b.lastPlayedAt) - timestamp(a.lastPlayedAt)).filter((entry) => {
      if (entry.watched)
        return true;
      const id = historyTitleId(entry);
      if (unfinishedTitles.has(id))
        return false;
      unfinishedTitles.add(id);
      return true;
    }).slice(0, MAX_HISTORY_ITEMS2);
  }
  function parseRemote(value, watched) {
    const item = getRecord4(value);
    const playedAt = getString4(item?.[watched ? "watched_at" : "paused_at"]);
    if (!item || !playedAt)
      return [];
    const progress = watched ? 100 : clampProgress(item.progress);
    if (progress === null)
      return [];
    if (item.type === "movie") {
      const movie = getRecord4(item.movie);
      const imdbId2 = getString4(getRecord4(movie?.ids)?.imdb);
      const name = getString4(movie?.title);
      if (!imdbId2 || !name)
        return [];
      return [{
        id: imdbId2,
        media: remoteMedia(imdbId2, "movie", name, movie?.year),
        lastPlayedAt: playedAt,
        watched,
        progress
      }];
    }
    if (item.type !== "episode")
      return [];
    const show = getRecord4(item.show);
    const episode = getRecord4(item.episode);
    const imdbId = getString4(getRecord4(show?.ids)?.imdb);
    const showName = getString4(show?.title);
    const season = getFiniteNumber(episode?.season);
    const number = getFiniteNumber(episode?.number);
    if (!imdbId || !showName || season === null || number === null)
      return [];
    return [{
      id: `${imdbId}:${season}:${number}`,
      media: remoteMedia(imdbId, "series", showName, show?.year),
      episode: {
        id: `${imdbId}:${season}:${number}`,
        name: getString4(episode?.title) || `Episode ${season}x${number}`,
        season,
        episode: number,
        aired: getString4(episode?.first_aired),
        description: getString4(episode?.overview),
        thumbnail: ""
      },
      lastPlayedAt: playedAt,
      watched,
      progress
    }];
  }
  function mergeEntry(first, second) {
    const [older, newer] = timestamp(first.lastPlayedAt) > timestamp(second.lastPlayedAt) ? [second, first] : [first, second];
    return {
      ...newer,
      media: { ...newer.media, poster: older.media.poster || newer.media.poster },
      ...newer.episode || older.episode ? {
        episode: mergeEpisode(older.episode, newer.episode)
      } : {},
      watched: older.watched || newer.watched
    };
  }
  function mergeEpisode(older, newer) {
    if (!newer)
      return older;
    if (!older)
      return newer;
    return {
      ...newer,
      description: older.description || newer.description,
      thumbnail: older.thumbnail || newer.thumbnail
    };
  }
  async function request(transport, state, method, path, body, now) {
    const response = await transport(method, `${TRAKT_API}${path}`, body, apiHeaders(state));
    if (response.status >= 200 && response.status < 300)
      return response.data;
    throw responseError(response, now);
  }
  function responseError(response, now) {
    const retryAt = response.status === 429 ? now + (retryAfterMs(response.headers) ?? DEFAULT_RETRY_MS) : 0;
    return new TraktError(response.status, retryAt, response.status === 429 ? "Trakt rate limit exceeded." : `Trakt request failed with status ${response.status}.`);
  }
  function retryAfterMs(headers) {
    const value = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
    const seconds = Number(value);
    return value !== undefined && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }
  function parseTokens(value) {
    const item = getRecord4(value);
    const accessToken = getString4(item?.access_token);
    const refreshToken = getString4(item?.refresh_token);
    const createdAt = getNonNegativeNumberOrNull(item?.created_at);
    const expiresIn = getPositiveNumber2(item?.expires_in);
    if (!accessToken || !refreshToken || createdAt === null || !expiresIn) {
      throw new Error("Invalid Trakt token response.");
    }
    return {
      accessToken,
      refreshToken,
      expiresAt: (createdAt + expiresIn) * 1000
    };
  }
  function historyUploadPayload(entries) {
    const episodes = entries.filter((entry) => entry.episode);
    return {
      movies: entries.flatMap((entry) => entry.episode ? [] : [{
        watched_at: entry.lastPlayedAt,
        ids: { imdb: entry.media.imdbId }
      }]),
      episodes: [],
      ...episodes.length > 0 ? {
        shows: episodes.map((entry) => ({
          ids: { imdb: entry.media.imdbId },
          seasons: [{
            number: entry.episode.season,
            episodes: [{
              number: entry.episode.episode,
              watched_at: entry.lastPlayedAt
            }]
          }]
        }))
      } : {}
    };
  }
  function remoteMedia(imdbId, type, name, year) {
    return {
      id: imdbId,
      imdbId,
      type,
      name,
      releaseInfo: typeof year === "number" || typeof year === "string" ? String(year) : "",
      poster: ""
    };
  }
  function timestamp(value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function historyKey(entry) {
    return entry.episode ? `${historyTitleId(entry)}:${entry.episode.season}:${entry.episode.episode}` : historyTitleId(entry);
  }
  function parseJson(value) {
    if (typeof value !== "string")
      return value;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  function clampProgress(value) {
    const progress = getFiniteNumber(value);
    return progress === null ? null : Math.max(0, Math.min(100, progress));
  }
  function getRecord4(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  }
  function getString4(value) {
    return typeof value === "string" ? value : "";
  }
  function getFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  function getPositiveNumber2(value) {
    const number = getFiniteNumber(value);
    return number !== null && number > 0 ? number : null;
  }
  function getNonNegativeNumber(value) {
    const number = getFiniteNumber(value);
    return number !== null && number >= 0 ? number : 0;
  }
  function getNonNegativeNumberOrNull(value) {
    const number = getFiniteNumber(value);
    return number !== null && number >= 0 ? number : null;
  }
  // Info.json
  var Info_default = {
    name: "Popcorn for IINA",
    identifier: "xyz.brbc.popcorn",
    version: "2.6.0",
    ghRepo: "Justaway41/popcorn-iina",
    ghVersion: 17,
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
      preferredAudio: "",
      preferredSubtitle: "",
      watchHistory: [],
      episodeWatchState: { local: [], simkl: [], simklCours: [] },
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
  // src/shared/constants.ts
  var DEBUG_LOGS = false;

  // src/plugin/constants.ts
  var SHOW_SIDEBAR_DELAY_MS = 300;
  var SPLASH_URL_MARKER = "assets/Popcorn";
  var PLAYBACK_TICK_INTERVAL_MS = 1000;
  var PROGRESS_SAVE_INTERVAL_MS = 30000;
  var HISTORY_SYNC_INTERVAL_MS = 300000;
  var SLEEP_CAFFEINATE_TIMEOUT_SEC = 30;
  var SLEEP_REFRESH_INTERVAL_SEC = 20;
  var PLUGINS_DIR = "~/Library/Application Support/com.colliderli.iina/plugins";
  var POPCORN_SPLASH_CANDIDATES = [
    `${PLUGINS_DIR}/xyz.brbc.popcorn.iinaplugin/assets/Popcorn`,
    `${PLUGINS_DIR}/xyz.brbc.popcorn.iinaplugin-dev/assets/Popcorn`
  ];

  // src/plugin/playback.ts
  function shouldOfferNextEpisode(isReplacingPlayback, reachedNaturalEof) {
    return !isReplacingPlayback && reachedNaturalEof;
  }
  function isCurrentRequest(expectedRevision, currentRevision) {
    return expectedRevision === currentRevision;
  }
  function shouldSaveProgress(nowMs, lastSavedAtMs, intervalMs) {
    return nowMs - lastSavedAtMs >= intervalMs;
  }
  function shouldSendWatchedStop(progress, stopSent) {
    return !stopSent && Number.isFinite(progress) && progress >= 90;
  }
  function isPrefetchFresh(prefetchedAtMs, nowMs, maxAgeMs) {
    return Number.isFinite(prefetchedAtMs) && nowMs - prefetchedAtMs >= 0 && nowMs - prefetchedAtMs < maxAgeMs;
  }

  // src/plugin/utils.ts
  var { console } = iina;
  function getSplashUrl() {
    for (const candidate of POPCORN_SPLASH_CANDIDATES) {
      try {
        if (iina.file.exists(candidate))
          return candidate;
      } catch (error) {
        logDebug("Popcorn: Splash check failed:", error);
      }
    }
    return POPCORN_SPLASH_CANDIDATES[0];
  }
  function applySplashIcon() {
    const splashPath = getSplashUrl();
    const iconPath = splashPath.replace("/assets/Popcorn", "/ui/assets/popcorn-icon.png");
    const lines = [
      'use framework "AppKit"',
      `set iconPath to (current application's NSString's stringWithString:"${iconPath}")'s stringByExpandingTildeInPath()`,
      `set filePath to (current application's NSString's stringWithString:"${splashPath}")'s stringByExpandingTildeInPath()`,
      "set img to current application's NSImage's alloc()'s initWithContentsOfFile:iconPath",
      "current application's NSWorkspace's sharedWorkspace()'s setIcon:img forFile:filePath options:0"
    ];
    const args = ["-l", "AppleScript"];
    lines.forEach((line) => args.push("-e", line));
    iina.utils.exec("/usr/bin/osascript", args).catch((error) => logDebug("Popcorn: Icon setup failed:", error));
  }
  function isHttpUrl2(value) {
    const normalized = value.trim().toLowerCase();
    return normalized.startsWith("https://") || normalized.startsWith("http://");
  }
  function sanitizeMediaTitle(title) {
    return String(title).replace(/[\n\r,=]/g, " ");
  }
  function formatError(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function logDebug(...args) {
    if (DEBUG_LOGS)
      console.log(...args);
  }

  // src/plugin/sleep.ts
  var CAFFEINATE_PATH = "/usr/bin/caffeinate";
  var ticksSinceSpawn = 0;
  var active = false;
  function spawnCaffeinate() {
    const { utils } = iina;
    try {
      utils.exec(CAFFEINATE_PATH, ["-d", "-t", String(SLEEP_CAFFEINATE_TIMEOUT_SEC)]).then((result) => {
        if (result.status !== 0) {
          logDebug("Popcorn: caffeinate exited non-zero:", result.status, result.stderr);
        }
      }).catch((error) => {
        logDebug("Popcorn: caffeinate exec failed:", formatError(error));
      });
    } catch (error) {
      logDebug("Popcorn: caffeinate spawn failed:", formatError(error));
    }
  }
  function startKeepAwake() {
    active = true;
    ticksSinceSpawn = 0;
    spawnCaffeinate();
  }
  function keepAwakeTick(isPlaying) {
    if (!active || !isPlaying) {
      return;
    }
    ticksSinceSpawn += 1;
    if (ticksSinceSpawn >= SLEEP_REFRESH_INTERVAL_SEC) {
      ticksSinceSpawn = 0;
      spawnCaffeinate();
    }
  }
  function stopKeepAwake() {
    active = false;
    ticksSinceSpawn = 0;
  }

  // src/plugin/http.ts
  function safeJson(value) {
    if (typeof value !== "string")
      return value ?? null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  function createJsonClient(http) {
    const read = (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Request failed with HTTP ${response.statusCode}.`);
      }
      const data = safeJson(response.data ?? response.text);
      if (data === null)
        throw new Error("Response was not valid JSON.");
      return data;
    };
    return {
      async getJson(url) {
        return read(await http.get(url, {
          params: {},
          headers: { Accept: "application/json" },
          data: {}
        }));
      },
      async postJson(url, body) {
        return read(await http.post(url, {
          params: {},
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          data: body
        }));
      }
    };
  }

  // src/plugin/intro.ts
  var NEXT_EPISODE_TAIL_SEC = 60;
  var MIN_TAIL_DURATION_SEC = 300;
  var INTRO_CHAPTER = /^(?:intro|opening|avant)\b|^(?:nc)?op\s*\d*$/i;
  var CREDITS_CHAPTER = /^(?:ending|credits|outro|end\s*credits)\b|^(?:nc)?ed\s*\d*$/i;
  function findChapterIntro(chapters) {
    return findChapterInterval(chapters, INTRO_CHAPTER);
  }
  function findChapterCredits(chapters, duration) {
    return findChapterInterval(chapters, CREDITS_CHAPTER, Number.isFinite(duration) && duration > 0 ? duration : null);
  }
  function findChapterInterval(chapters, names, fallbackEnd = null) {
    const sorted = chapters.filter((chapter) => Number.isFinite(chapter.start)).sort((a, b) => a.start - b.start);
    const index = sorted.findIndex((chapter) => names.test(chapter.title.trim()));
    if (index === -1)
      return null;
    const next = sorted.slice(index + 1).find((chapter) => chapter.start > sorted[index].start);
    const end = next?.start ?? fallbackEnd;
    return end !== null && end > sorted[index].start ? { start: sorted[index].start, end } : null;
  }
  function parseKitsuMalId(value) {
    const data = record(value)?.data;
    if (!Array.isArray(data))
      return "";
    for (const entry of data) {
      const attributes = record(record(entry)?.attributes);
      if (attributes?.externalSite === "myanimelist/anime") {
        const id = stringValue(attributes.externalId);
        if (/^\d+$/.test(id))
          return id;
      }
    }
    return "";
  }
  var ANIME_SERIES_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
  var SEASON_SNAP_TOLERANCE = 2;
  var ANISKIP_LENGTH_TOLERANCE_SEC = 60;
  function normalizeTitle(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function parseAnimeEntry(node) {
    if (!node || !ANIME_SERIES_FORMATS.has(stringValue(node.format)))
      return null;
    const anilistId = node.id;
    const malId = node.idMal;
    if (typeof anilistId !== "number" || !Number.isInteger(anilistId) || anilistId <= 0)
      return null;
    if (typeof malId !== "number" || !Number.isInteger(malId) || malId <= 0)
      return null;
    const episodes = numberValue(node.episodes);
    return { anilistId, malId: String(malId), episodes: episodes !== null && episodes > 0 ? episodes : null };
  }
  function startOrder(node) {
    const date = record(node?.startDate);
    return (numberValue(date?.year) ?? 9999) * 12 + (numberValue(date?.month) ?? 0);
  }
  function parseAniListRoot(value, name) {
    const wanted = normalizeTitle(name);
    const media = record(record(record(value)?.data)?.Page)?.media;
    if (!wanted || !Array.isArray(media))
      return null;
    let best = null;
    for (const item of media) {
      const node = record(item);
      const entry = parseAnimeEntry(node);
      if (!node || !entry)
        continue;
      const title = record(node.title);
      const synonyms = Array.isArray(node.synonyms) ? node.synonyms : [];
      const names = [title?.english, title?.romaji, ...synonyms].map((candidate) => normalizeTitle(stringValue(candidate))).filter(Boolean);
      const exact = names.includes(wanted);
      const leading = exact || names.some((candidate) => wanted.startsWith(`${candidate} `) || candidate.startsWith(`${wanted} `));
      if (!leading)
        continue;
      const order = startOrder(node);
      if (!best || exact && !best.exact || exact === best.exact && order < best.order) {
        best = { entry, exact, order };
      }
    }
    return best?.entry ?? null;
  }
  function parseAniListSequel(value) {
    const edges = record(record(record(record(value)?.data)?.Media)?.relations)?.edges;
    if (!Array.isArray(edges))
      return null;
    let best = null;
    for (const item of edges) {
      const edge = record(item);
      if (edge?.relationType !== "SEQUEL")
        continue;
      const node = record(edge.node);
      const entry = parseAnimeEntry(node);
      if (!entry)
        continue;
      const order = startOrder(node);
      if (!best || order < best.order)
        best = { entry, order };
    }
    return best?.entry ?? null;
  }
  function seasonEpisodeCounts(episodes) {
    const counts = new Map;
    for (const episode of episodes) {
      if (episode.season > 0)
        counts.set(episode.season, (counts.get(episode.season) ?? 0) + 1);
    }
    return [...counts.entries()].map(([season, count]) => ({ season, count })).sort((a, b) => a.season - b.season);
  }
  function mapAnimeEpisode(seasons, chain, season, episode) {
    for (const segment of courSegments(seasons, chain)) {
      if (segment.season !== season)
        continue;
      if (episode <= segment.seasonStart || episode > segment.seasonStart + segment.count)
        continue;
      return { malId: segment.malId, episode: segment.courStart + episode - segment.seasonStart };
    }
    return null;
  }
  function mapCourEpisode(seasons, chain, malId, episode) {
    for (const segment of courSegments(seasons, chain)) {
      if (segment.malId !== malId)
        continue;
      if (episode <= segment.courStart || episode > segment.courStart + segment.count)
        continue;
      return { season: segment.season, episode: segment.seasonStart + episode - segment.courStart };
    }
    return null;
  }
  function courSegments(seasons, chain) {
    const segments = [];
    let index = 0;
    let used = 0;
    for (const current of seasons) {
      let filled = 0;
      while (filled < current.count && index < chain.length) {
        const entry = chain[index];
        const total = entry.episodes ?? Number.POSITIVE_INFINITY;
        const snap = used === 0 && filled === 0 && Number.isFinite(total) && Math.abs(total - current.count) <= SEASON_SNAP_TOLERANCE;
        const take = snap ? current.count : Math.min(total - used, current.count - filled);
        if (take <= 0) {
          index += 1;
          used = 0;
          continue;
        }
        segments.push({
          season: current.season,
          malId: entry.malId,
          seasonStart: filled,
          courStart: used,
          count: take
        });
        filled += take;
        used += take;
        if (snap || used >= total) {
          index += 1;
          used = 0;
        }
      }
    }
    return segments;
  }
  function parseAniSkipInterval(value, skipType = "op", duration = 0) {
    const response = record(value);
    if (response?.found !== true || !Array.isArray(response.results))
      return null;
    let best = null;
    for (const result of response.results) {
      const item = record(result);
      if (item?.skipType !== skipType)
        continue;
      const interval = record(item.interval);
      const start = numberValue(interval?.startTime);
      const end = numberValue(interval?.endTime);
      if (start === null || end === null || start < 0 || start >= end)
        continue;
      const length = numberValue(item.episodeLength);
      const distance = duration > 0 && length !== null ? Math.abs(length - duration) : 0;
      if (distance > ANISKIP_LENGTH_TOLERANCE_SEC)
        continue;
      if (!best || distance < best.distance)
        best = { interval: { start, end }, distance };
    }
    return best?.interval ?? null;
  }
  function parseIntroDbSegment(value, type) {
    const segment = record(record(value)?.[type]);
    const start = numberValue(segment?.start_sec);
    const end = numberValue(segment?.end_sec);
    return start !== null && end !== null && start >= 0 && start < end ? { start, end } : null;
  }
  function isInsideIntro(time, interval) {
    return Boolean(interval && Number.isFinite(time) && time >= interval.start && time < interval.end);
  }
  function isInsideTail(time, duration) {
    if (!Number.isFinite(time) || !Number.isFinite(duration))
      return false;
    if (duration < MIN_TAIL_DURATION_SEC)
      return false;
    return time >= duration - NEXT_EPISODE_TAIL_SEC;
  }
  function getOverlayAction(time, segments, nextReady, duration = 0) {
    if (isInsideIntro(time, segments.recap))
      return "recap";
    if (isInsideIntro(time, segments.intro))
      return "intro";
    const credits = segments.credits;
    if (credits && isInsideIntro(time, credits)) {
      if (!endsEpisode(credits, duration)) {
        return credits.end - credits.start <= MAX_SKIP_SEGMENT_SEC ? "credits" : null;
      }
      return nextReady ? "next" : null;
    }
    return nextReady && isInsideTail(time, duration) ? "next" : null;
  }
  function endsEpisode(credits, duration) {
    if (!Number.isFinite(duration) || duration <= 0)
      return true;
    return credits.end > duration - NEXT_EPISODE_TAIL_SEC;
  }
  function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  }
  function stringValue(value) {
    return typeof value === "string" ? value.trim() : "";
  }
  function numberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  var MAX_SKIP_SEGMENT_SEC = 300;
  function sanitizeSegments(found, duration) {
    const known = Number.isFinite(duration) && duration > 0;
    const inFile = (interval) => interval && (!known || interval.end <= duration) ? interval : null;
    const skippable = (interval) => {
      const inside = inFile(interval);
      if (!inside || inside.end - inside.start > MAX_SKIP_SEGMENT_SEC)
        return null;
      return !known || inside.end <= duration - NEXT_EPISODE_TAIL_SEC ? inside : null;
    };
    return { intro: skippable(found.intro), recap: skippable(found.recap), credits: inFile(found.credits) };
  }

  // src/plugin/anime.ts
  var ANILIST_URL = "https://graphql.anilist.co";
  var ANILIST_ROOT_QUERY = "query ($search: String) { Page(perPage: 25) { media(search: $search, " + "type: ANIME, sort: SEARCH_MATCH) { id idMal format episodes startDate { year month } " + "synonyms title { romaji english } } } }";
  var ANILIST_SEQUEL_QUERY = "query ($id: Int) { Media(id: $id) { relations { edges { relationType " + "node { id idMal format episodes startDate { year month } } } } } }";
  var MAX_SEQUEL_HOPS = 12;
  var MAX_CHAIN_LOOKUPS_PER_PASS = 6;
  function showCandidate(media) {
    return { imdbId: media.imdbId, name: media.name, preview: media };
  }
  function courCandidate(cour) {
    return {
      imdbId: cour.imdbId,
      name: cour.name,
      preview: {
        id: cour.imdbId,
        imdbId: cour.imdbId,
        type: "series",
        name: cour.name,
        releaseInfo: cour.year,
        poster: ""
      }
    };
  }
  function isLater(candidate, current) {
    if (!current)
      return true;
    return candidate.season !== current.season ? candidate.season > current.season : candidate.episode > current.episode;
  }
  function buildEntry(details, at, playedAt, watched, progress) {
    const id = `${details.media.imdbId}:${at.season}:${at.episode}`;
    const known = details.episodes.find((episode) => episode.season === at.season && episode.episode === at.episode);
    return {
      id,
      media: details.media,
      episode: known ?? {
        id,
        name: `Episode ${at.season}x${at.episode}`,
        season: at.season,
        episode: at.episode,
        aired: "",
        description: "",
        thumbnail: ""
      },
      lastPlayedAt: playedAt,
      watched,
      progress
    };
  }
  function createAnimeChainClient(http) {
    const json = createJsonClient(http);
    const chains = new Map;
    const kitsuMalIds = new Map;
    const series = new Map;
    async function loadChain(name) {
      if (chains.has(name))
        return chains.get(name) ?? null;
      const root = parseAniListRoot(await json.postJson(ANILIST_URL, {
        query: ANILIST_ROOT_QUERY,
        variables: { search: name }
      }), name);
      if (!root) {
        chains.set(name, null);
        return null;
      }
      const chain = [root];
      for (let hop = 0;hop < MAX_SEQUEL_HOPS; hop += 1) {
        const next = parseAniListSequel(await json.postJson(ANILIST_URL, {
          query: ANILIST_SEQUEL_QUERY,
          variables: { id: chain[chain.length - 1].anilistId }
        }));
        if (!next || chain.some((entry) => entry.anilistId === next.anilistId))
          break;
        chain.push(next);
      }
      chains.set(name, chain);
      return chain;
    }
    async function loadKitsuMalId(providerId) {
      const kitsuId = providerId.match(/^kitsu:(\d+)$/i)?.[1] || "";
      if (!kitsuId)
        return "";
      const cached = kitsuMalIds.get(kitsuId);
      if (cached !== undefined)
        return cached;
      const response = await http.get(`https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}/mappings`, { params: {}, headers: { Accept: "application/vnd.api+json" }, data: {} });
      if (response.statusCode < 200 || response.statusCode >= 300)
        return "";
      const malId = parseKitsuMalId(response.data ?? safeJson(response.text));
      kitsuMalIds.set(kitsuId, malId);
      return malId;
    }
    async function loadSeries(candidate) {
      const cached = series.get(candidate.imdbId);
      if (cached !== undefined)
        return cached;
      const parsed = parseMediaMetadata(await json.getJson(buildCinemetaSeriesUrl(candidate.imdbId)), { manifestUrl: "" }, candidate.preview);
      const seasons = seasonEpisodeCounts(parsed.episodes);
      const details = seasons.length > 0 ? { media: parsed.media, episodes: parsed.episodes, seasons } : null;
      series.set(candidate.imdbId, details);
      return details;
    }
    async function indexCandidates(cours, history) {
      const named = new Set(cours.map((cour) => cour.imdbId).filter((id) => id));
      const known = history.flatMap((entry) => entry.media.type === "series" ? [showCandidate(entry.media)] : []);
      const candidates = [
        ...known.filter((candidate) => named.has(candidate.imdbId)),
        ...known.filter((candidate) => !named.has(candidate.imdbId)),
        ...cours.flatMap((cour) => cour.imdbId ? [courCandidate(cour)] : [])
      ];
      const wanted = new Set(cours.map((cour) => cour.malId));
      const owners = new Map;
      const seen = new Set;
      let lookups = 0;
      for (const candidate of candidates) {
        if (wanted.size === 0)
          break;
        if (!isImdbId(candidate.imdbId) || seen.has(candidate.imdbId))
          continue;
        seen.add(candidate.imdbId);
        if (!chains.has(candidate.name)) {
          if (lookups >= MAX_CHAIN_LOOKUPS_PER_PASS)
            continue;
          lookups += 1;
        }
        try {
          const chain = await loadChain(candidate.name);
          if (!chain)
            continue;
          for (const cour of chain) {
            if (!wanted.has(cour.malId) || owners.has(cour.malId))
              continue;
            owners.set(cour.malId, candidate);
            wanted.delete(cour.malId);
          }
        } catch (error) {
          logDebug("Popcorn: Anime chain lookup failed:", formatError(error));
        }
      }
      return owners;
    }
    return {
      async resolveEpisode(context, episode) {
        const providerId = context.media.providerId || context.media.id || "";
        const known = context.media.malId || (providerId.startsWith("kitsu:") ? await loadKitsuMalId(providerId) : "");
        if (known)
          return { malId: known, episode: episode.episode };
        const chain = await loadChain(context.media.name);
        if (!chain)
          return null;
        return mapAnimeEpisode(seasonEpisodeCounts(context.episodes), chain, episode.season, episode.episode);
      },
      async placeWatchedCours(cours, history) {
        const placed = { patches: [], entries: [] };
        if (cours.length === 0)
          return placed;
        const owners = await indexCandidates(cours, history);
        const shows = new Map;
        for (const cour of cours) {
          try {
            const owner = owners.get(cour.malId);
            let candidate = owner ?? null;
            let details = owner ? await loadSeries(owner) : null;
            let chain = owner && details ? await loadChain(owner.name) : null;
            if (!details && cour.ownsImdb && isImdbId(cour.imdbId)) {
              candidate = courCandidate(cour);
              details = await loadSeries(candidate) ?? { media: candidate.preview, episodes: [], seasons: [] };
              chain = null;
            }
            if (!candidate || !details)
              continue;
            const show = shows.get(candidate.imdbId) ?? { details, episodes: new Set };
            shows.set(candidate.imdbId, show);
            const place = (number) => {
              const at = chain ? mapCourEpisode(details.seasons, chain, cour.malId, number) : null;
              if (at || chain)
                return at;
              const first = details.seasons[0];
              if (!first)
                return { season: 1, episode: number };
              return number <= first.count ? { season: first.season, episode: number } : null;
            };
            for (const number of cour.episodes) {
              const at = place(number);
              if (!at)
                continue;
              show.episodes.add(`${at.season}:${at.episode}`);
              if (isLater(at, show.watched?.at)) {
                show.watched = { at, playedAt: cour.lastWatchedAt };
              }
            }
            const session = cour.paused;
            const pausedAt = session ? place(session.episode) : null;
            if (session && pausedAt && isLater(pausedAt, show.paused?.at)) {
              show.paused = { at: pausedAt, playedAt: session.at, progress: session.progress };
            }
          } catch (error) {
            logDebug("Popcorn: Anime cour placement failed:", formatError(error));
          }
        }
        for (const [imdbId, show] of shows) {
          if (show.episodes.size > 0) {
            placed.patches.push({ id: imdbId, episodes: [...show.episodes] });
          }
          if (show.watched) {
            placed.entries.push(buildEntry(show.details, show.watched.at, show.watched.playedAt, true, 100));
          }
          if (show.paused) {
            placed.entries.push(buildEntry(show.details, show.paused.at, show.paused.playedAt, false, show.paused.progress));
          }
        }
        return placed;
      }
    };
  }

  // src/shared/simkl.ts
  class SimklError extends Error {
    status;
    retryAt;
    constructor(status, retryAt = 0, message = `Simkl request failed with status ${status}.`) {
      super(message);
      this.status = status;
      this.retryAt = retryAt;
      this.name = "SimklError";
    }
  }
  var SIMKL_API = "https://api.simkl.com";
  var DEFAULT_RETRY_MS2 = 60000;
  function parseSimklState(value) {
    const item = getRecord4(parseJson(value));
    return {
      clientId: getString4(item?.clientId),
      accessToken: getString4(item?.accessToken),
      lastError: getString4(item?.lastError),
      retryAt: getNonNegativeNumber(item?.retryAt),
      lastActivityAt: getString4(item?.lastActivityAt),
      lastSyncAt: getString4(item?.lastSyncAt)
    };
  }
  function isSimklConnected(state) {
    return state.clientId !== "" && state.accessToken !== "";
  }
  function buildSimklScrobblePayload(context, progress, cour) {
    if (!cour)
      return buildScrobblePayload(context, progress);
    return {
      progress: Math.max(0, Math.min(100, progress)),
      anime: { ids: { mal: cour.malId } },
      episode: { season: 1, number: cour.episode }
    };
  }
  async function simklScrobble(transport, state, action, context, progress, cour = null, now = Date.now()) {
    if (!isSimklConnected(state))
      return state;
    if (!isImdbId(context.media.imdbId))
      return state;
    if (state.retryAt > now)
      return state;
    try {
      await request2(transport, state, "POST", `/scrobble/${action}`, buildSimklScrobblePayload(context, progress, cour), now);
      return { ...state, lastError: "", retryAt: 0 };
    } catch (error) {
      if (error instanceof SimklError && error.status === 401) {
        return {
          ...state,
          accessToken: "",
          lastError: "Simkl connection was rejected. Reconnect required.",
          retryAt: 0
        };
      }
      return {
        ...state,
        lastError: error instanceof Error ? error.message : "Simkl request failed.",
        retryAt: error instanceof SimklError ? error.retryAt : 0
      };
    }
  }
  async function syncSimklHistory(transport, state, local, now = Date.now()) {
    if (!isSimklConnected(state) || state.retryAt > now) {
      return { state, history: local, watchedPatches: [], watchedCours: [] };
    }
    try {
      const activities = getRecord4(await request2(transport, state, "GET", "/sync/activities", null, now));
      const activityAt = getString4(activities?.all);
      if (activityAt && activityAt === state.lastActivityAt) {
        return {
          state: { ...state, lastSyncAt: new Date(now).toISOString(), lastError: "", retryAt: 0 },
          history: local,
          watchedPatches: [],
          watchedCours: []
        };
      }
      const cursor = state.lastActivityAt ? `?date_from=${encodeURIComponent(state.lastActivityAt)}` : "";
      const query = [
        "extended=full_anime_seasons",
        "episode_watched_at=yes",
        "include_all_episodes=yes",
        ...state.lastActivityAt ? [`date_from=${encodeURIComponent(state.lastActivityAt)}`] : []
      ].join("&");
      const items = await request2(transport, state, "GET", `/sync/all-items/?${query}`, null, now);
      const playback = await request2(transport, state, "GET", `/sync/playback${cursor}`, null, now);
      const watchedCours = parseSimklWatchedCours(items, playback);
      await markCourOwnership(transport, state, watchedCours, now);
      return {
        state: {
          ...state,
          lastActivityAt: activityAt || state.lastActivityAt,
          lastSyncAt: new Date(now).toISOString(),
          lastError: "",
          retryAt: 0
        },
        history: mergeWatchHistory(local, parseSimklHistory(items, playback)),
        watchedPatches: parseSimklWatchedPatches(items),
        watchedCours
      };
    } catch (error) {
      if (error instanceof SimklError && error.status === 401) {
        return {
          state: {
            ...state,
            accessToken: "",
            lastError: "Simkl connection was rejected. Reconnect required.",
            retryAt: 0
          },
          history: local,
          watchedPatches: [],
          watchedCours: []
        };
      }
      return {
        state: {
          ...state,
          lastError: error instanceof Error ? error.message : "Simkl request failed.",
          retryAt: error instanceof SimklError ? error.retryAt : 0
        },
        history: local,
        watchedPatches: [],
        watchedCours: []
      };
    }
  }
  function parseSimklWatchedPatches(items) {
    return watchedShowPatches(getRecord4(items)?.shows);
  }
  async function markCourOwnership(transport, state, cours, now) {
    const byImdb = new Map;
    for (const cour of cours) {
      if (!isImdbId(cour.imdbId))
        continue;
      const group = byImdb.get(cour.imdbId) ?? [];
      group.push(cour);
      byImdb.set(cour.imdbId, group);
    }
    for (const [imdbId, group] of byImdb) {
      try {
        const found = await request2(transport, state, "GET", `/search/id?imdb=${encodeURIComponent(imdbId)}&type=anime`, null, now);
        const first = Array.isArray(found) ? getRecord4(found[0]) : null;
        const simklId = String(getRecord4(first?.ids)?.simkl ?? "");
        if (!simklId)
          continue;
        for (const cour of group) {
          if (cour.simklId)
            cour.ownsImdb = cour.simklId === simklId;
        }
      } catch {}
    }
  }
  function parseSimklWatchedCours(items, playback) {
    const list = getRecord4(items)?.anime;
    const paused = parsePausedCours(playback);
    const cours = new Map;
    for (const value of Array.isArray(list) ? list : []) {
      const item = getRecord4(value);
      const show = getRecord4(item?.show);
      const malId = getString4(getRecord4(show?.ids)?.mal);
      const seasons = item?.seasons;
      if (!malId || !Array.isArray(seasons))
        continue;
      const episodes = [...new Set(seasons.flatMap(courEpisodeNumbers))];
      if (episodes.length === 0)
        continue;
      cours.set(malId, {
        malId,
        imdbId: getString4(getRecord4(show?.ids)?.imdb),
        name: getString4(show?.title),
        year: String(show?.year ?? ""),
        ownsImdb: true,
        simklId: String(getRecord4(show?.ids)?.simkl ?? ""),
        episodes,
        lastWatchedAt: getString4(item?.last_watched_at)
      });
    }
    for (const [malId, session] of paused) {
      const existing = cours.get(malId);
      if (existing) {
        existing.paused = session.paused;
        continue;
      }
      cours.set(malId, session);
    }
    return [...cours.values()];
  }
  function parsePausedCours(playback) {
    const sessions = new Map;
    for (const value of Array.isArray(playback) ? playback : []) {
      const item = getRecord4(value);
      const show = getRecord4(item?.anime);
      const episode = getRecord4(item?.episode);
      const malId = getString4(getRecord4(show?.ids)?.mal);
      const number = episodeNumber(getFiniteNumber(episode?.number) ?? -1);
      const progress = clampProgress(item?.progress);
      if (!malId || number === null || number === 0 || progress === null)
        continue;
      sessions.set(malId, {
        malId,
        imdbId: getString4(getRecord4(show?.ids)?.imdb),
        name: getString4(show?.title),
        year: String(show?.year ?? ""),
        ownsImdb: true,
        simklId: String(getRecord4(show?.ids)?.simkl ?? ""),
        episodes: [],
        lastWatchedAt: "",
        paused: { episode: number, at: getString4(item?.paused_at), progress }
      });
    }
    return sessions;
  }
  function courEpisodeNumbers(value) {
    const season = getRecord4(value);
    if (!Array.isArray(season?.episodes))
      return [];
    return season.episodes.flatMap((value2) => {
      const episode = getRecord4(value2);
      if (!episode || !getString4(episode.watched_at))
        return [];
      const number = episodeNumber(episode.number);
      return number === null || number === 0 ? [] : [number];
    });
  }
  function watchedShowPatches(value) {
    if (!Array.isArray(value))
      return [];
    return value.flatMap((value2) => {
      const item = getRecord4(value2);
      const imdbId = getString4(getRecord4(getRecord4(item?.show)?.ids)?.imdb);
      const list = item?.seasons;
      if (!isImdbId(imdbId) || !Array.isArray(list))
        return [];
      if (list.length === 0)
        return [{ id: imdbId, episodes: [] }];
      const episodes = list.flatMap(parseWatchedSeason);
      if (episodes.length === 0)
        return [];
      return [{ id: imdbId, episodes: [...new Set(episodes)] }];
    });
  }
  function parseWatchedSeason(value) {
    const season = getRecord4(value);
    const seasonNumber = episodeNumber(season?.number);
    if (!Array.isArray(season?.episodes) || seasonNumber === null)
      return [];
    return season.episodes.flatMap((value2) => {
      const episode = getRecord4(value2);
      if (!episode || !getString4(episode.watched_at))
        return [];
      const number = episodeNumber(episode.number);
      return number === null ? [] : [`${seasonNumber}:${number}`];
    });
  }
  function episodeNumber(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
  }
  function parseSimklHistory(items, playback) {
    const lists = getRecord4(items);
    const entries = [
      ...listEntries(lists?.shows),
      ...listEntries(lists?.movies),
      ...Array.isArray(playback) ? playback.flatMap(parsePlayback) : []
    ];
    return mergeWatchHistory([], entries);
  }
  function listEntries(value) {
    return Array.isArray(value) ? value.flatMap(parseListItem) : [];
  }
  function parseListItem(value) {
    const item = getRecord4(value);
    const playedAt = getString4(item?.last_watched_at);
    if (!item || !playedAt)
      return [];
    const movie = getRecord4(item.movie);
    if (movie) {
      const imdbId2 = getString4(getRecord4(movie.ids)?.imdb);
      const name2 = getString4(movie.title);
      if (!isImdbId(imdbId2) || !name2)
        return [];
      return [{
        id: imdbId2,
        media: remoteMedia(imdbId2, "movie", name2, movie.year),
        lastPlayedAt: playedAt,
        watched: true,
        progress: 100
      }];
    }
    const show = getRecord4(item.show);
    const imdbId = getString4(getRecord4(show?.ids)?.imdb);
    const name = getString4(show?.title);
    const position = parseLastWatched(item.last_watched);
    if (!isImdbId(imdbId) || !name || !position)
      return [];
    return [seriesEntry(imdbId, name, show?.year, position, "", playedAt, true, 100)];
  }
  function parseLastWatched(value) {
    const match = /^(?:S(\d+))?E(\d+)$/i.exec(getString4(value).trim());
    if (!match)
      return null;
    return { season: match[1] ? Number(match[1]) : 1, episode: Number(match[2]) };
  }
  function parsePlayback(value) {
    const item = getRecord4(value);
    const playedAt = getString4(item?.paused_at);
    const progress = clampProgress(item?.progress);
    if (!item || !playedAt || progress === null)
      return [];
    const movie = getRecord4(item.movie);
    if (movie) {
      const imdbId2 = getString4(getRecord4(movie.ids)?.imdb);
      const name2 = getString4(movie.title);
      if (!isImdbId(imdbId2) || !name2)
        return [];
      return [{
        id: imdbId2,
        media: remoteMedia(imdbId2, "movie", name2, movie.year),
        lastPlayedAt: playedAt,
        watched: false,
        progress
      }];
    }
    const show = getRecord4(item.show);
    const episode = getRecord4(item.episode);
    const imdbId = getString4(getRecord4(show?.ids)?.imdb);
    const name = getString4(show?.title);
    const season = getFiniteNumber(episode?.season);
    const number = getFiniteNumber(episode?.number) ?? getFiniteNumber(episode?.episode);
    if (!isImdbId(imdbId) || !name || season === null || number === null)
      return [];
    return [seriesEntry(imdbId, name, show?.year, { season, episode: number }, getString4(episode?.title), playedAt, false, progress)];
  }
  function seriesEntry(imdbId, name, year, position, episodeName, playedAt, watched, progress) {
    const id = `${imdbId}:${position.season}:${position.episode}`;
    return {
      id,
      media: remoteMedia(imdbId, "series", name, year),
      episode: {
        id,
        name: episodeName || `Episode ${position.season}x${position.episode}`,
        season: position.season,
        episode: position.episode,
        aired: "",
        description: "",
        thumbnail: ""
      },
      lastPlayedAt: playedAt,
      watched,
      progress
    };
  }
  function apiHeaders2(state) {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "simkl-api-key": state.clientId,
      ...state.accessToken ? { Authorization: `Bearer ${state.accessToken}` } : {}
    };
  }
  async function request2(transport, state, method, path, body, now) {
    const response = await transport(method, `${SIMKL_API}${path}`, body, apiHeaders2(state)).catch((error) => {
      throw transportError(error);
    });
    if (response.status >= 200 && response.status < 300)
      return response.data;
    throw responseError2(response, now);
  }
  function transportError(error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S*/gi, "").replace(/\s+/g, " ").trim();
    return new Error(reason ? `Simkl request failed: ${reason}` : "Simkl request failed.");
  }
  function responseError2(response, now) {
    const retryAt = response.status === 429 ? now + (retryAfterMs2(response.headers) ?? DEFAULT_RETRY_MS2) : 0;
    return new SimklError(response.status, retryAt, response.status === 429 ? "Simkl rate limit exceeded." : `Simkl request failed with status ${response.status}.`);
  }
  function retryAfterMs2(headers) {
    const value = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
    const seconds = Number(value);
    return value !== undefined && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }

  // src/plugin/trakt.ts
  function createIinaTransport(http) {
    return async (method, url, body, headers) => {
      const options = { params: {}, headers, data: body };
      const response = method === "GET" ? await http.get(url, options) : await http.post(url, options);
      return {
        status: response.statusCode,
        data: response.data ?? safeJson2(response.text),
        headers: {}
      };
    };
  }
  function safeJson2(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  function createIinaTraktClient(http, preferences, onError) {
    const transport = createIinaTransport(http);
    const read = () => parseTraktState(preferences.get("trakt"));
    const save = (state) => {
      preferences.set("trakt", state);
      preferences.sync();
    };
    const saveIfCurrent = (input, output) => {
      if (sameConnection(read(), input))
        save(output);
    };
    let pending = Promise.resolve();
    const enqueue = (operation) => {
      const result = pending.then(operation);
      pending = result.then(() => {}, () => {});
      return result;
    };
    return {
      sendPlayback(action, context, progress) {
        return enqueue(async () => {
          const state = read();
          if (!state.tokens)
            return;
          try {
            saveIfCurrent(state, await scrobble(transport, state, action, context, progress));
          } catch (error) {
            onError(error);
          }
        });
      },
      sync(history) {
        return enqueue(async () => {
          const state = read();
          if (!state.tokens)
            return history;
          try {
            const result = await syncTraktHistory(transport, state, history);
            saveIfCurrent(state, result.state);
            return result.history;
          } catch (error) {
            onError(error);
            return history;
          }
        });
      }
    };
  }
  function sameConnection(current, input) {
    return current.clientId === input.clientId && current.clientSecret === input.clientSecret && current.tokens?.accessToken === input.tokens?.accessToken && current.tokens?.refreshToken === input.tokens?.refreshToken && current.tokens?.expiresAt === input.tokens?.expiresAt;
  }

  // src/plugin/simkl.ts
  function createIinaSimklClient(http, preferences, onError) {
    const transport = createIinaTransport(http);
    const read = () => parseSimklState(preferences.get("simkl"));
    const saveIfCurrent = (input, output) => {
      if (!sameConnection2(read(), input))
        return false;
      preferences.set("simkl", output);
      preferences.sync();
      return true;
    };
    let pending = Promise.resolve();
    const enqueue = (operation) => {
      const result = pending.then(operation);
      pending = result.then(() => {}, () => {});
      return result;
    };
    return {
      sendPlayback(action, context, progress, cour) {
        return enqueue(async () => {
          const state = read();
          if (!state.accessToken)
            return;
          try {
            saveIfCurrent(state, await simklScrobble(transport, state, action, context, progress, cour));
          } catch (error) {
            onError(error);
          }
        });
      },
      sync(history) {
        return enqueue(async () => {
          const state = read();
          const empty = { history, watchedPatches: [], watchedCours: [] };
          if (!state.accessToken)
            return empty;
          try {
            const result = await syncSimklHistory(transport, state, history);
            if (!saveIfCurrent(state, result.state))
              return empty;
            return {
              history: result.history,
              watchedPatches: result.watchedPatches,
              watchedCours: result.watchedCours
            };
          } catch (error) {
            onError(error);
            return empty;
          }
        });
      }
    };
  }
  function sameConnection2(current, input) {
    return current.clientId === input.clientId && current.accessToken === input.accessToken;
  }

  // src/plugin/preferences.ts
  function migrateStructuredPreferences(preferences) {
    const storedAddons = preferences.get("addons");
    const addons = parseAddons(storedAddons, preferences.get("addonManifestUrl"));
    let changed = false;
    if (typeof storedAddons === "string" || addons.length > parseAddons(storedAddons).length) {
      preferences.set("addons", addons);
      changed = true;
    }
    const watchHistory = preferences.get("watchHistory");
    if (typeof watchHistory === "string") {
      preferences.set("watchHistory", parseWatchHistory(watchHistory));
      changed = true;
    }
    const trakt = preferences.get("trakt");
    if (typeof trakt === "string") {
      preferences.set("trakt", parseTraktState(trakt));
      changed = true;
    }
    if (changed)
      preferences.sync();
  }
  function parseLanguagePreference(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  // src/plugin/main.ts
  var { core, event, global, http, mpv, overlay, preferences, sidebar, utils } = iina;
  var json = createJsonClient(http);
  var anime = createAnimeChainClient(http);
  var trakt = createIinaTraktClient(http, preferences, (error) => {
    logDebug("Popcorn: Trakt request failed:", formatError(error));
  });
  var simkl = createIinaSimklClient(http, preferences, (error) => {
    logDebug("Popcorn: Simkl request failed:", formatError(error));
  });
  var windowReady = false;
  var pendingShowSidebar = false;
  var sidebarVisible = false;
  var lastPlaybackTickAt = 0;
  var savedImageDisplayDuration = null;
  var savedPositionOnQuitFlag = null;
  var activePlaybackContext = null;
  var pendingResumePercent = null;
  var lastProgressSavedAt = 0;
  var isReplacingPlayback = false;
  var reachedNaturalEof = false;
  var scrobbleStopSent = false;
  var activeStreamUrl = "";
  var activeStreamRelease = "";
  var lastHistorySyncAt = 0;
  var historySyncInFlight = false;
  var watchHistory = parseWatchHistory(preferences.get("watchHistory"));
  var episodeWatchState = parseEpisodeWatchState(preferences.get("episodeWatchState"), watchHistory);
  var introInterval = null;
  var recapInterval = null;
  var creditsInterval = null;
  var playbackRevision = 0;
  var activeCour = Promise.resolve(null);
  var overlayAction = null;
  var overlayVisible = false;
  var overlayLabel = "";
  var overlayHandlerRegistered = false;
  var prefetchedNextEpisode = null;
  var prefetchedNextEpisodeAt = 0;
  var PREFETCH_FRESH_MS = 30 * 60000;
  var addonManifests = new Map;
  function setPlayerUIHidden(hidden) {
    const api = core;
    api.setUIVisibility?.(hidden);
  }
  function showSidebar() {
    sidebar.show();
    sidebarVisible = true;
  }
  function showSidebarWithDelay() {
    setTimeout(showSidebar, SHOW_SIDEBAR_DELAY_MS);
  }
  function hideSidebar() {
    sidebar.hide();
    sidebarVisible = false;
  }
  function isSidebarVisible() {
    const api = sidebar;
    if (api.isVisible)
      return api.isVisible();
    try {
      const current = core.window.sidebar;
      if (current !== undefined)
        return typeof current === "string" && current.includes("popcorn");
    } catch (error) {
      logDebug("Popcorn: Could not read sidebar state:", formatError(error));
    }
    return sidebarVisible;
  }
  function toggleSidebar() {
    if (!windowReady)
      pendingShowSidebar = true;
    else if (isSidebarVisible())
      hideSidebar();
    else
      showSidebarWithDelay();
  }
  function setWindowTitle(title) {
    const safeTitle = sanitizeMediaTitle(title);
    const api = mpv;
    if (api.setString)
      api.setString("force-media-title", safeTitle);
    else
      mpv.set("force-media-title", safeTitle);
  }
  function startPlaybackMonitoring() {
    stopPlaybackMonitoring();
    lastPlaybackTickAt = 0;
    startKeepAwake();
  }
  function updatePlaybackMonitoring() {
    const now = Date.now();
    if (now - lastPlaybackTickAt < PLAYBACK_TICK_INTERVAL_MS)
      return;
    lastPlaybackTickAt = now;
    const playing = !mpv.getFlag("pause");
    keepAwakeTick(playing);
    const percent = mpv.getNumber("percent-pos");
    if (playing && shouldSendWatchedStop(percent, scrobbleStopSent)) {
      sendScrobble("stop", percent);
    }
    if (playing && shouldSaveProgress(now, lastProgressSavedAt, PROGRESS_SAVE_INTERVAL_MS)) {
      savePlaybackProgress();
    }
  }
  function savePlaybackProgress(percent = mpv.getNumber("percent-pos")) {
    const context = activePlaybackContext;
    if (!context || !Number.isFinite(percent))
      return;
    const storedHistory = parseWatchHistory(preferences.get("watchHistory"));
    watchHistory = recordPlayback(storedHistory, context, percent, new Date().toISOString());
    episodeWatchState = parseEpisodeWatchState(preferences.get("episodeWatchState"), storedHistory);
    if (context.episode && getHistoryEntry(watchHistory, context)?.watched) {
      episodeWatchState = markEpisodeWatched(episodeWatchState, context);
    }
    preferences.set("watchHistory", watchHistory);
    preferences.set("episodeWatchState", episodeWatchState);
    preferences.sync();
    sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, { history: watchHistory, episodeWatchState });
    lastProgressSavedAt = Date.now();
  }
  function sendScrobble(action, percent) {
    const context = activePlaybackContext;
    if (!context || !Number.isFinite(percent) || scrobbleStopSent)
      return;
    if (action === "stop")
      scrobbleStopSent = true;
    trakt.sendPlayback(action, context, percent);
    activeCour.then((cour) => simkl.sendPlayback(action, context, percent, cour));
  }
  async function resolveActiveCour(revision) {
    const context = activePlaybackContext;
    const episode = context?.episode;
    if (!context || !episode)
      return null;
    try {
      const target = await anime.resolveEpisode(context, episode);
      return isCurrentRequest(revision, playbackRevision) ? target : null;
    } catch (error) {
      logDebug("Popcorn: Anime cour lookup failed:", formatError(error));
      return null;
    }
  }
  function checkpointPlayback(forceStop = false) {
    const context = activePlaybackContext;
    if (!context)
      return;
    const percent = forceStop ? 100 : mpv.getNumber("percent-pos");
    if (!Number.isFinite(percent))
      return;
    savePlaybackProgress(percent);
    sendScrobble(forceStop || percent >= 90 ? "stop" : "pause", percent);
  }
  function stopPlaybackMonitoring() {
    lastPlaybackTickAt = 0;
    stopKeepAwake();
  }
  function prepareSplash() {
    try {
      if (savedImageDisplayDuration === null)
        savedImageDisplayDuration = mpv.getString("image-display-duration") || "1";
      mpv.set("image-display-duration", "inf");
      if (savedPositionOnQuitFlag === null)
        savedPositionOnQuitFlag = mpv.getFlag("save-position-on-quit");
      mpv.set("save-position-on-quit", false);
    } catch (error) {
      logDebug("Popcorn: Splash setup failed:", formatError(error));
    }
  }
  function restorePlayerOptions() {
    try {
      if (savedImageDisplayDuration !== null) {
        mpv.set("image-display-duration", savedImageDisplayDuration);
        savedImageDisplayDuration = null;
      }
      if (savedPositionOnQuitFlag !== null) {
        mpv.set("save-position-on-quit", savedPositionOnQuitFlag);
        savedPositionOnQuitFlag = null;
      }
    } catch (error) {
      logDebug("Popcorn: Player option restore failed:", formatError(error));
    }
  }
  function playItem(payload) {
    const url = String(payload?.url || "");
    if (!isHttpUrl2(url)) {
      utils.ask("Popcorn can only play direct http:// or https:// streams.");
      return;
    }
    const title = sanitizeMediaTitle(payload.title || "Popcorn");
    checkpointPlayback();
    const previousContext = activePlaybackContext;
    const previousStreamUrl = activeStreamUrl;
    const previousStreamRelease = activeStreamRelease;
    const previousScrobbleStopSent = scrobbleStopSent;
    activePlaybackContext = payload.playbackContext || null;
    activeStreamUrl = url;
    activeStreamRelease = String(payload?.releaseName || "");
    scrobbleStopSent = false;
    pendingResumePercent = typeof payload.resumePercent === "number" && Number.isFinite(payload.resumePercent) && payload.resumePercent >= 0 && payload.resumePercent <= 100 ? payload.resumePercent : null;
    isReplacingPlayback = true;
    reachedNaturalEof = false;
    clearIntro();
    core.osd("Loading stream...");
    try {
      mpv.command("loadfile", [url, "replace", "-1", `force-media-title=${title}`]);
    } catch (error) {
      activePlaybackContext = previousContext;
      activeStreamUrl = previousStreamUrl;
      activeStreamRelease = previousStreamRelease;
      scrobbleStopSent = previousScrobbleStopSent;
      pendingResumePercent = null;
      isReplacingPlayback = false;
      logDebug("Popcorn: Failed to start stream:", formatError(error));
      utils.ask("Popcorn could not start this stream.");
    }
  }
  function postNowPlaying() {
    if (!windowReady)
      return;
    sidebar.postMessage(MESSAGE_NAMES.NowPlaying, nowPlayingState());
  }
  function nowPlayingState() {
    return {
      videoId: activePlaybackContext ? historyContextId(activePlaybackContext) : "",
      url: activePlaybackContext ? activeStreamUrl : "",
      releaseName: activePlaybackContext ? activeStreamRelease : ""
    };
  }
  function handleEndFile() {
    stopPlaybackMonitoring();
    clearIntro();
    const offerNextEpisode = shouldOfferNextEpisode(isReplacingPlayback, reachedNaturalEof);
    const naturalEof = reachedNaturalEof;
    reachedNaturalEof = false;
    if (isReplacingPlayback) {
      return;
    }
    checkpointPlayback(naturalEof);
    const context = activePlaybackContext;
    activePlaybackContext = null;
    activeStreamUrl = "";
    activeStreamRelease = "";
    postNowPlaying();
    if (!offerNextEpisode || !context?.episode) {
      return;
    }
    const nextEpisode = findNextEpisode(context.episodes, context.episode);
    if (!nextEpisode) {
      return;
    }
    showSidebar();
    sidebar.postMessage(MESSAGE_NAMES.ShowNextEpisode, {
      media: context.media,
      episode: nextEpisode,
      episodes: context.episodes,
      resolution: context.resolution
    });
  }
  function clearIntro() {
    playbackRevision += 1;
    activeCour = Promise.resolve(null);
    introInterval = null;
    recapInterval = null;
    creditsInterval = null;
    prefetchedNextEpisode = null;
    prefetchedNextEpisodeAt = 0;
    overlayAction = null;
    overlayVisible = true;
    applyOverlayState();
  }
  var OVERLAY_LABELS = {
    recap: "Skip Recap",
    intro: "Skip Intro",
    credits: "Skip Outro",
    next: "Next Episode"
  };
  var OVERLAY_STYLE = `
    .skip-overlay {
        position: fixed;
        right: clamp(12px, 6vmin, 120px);
        bottom: clamp(64px, 12vmin, 120px);
        z-index: 1000;
    }
    .skip-button {
        padding: clamp(7px, 1.6vmin, 13px) clamp(13px, 3vmin, 24px);
        border: none;
        border-radius: 999px;
        background: #ffffff;
        color: #000000;
        font: 600 clamp(12px, 2.6vmin, 20px) -apple-system, BlinkMacSystemFont, sans-serif;
        white-space: nowrap;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
        cursor: pointer;
    }
    .skip-button:active { transform: scale(0.98); }
`;
  function renderOverlayButton(action, label) {
    return `<div class="skip-overlay">` + `<button class="skip-button" data-clickable type="button" ` + `onclick="iina.postMessage('overlayAction', { action: '${action}' })">${label}</button>` + `</div>`;
  }
  function handleOverlayAction(data) {
    const requested = data?.action || overlayAction;
    if (requested === "recap" && recapInterval) {
      const end = recapInterval.end;
      overlayAction = null;
      applyOverlayState();
      seekToSeconds(end);
      return;
    }
    if (requested === "intro" && introInterval) {
      const end = introInterval.end;
      overlayAction = null;
      applyOverlayState();
      seekToSeconds(end);
      return;
    }
    if (requested === "credits" && creditsInterval) {
      const end = creditsInterval.end;
      overlayAction = null;
      applyOverlayState();
      seekToSeconds(end);
      return;
    }
    if (requested === "next" && prefetchedNextEpisode) {
      const next = prefetchedNextEpisode;
      const fresh = isPrefetchFresh(prefetchedNextEpisodeAt, Date.now(), PREFETCH_FRESH_MS);
      prefetchedNextEpisode = null;
      prefetchedNextEpisodeAt = 0;
      const context = next.playbackContext;
      if (context.episode) {
        sidebar.postMessage(MESSAGE_NAMES.ShowNextEpisode, {
          media: context.media,
          episode: context.episode,
          episodes: context.episodes,
          resolution: context.resolution
        });
      }
      if (!fresh) {
        core.osd("Stream link expired - pick a stream for the next episode.");
        return;
      }
      playItem(next);
    }
  }
  function ensureOverlayInitialized() {
    if (overlayHandlerRegistered)
      return;
    overlay.simpleMode();
    overlay.setStyle(OVERLAY_STYLE);
    overlay.onMessage("overlayAction", handleOverlayAction);
    overlayHandlerRegistered = true;
  }
  function applyOverlayState() {
    if (!overlayAction) {
      if (!overlayVisible)
        return;
      overlay.hide();
      overlay.setClickable(false);
      overlayVisible = false;
      overlayLabel = "";
      return;
    }
    ensureOverlayInitialized();
    const label = OVERLAY_LABELS[overlayAction];
    if (label !== overlayLabel) {
      overlay.setContent(renderOverlayButton(overlayAction, label));
      overlayLabel = label;
    }
    if (overlayVisible)
      return;
    overlay.setClickable(true);
    overlay.show();
    overlayVisible = true;
  }
  function updateIntroOverlay() {
    const action = getOverlayAction(mpv.getNumber("time-pos"), { intro: introInterval, recap: recapInterval, credits: creditsInterval }, prefetchedNextEpisode !== null, mpv.getNumber("duration"));
    if (action === overlayAction)
      return;
    overlayAction = action;
    applyOverlayState();
  }
  function handleTimePositionChanged() {
    updateIntroOverlay();
    updatePlaybackMonitoring();
  }
  async function resolvePlaybackIntervals(revision) {
    const duration = mpv.getNumber("duration");
    const chapters = core.getChapters();
    const found = {
      intro: findChapterIntro(chapters),
      recap: null,
      credits: findChapterCredits(chapters, duration)
    };
    if (!isCurrentRequest(revision, playbackRevision))
      return;
    applySegments(found, duration);
    if (found.intro && found.credits)
      return;
    const context = activePlaybackContext;
    const episode = context?.episode;
    if (!context || !episode)
      return;
    if (!parseSkipSegments(preferences.get("skipSegments")))
      return;
    const merge = (part) => {
      if (!part || !isCurrentRequest(revision, playbackRevision))
        return;
      found.intro = found.intro || part.intro;
      found.recap = found.recap || (part.recap ?? null);
      found.credits = found.credits || part.credits;
      applySegments(found, duration);
    };
    await Promise.all([
      loadAniSkipSegments(revision, context, episode, duration).then(merge),
      loadIntroDbSegments(revision, context.media.imdbId, episode).then(merge)
    ]);
  }
  function seekToSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
      return;
    try {
      mpv.set("time-pos", Math.max(0, seconds + 0.5));
    } catch (error) {
      logDebug("Popcorn: Seek failed:", formatError(error));
    }
  }
  function applySegments(found, duration) {
    const segments = sanitizeSegments(found, duration);
    introInterval = segments.intro;
    recapInterval = segments.recap;
    creditsInterval = segments.credits;
    updateIntroOverlay();
  }
  async function loadAniSkipSegments(revision, context, episode, duration) {
    try {
      const target = await anime.resolveEpisode(context, episode);
      if (!target || !isCurrentRequest(revision, playbackRevision))
        return null;
      const response = await http.get(`https://api.aniskip.com/v2/skip-times/${encodeURIComponent(target.malId)}/${target.episode}` + "?types=op&types=ed&episodeLength=0", { params: {}, headers: { Accept: "application/json" }, data: {} });
      if (response.statusCode < 200 || response.statusCode >= 300)
        return null;
      const data = safeJson(response.data ?? response.text);
      const runtime = Number.isFinite(duration) && duration > 0 ? duration : 0;
      return {
        intro: parseAniSkipInterval(data, "op", runtime),
        credits: parseAniSkipInterval(data, "ed", runtime)
      };
    } catch (error) {
      logDebug("Popcorn: Skip interval lookup failed:", formatError(error));
      return null;
    }
  }
  async function loadIntroDbSegments(revision, imdbId, episode) {
    if (!isImdbId(imdbId) || !(episode.season >= 1) || !(episode.episode >= 1))
      return null;
    try {
      const data = await json.getJson(`https://api.introdb.app/segments?imdb_id=${encodeURIComponent(imdbId)}` + `&season=${encodeURIComponent(String(episode.season))}` + `&episode=${encodeURIComponent(String(episode.episode))}`);
      if (!isCurrentRequest(revision, playbackRevision))
        return null;
      return {
        intro: parseIntroDbSegment(data, "intro"),
        recap: parseIntroDbSegment(data, "recap"),
        credits: parseIntroDbSegment(data, "outro")
      };
    } catch (error) {
      logDebug("Popcorn: Segment lookup failed:", formatError(error));
      return null;
    }
  }
  function playingReleaseName() {
    try {
      return mpv.getString("filename") || "";
    } catch (error) {
      logDebug("Popcorn: Filename lookup failed:", formatError(error));
      return "";
    }
  }
  function playingTrackLanguage(track) {
    try {
      const tag = (mpv.getString(`current-tracks/${track}/lang`) || "").trim();
      return /^(und|undetermined|unknown)$/i.test(tag) ? "" : normalizeLanguage(tag);
    } catch (error) {
      logDebug("Popcorn: Track language lookup failed:", formatError(error));
      return "";
    }
  }
  async function prefetchNextEpisode(revision) {
    const context = activePlaybackContext;
    const current = context?.episode;
    if (!context || !current)
      return;
    const next = findNextEpisode(context.episodes, current);
    if (!next)
      return;
    try {
      const result = await loadEnabledAddonStreams(parseAddons(preferences.get("addons"), preferences.get("addonManifestUrl")), loadAddonManifest, async (addon) => parsePlayableStreams(await json.getJson(buildStremioStreamUrl(addon.manifestUrl, context.media.type, next.id))));
      if (!isCurrentRequest(revision, playbackRevision))
        return;
      const stream = pickNextEpisodeStream(result.streams, {
        previousResolution: context.resolution || "",
        previousRelease: playingReleaseName(),
        showTitle: context.media.name,
        preferredAudio: playingTrackLanguage("audio") || parseLanguagePreference(preferences.get("preferredAudio")),
        preferredSubtitle: playingTrackLanguage("sub") || parseLanguagePreference(preferences.get("preferredSubtitle"))
      });
      if (!stream)
        return;
      prefetchedNextEpisode = {
        url: stream.url,
        releaseName: stream.rawTitle,
        title: `${context.media.name} · S${String(next.season).padStart(2, "0")}` + `E${String(next.episode).padStart(2, "0")} · ${next.name}`,
        playbackContext: {
          media: context.media,
          episode: next,
          episodes: context.episodes,
          resolution: stream.resolution
        }
      };
      prefetchedNextEpisodeAt = Date.now();
      updateIntroOverlay();
    } catch (error) {
      logDebug("Popcorn: Next episode prefetch failed:", formatError(error));
    }
  }
  async function loadAddonManifest(addon) {
    const cached = addonManifests.get(addon.manifestUrl);
    if (cached)
      return cached;
    const manifest = parseAddonManifest(await json.getJson(addon.manifestUrl));
    addonManifests.set(addon.manifestUrl, manifest);
    return manifest;
  }
  function syncRemoteHistory() {
    const now = Date.now();
    if (historySyncInFlight || now - lastHistorySyncAt < HISTORY_SYNC_INTERVAL_MS)
      return;
    historySyncInFlight = true;
    lastHistorySyncAt = now;
    trakt.sync(watchHistory).then((synced) => simkl.sync(synced)).then(async (synced) => {
      const latestHistory = parseWatchHistory(preferences.get("watchHistory"));
      const merged = mergeWatchHistory(latestHistory, synced.history);
      const stored = mergeSimklCours(applySimklWatchedPatches(parseEpisodeWatchState(preferences.get("episodeWatchState"), merged), synced.watchedPatches), synced.watchedCours);
      const placed = await anime.placeWatchedCours(stored.simklCours, merged);
      const watchedState = addSimklWatchedEpisodes(stored, placed.patches);
      const history = mergeWatchHistory(merged, placed.entries);
      watchHistory = history;
      episodeWatchState = watchedState;
      preferences.set("watchHistory", history);
      preferences.set("episodeWatchState", watchedState);
      preferences.sync();
      sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, {
        history,
        episodeWatchState: watchedState
      });
    }).catch((error) => logDebug(`History sync failed: ${formatError(error)}`)).then(() => {
      historySyncInFlight = false;
    });
  }
  prepareSplash();
  global.onMessage("showPopcornSidebar", toggleSidebar);
  event.on("iina.window-loaded", () => {
    sidebar.loadFile("ui/sidebar.html");
    overlay.setClickable(false);
    overlay.hide();
    sidebar.onMessage(MESSAGE_NAMES.PlayItem, playItem);
    sidebar.onMessage(MESSAGE_NAMES.SetMediaType, (data) => {
      const mediaType = parseMediaTypePreference(data?.mediaType);
      preferences.set("mediaType", mediaType);
      preferences.sync();
    });
    sidebar.onMessage(MESSAGE_NAMES.SetEpisodeOrder, (data) => {
      preferences.set("episodeOrder", parseEpisodeOrder(data?.episodeOrder));
      preferences.sync();
    });
    sidebar.onMessage(MESSAGE_NAMES.RemoveHistoryEntry, (data) => {
      const id = data?.id;
      if (typeof id !== "string" || !id)
        return;
      const storedHistory = parseWatchHistory(preferences.get("watchHistory"));
      episodeWatchState = parseEpisodeWatchState(preferences.get("episodeWatchState"), storedHistory);
      watchHistory = removeHistoryEntry(storedHistory, id);
      preferences.set("watchHistory", watchHistory);
      preferences.set("episodeWatchState", episodeWatchState);
      preferences.sync();
      sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, { history: watchHistory, episodeWatchState });
    });
    sidebar.onMessage(MESSAGE_NAMES.RequestConfiguration, () => {
      watchHistory = parseWatchHistory(preferences.get("watchHistory"));
      episodeWatchState = parseEpisodeWatchState(preferences.get("episodeWatchState"), watchHistory);
      sidebar.postMessage(MESSAGE_NAMES.Configuration, {
        addons: parseAddons(preferences.get("addons"), preferences.get("addonManifestUrl")),
        mediaType: parseMediaTypePreference(preferences.get("mediaType")),
        episodeOrder: parseEpisodeOrder(preferences.get("episodeOrder")),
        history: watchHistory,
        episodeWatchState,
        nowPlaying: nowPlayingState()
      });
      syncRemoteHistory();
    });
    windowReady = true;
    global.postMessage("playerReady", {});
    syncRemoteHistory();
    if (pendingShowSidebar) {
      pendingShowSidebar = false;
      showSidebarWithDelay();
    }
  });
  event.on("mpv.file-loaded", () => {
    const path = mpv.getString("path") || "";
    isReplacingPlayback = false;
    reachedNaturalEof = false;
    if (path.includes(SPLASH_URL_MARKER)) {
      clearIntro();
      stopPlaybackMonitoring();
      activePlaybackContext = null;
      scrobbleStopSent = false;
      pendingResumePercent = null;
      setPlayerUIHidden(true);
      setWindowTitle("Popcorn");
      postNowPlaying();
      showSidebar();
      return;
    }
    clearIntro();
    postNowPlaying();
    restorePlayerOptions();
    setPlayerUIHidden(false);
    hideSidebar();
    startPlaybackMonitoring();
    if (pendingResumePercent !== null) {
      mpv.command("seek", [String(pendingResumePercent), "absolute-percent+exact"]);
      pendingResumePercent = null;
    }
    activeCour = resolveActiveCour(playbackRevision);
    sendScrobble("start", mpv.getNumber("percent-pos"));
    const revision = playbackRevision;
    if (!activePlaybackContext)
      return;
    resolvePlaybackIntervals(revision);
    prefetchNextEpisode(revision);
  });
  event.on("mpv.pause.changed", () => {
    if (isReplacingPlayback)
      return;
    if (mpv.getFlag("pause"))
      checkpointPlayback();
    else
      sendScrobble("start", mpv.getNumber("percent-pos"));
  });
  event.on("mpv.eof-reached.changed", () => {
    if (mpv.getFlag("eof-reached"))
      reachedNaturalEof = true;
  });
  event.on("mpv.time-pos.changed", handleTimePositionChanged);
  event.on("mpv.end-file", handleEndFile);
  event.on("iina.window-will-close", () => {
    stopPlaybackMonitoring();
    clearIntro();
    checkpointPlayback();
    windowReady = false;
    sidebarVisible = false;
    activePlaybackContext = null;
    activeStreamUrl = "";
    activeStreamRelease = "";
    scrobbleStopSent = false;
    pendingResumePercent = null;
    isReplacingPlayback = false;
    reachedNaturalEof = false;
    global.postMessage("playerClosed", {});
  });
  logDebug("Popcorn: Main entry loaded");
})();
