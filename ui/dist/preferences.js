(() => {
  // src/ui/addon-url-visibility.ts
  function getAddonUrlVisibility(revealed) {
    return {
      label: revealed ? "Hide" : "Reveal",
      ariaHidden: revealed ? "false" : "true",
      className: revealed ? "addon-url" : "addon-url is-blurred"
    };
  }
  function createAddonUrlVisibilityController(focusReveal) {
    let revealed = false;
    const state = () => getAddonUrlVisibility(revealed);
    return {
      state,
      toggle() {
        if (!revealed)
          focusReveal();
        revealed = !revealed;
        return state();
      },
      hide() {
        revealed = false;
        return state();
      }
    };
  }
  function bindAddonUrlVisibility(reveal, enabled, controller, setVisibility, onEnabledChange) {
    reveal.addEventListener("click", () => setVisibility(controller.toggle()));
    reveal.addEventListener("blur", () => setVisibility(controller.hide()));
    enabled.addEventListener("change", () => {
      setVisibility(controller.hide());
      onEnabledChange();
    });
  }

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
  function applySimklWatchedPatches(state, patches) {
    const next = parseEpisodeWatchState(state);
    for (const patch of parseWatchedShows(patches)) {
      next.simkl = next.simkl.filter((show) => show.id !== patch.id);
      if (patch.episodes.length > 0)
        next.simkl.push(patch);
    }
    return next;
  }
  function clearSimklWatched(state) {
    return { ...parseEpisodeWatchState(state), simkl: [], simklCours: [] };
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
  function isEpisodeWatched(state, media, episode, legacyHistory = []) {
    const titleId = mediaTitleId(media);
    const coordinate = episodeCoordinate(episode);
    if ([...state.local, ...state.simkl].some((show) => show.id === titleId && show.episodes.includes(coordinate)))
      return true;
    return legacyHistory.some((entry) => entry.watched && entry.episode != null && historyTitleId(entry) === titleId && episodeCoordinate(entry.episode) === coordinate);
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
    return mediaTitleId(entry.media);
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
  var TRAKT_ACCOUNT_URL = "https://trakt.tv/join";
  var TRAKT_APPLICATIONS_URL = "https://app.trakt.tv/settings/apps/api";
  var MAX_HISTORY_ITEMS2 = 100;
  var TOKEN_REFRESH_WINDOW_MS = 60000;
  var DEFAULT_RETRY_MS = 60000;
  function parseTraktExternalLinkRequest(value) {
    const url = getString4(getRecord4(value)?.url);
    if (url === TRAKT_ACCOUNT_URL || url === TRAKT_APPLICATIONS_URL)
      return url;
    return /^https:\/\/trakt\.tv\/activate\/[A-Za-z0-9_-]+$/.test(url) ? url : "";
  }
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
  async function requestDeviceCode(transport, state, now = Date.now()) {
    const data = await request(transport, state, "POST", "/oauth/device/code", { client_id: state.clientId }, now);
    const item = getRecord4(data);
    const deviceCode = getString4(item?.device_code);
    const userCode = getString4(item?.user_code);
    const verificationUrl = getString4(item?.verification_url);
    const expiresIn = getPositiveNumber2(item?.expires_in);
    const interval = getPositiveNumber2(item?.interval);
    if (!deviceCode || !userCode || !verificationUrl || !expiresIn || !interval) {
      throw new Error("Invalid Trakt device code response.");
    }
    return {
      deviceCode,
      userCode,
      verificationUrl,
      expiresAt: now + expiresIn * 1000,
      intervalMs: interval * 1000
    };
  }
  async function pollDeviceToken(transport, state, code, wait) {
    let intervalMs = code.intervalMs;
    while (Date.now() < code.expiresAt) {
      const response = await transport("POST", `${TRAKT_API}/oauth/device/token`, {
        code: code.deviceCode,
        client_id: state.clientId,
        client_secret: state.clientSecret
      }, apiHeaders(state));
      if (response.status === 200) {
        return {
          ...state,
          tokens: parseTokens(response.data),
          reconnectRequired: false,
          lastError: "",
          retryAt: 0
        };
      }
      if (response.status === 404) {
        throw new TraktError(response.status, 0, "Trakt device code is invalid.");
      }
      if (response.status === 409) {
        throw new TraktError(response.status, 0, "Trakt device code was already used.");
      }
      if (response.status === 410) {
        throw new TraktError(response.status, 0, "Trakt device code expired.");
      }
      if (response.status === 418) {
        throw new TraktError(response.status, 0, "Trakt device authorization was denied.");
      }
      if (response.status === 429) {
        intervalMs += retryAfterMs(response.headers) ?? code.intervalMs;
      } else if (response.status !== 400) {
        throw responseError(response, Date.now());
      }
      if (Date.now() + intervalMs >= code.expiresAt)
        break;
      await wait(intervalMs);
    }
    throw new TraktError(410, 0, "Trakt device code expired.");
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
  var SIMKL_PIN_URL = "https://simkl.com/pin";
  var SIMKL_DEVELOPER_URL = "https://simkl.com/settings/developer";
  var DEFAULT_RETRY_MS2 = 60000;
  function parseSimklExternalLinkRequest(value) {
    const url = getString4(getRecord4(value)?.url);
    return url === SIMKL_PIN_URL || url === SIMKL_DEVELOPER_URL ? url : "";
  }
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
  async function requestSimklPin(transport, state, now = Date.now()) {
    const data = await request2(transport, state, "GET", pinPath(state), null, now);
    const item = getRecord4(data);
    const userCode = getString4(item?.user_code);
    const verificationUrl = getString4(item?.verification_url) || SIMKL_PIN_URL;
    const expiresIn = getPositiveNumber2(item?.expires_in);
    const interval = getPositiveNumber2(item?.interval);
    if (!userCode || !expiresIn || !interval) {
      throw new Error("Invalid Simkl pin response.");
    }
    return {
      userCode,
      verificationUrl,
      expiresAt: now + expiresIn * 1000,
      intervalMs: interval * 1000
    };
  }
  async function pollSimklPin(transport, state, pin, wait) {
    let intervalMs = pin.intervalMs;
    while (Date.now() < pin.expiresAt) {
      let item = null;
      try {
        item = getRecord4(await request2(transport, state, "GET", pinPath(state, pin.userCode), null, Date.now()));
      } catch (error) {
        const simklError = error instanceof SimklError ? error : null;
        if (simklError && simklError.status < 500 && simklError.status !== 429)
          throw simklError;
        const retryAt = simklError?.retryAt ?? 0;
        if (retryAt > Date.now())
          intervalMs = Math.max(intervalMs, retryAt - Date.now());
      }
      const accessToken = getString4(item?.access_token);
      if (isOk(item) && accessToken) {
        return { ...state, accessToken, lastError: "", retryAt: 0 };
      }
      if (Date.now() + intervalMs >= pin.expiresAt)
        break;
      await wait(intervalMs);
    }
    throw new Error("Simkl pin expired before it was approved.");
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
  function pinPath(state, userCode = "") {
    const base = userCode ? `/oauth/pin/${encodeURIComponent(userCode)}` : "/oauth/pin";
    return `${base}?client_id=${encodeURIComponent(state.clientId)}`;
  }
  function isOk(item) {
    return getString4(item?.result).toUpperCase() === "OK";
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

  // src/ui/preferences.ts
  var addons = [];
  var trakt = parseTraktState(null);
  var traktRevision = 0;
  var simkl = parseSimklState(null);
  var simklRevision = 0;
  var simklWatchedReset = Promise.resolve();
  var manifests = new Map;
  document.documentElement.dataset.version = CLIENT_VERSION;
  var preferences = window.iina.preferences;
  var form = element("addon-form");
  var input = element("addon-url");
  var addButton = element("add-addon");
  var errorMessage = element("addon-error");
  var list = element("addon-list");
  var empty = element("addon-empty");
  var template = element("addon-row-template");
  var presetButtons = [...document.querySelectorAll(".addon-preset")];
  var skipSegments = element("skip-segments");
  var preferredAudio = element("preferred-audio");
  var preferredSubtitle = element("preferred-subtitle");
  var traktClientId = element("trakt-client-id");
  var traktClientSecret = element("trakt-client-secret");
  var traktConnect = element("trakt-connect");
  var traktSync = element("trakt-sync");
  var traktDisconnect = element("trakt-disconnect");
  var traktDevice = element("trakt-device");
  var traktStatus = element("trakt-status");
  var traktError = element("trakt-error");
  var externalLinks = [...document.querySelectorAll("[data-external-url]")];
  var simklClientId = element("simkl-client-id");
  var simklConnect = element("simkl-connect");
  var simklSync = element("simkl-sync");
  var simklDisconnect = element("simkl-disconnect");
  var simklPin = element("simkl-pin");
  var simklStatus = element("simkl-status");
  var simklError = element("simkl-error");
  var simklLinks = [...document.querySelectorAll("[data-simkl-url]")];
  var browserTransport = async (method, url, body, headers) => {
    const response = await fetch(url, {
      method,
      headers,
      ...method === "POST" ? { body: JSON.stringify(body) } : {}
    });
    const data = await response.json().catch(() => null);
    return {
      status: response.status,
      data,
      headers: Object.fromEntries([...response.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]))
    };
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    addAddon();
  });
  presetButtons.forEach((button) => {
    button.addEventListener("click", () => void addAddon(button.dataset.url || "", button));
  });
  traktClientId.addEventListener("change", saveTraktCredentials);
  traktClientSecret.addEventListener("change", saveTraktCredentials);
  traktConnect.addEventListener("click", () => void connectTrakt());
  traktSync.addEventListener("click", () => void syncTraktNow());
  traktDisconnect.addEventListener("click", disconnectTrakt);
  externalLinks.forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    copyExternalLink(link.href).then((copied) => {
      traktStatus.textContent = copied ? "Link copied. Paste it into your browser." : "Could not copy the link. Right-click it and choose Copy Link.";
    });
  }));
  simklClientId.addEventListener("change", saveSimklClientId);
  simklSync.addEventListener("click", () => void syncSimklNow());
  simklConnect.addEventListener("click", () => void connectSimkl());
  simklDisconnect.addEventListener("click", disconnectSimkl);
  simklLinks.forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    copyExternalLink(link.href).then((copied) => {
      simklStatus.textContent = copied ? "Link copied. Paste it into your browser." : "Could not copy the link. Right-click it and choose Copy Link.";
    });
  }));
  skipSegments.addEventListener("change", () => {
    preferences.set("skipSegments", skipSegments.checked);
  });
  var LANGUAGE_OPTIONS = [
    "English",
    "Japanese",
    "Hindi",
    "Spanish",
    "French",
    "German",
    "Korean",
    "Chinese",
    "Italian",
    "Portuguese",
    "Russian",
    "Tamil",
    "Telugu",
    "Arabic"
  ];
  for (const select of [preferredAudio, preferredSubtitle]) {
    const anyOption = document.createElement("option");
    anyOption.value = "";
    anyOption.textContent = "Any language";
    select.appendChild(anyOption);
    for (const language of LANGUAGE_OPTIONS) {
      const option = document.createElement("option");
      option.value = language;
      option.textContent = language;
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      preferences.set(select.id === "preferred-audio" ? "preferredAudio" : "preferredSubtitle", select.value);
    });
  }
  loadPreferences();
  async function loadPreferences() {
    const [stored, legacy, storedTrakt, storedSkipSegments, storedSimkl, storedAudio, storedSubtitle] = await Promise.all([
      getPreference("addons"),
      getPreference("addonManifestUrl"),
      getPreference("trakt"),
      getPreference("skipSegments"),
      getPreference("simkl"),
      getPreference("preferredAudio"),
      getPreference("preferredSubtitle")
    ]);
    const storedAddons = parseAddons(stored);
    addons = parseAddons(stored, legacy);
    skipSegments.checked = parseSkipSegments(storedSkipSegments);
    setLanguageSelect(preferredAudio, storedAudio);
    setLanguageSelect(preferredSubtitle, storedSubtitle);
    trakt = parseTraktState(storedTrakt);
    traktClientId.value = trakt.clientId;
    traktClientSecret.value = trakt.clientSecret;
    simkl = parseSimklState(storedSimkl);
    simklClientId.value = simkl.clientId;
    render();
    renderTrakt();
    renderSimkl();
    const loaded = await Promise.allSettled(addons.map(async (addon) => {
      const manifest = await fetchManifest(addon.manifestUrl);
      manifests.set(addon.manifestUrl, manifest);
      return { addon, manifest };
    }));
    let changed = false;
    loaded.forEach((result) => {
      if (result.status !== "fulfilled" || result.value.addon.name === result.value.manifest.name)
        return;
      const index = addons.indexOf(result.value.addon);
      if (index !== -1)
        addons[index] = { ...addons[index], name: result.value.manifest.name };
      changed = true;
    });
    if (changed)
      save();
    else
      render();
    if (storedAddons.length === 0 && addons.length === 1) {
      try {
        const manifest = await fetchManifest(addons[0].manifestUrl);
        addons[0] = { ...addons[0], name: manifest.name };
        save();
      } catch {}
    }
  }
  async function addAddon(value = input.value, trigger = addButton) {
    setError("");
    trigger.disabled = true;
    const originalLabel = trigger.textContent;
    trigger.textContent = "Adding…";
    try {
      const manifestUrl = canonicalizeManifestUrl(value);
      if (addons.some((addon) => addon.manifestUrl === manifestUrl)) {
        throw new Error("This addon is already added.");
      }
      const manifest = await fetchManifest(manifestUrl);
      manifests.set(manifestUrl, manifest);
      addons.push({ name: manifest.name, manifestUrl, enabled: true });
      if (trigger === addButton)
        input.value = "";
      save();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not add this addon.");
    } finally {
      trigger.disabled = false;
      trigger.textContent = originalLabel;
      renderPresetButtons();
    }
  }
  async function fetchManifest(manifestUrl) {
    const response = await fetch(manifestUrl, { headers: { Accept: "application/json" } });
    if (!response.ok)
      throw new Error(`Manifest request failed with HTTP ${response.status}.`);
    return parseAddonManifest(await response.json());
  }
  function render() {
    list.replaceChildren(...addons.map((addon, index) => {
      const row = template.content.firstElementChild?.cloneNode(true);
      if (!row)
        throw new Error("Missing addon row template.");
      const toggle = row.querySelector(".addon-enabled");
      const name = row.querySelector(".addon-name");
      const host = row.querySelector(".addon-host");
      const url = row.querySelector(".addon-url");
      const capabilities = row.querySelector(".addon-capabilities");
      const reveal = row.querySelector(".addon-reveal");
      const remove = row.querySelector(".addon-remove");
      if (!toggle || !name || !host || !url || !capabilities || !reveal || !remove) {
        throw new Error("Invalid addon row template.");
      }
      toggle.checked = addon.enabled;
      toggle.setAttribute("aria-label", `Enable ${addon.name}`);
      name.textContent = addon.name;
      host.textContent = getAddonHostname(addon.manifestUrl);
      url.textContent = addon.manifestUrl;
      const manifest = manifests.get(addon.manifestUrl);
      capabilities.replaceChildren(...(manifest?.resources || []).map((resource) => {
        const badge = document.createElement("span");
        badge.textContent = resource === "meta" ? "Metadata" : resource[0].toUpperCase() + resource.slice(1);
        return badge;
      }));
      remove.setAttribute("aria-label", `Remove ${addon.name}`);
      const visibility = createAddonUrlVisibilityController(() => reveal.focus());
      const setVisibility = (state) => {
        url.className = state.className;
        url.setAttribute("aria-hidden", state.ariaHidden);
        reveal.textContent = state.label;
        reveal.setAttribute("aria-label", `${state.label} URL for ${addon.name}`);
      };
      setVisibility(visibility.state());
      bindAddonUrlVisibility(reveal, toggle, visibility, setVisibility, () => {
        addons[index] = { ...addon, enabled: toggle.checked };
        save(false);
      });
      remove.addEventListener("click", () => {
        addons.splice(index, 1);
        if (addons.length === 0)
          preferences.set("addonManifestUrl", "");
        save();
      });
      return row;
    }));
    empty.hidden = addons.length > 0;
    renderPresetButtons();
  }
  function renderPresetButtons() {
    presetButtons.forEach((button) => {
      const presetUrl = canonicalizeManifestUrl(button.dataset.url || "");
      const added = addons.some((addon) => addon.manifestUrl === presetUrl);
      button.disabled = added;
      button.textContent = added ? "Added" : `Add ${button.dataset.name}`;
    });
  }
  function save(shouldRender = true) {
    preferences.set("addons", addons);
    preferences.sync?.();
    if (shouldRender)
      render();
  }
  function getPreference(key) {
    return new Promise((resolve) => preferences.get(key, resolve));
  }
  function setLanguageSelect(select, value) {
    const language = typeof value === "string" ? value.trim() : "";
    select.value = LANGUAGE_OPTIONS.includes(language) ? language : "";
  }
  function setError(message) {
    errorMessage.textContent = message;
    errorMessage.hidden = !message;
  }
  function setTraktError(message) {
    traktError.textContent = message;
    traktError.hidden = !message;
  }
  function renderTrakt() {
    const connected = trakt.tokens !== null;
    traktConnect.hidden = connected;
    traktSync.hidden = !connected;
    traktDisconnect.hidden = !connected;
    traktStatus.textContent = connected ? trakt.lastError ? "Connected · Sync failed" : `Connected${trakt.lastSyncAt ? ` · Last synced ${new Date(trakt.lastSyncAt).toLocaleString()}` : ""}` : trakt.reconnectRequired ? "Reconnect required" : "Not connected";
    if (trakt.lastError)
      setTraktError(trakt.lastError);
  }
  function saveTrakt(next) {
    trakt = next;
    preferences.set("trakt", next);
    preferences.sync?.();
    if (!next.lastError)
      setTraktError("");
    renderTrakt();
  }
  function setSimklError(message) {
    simklError.textContent = message;
    simklError.hidden = !message;
  }
  function renderSimkl() {
    const connected = simkl.accessToken !== "";
    simklConnect.hidden = connected;
    simklSync.hidden = !connected;
    simklDisconnect.hidden = !connected;
    simklStatus.textContent = connected ? simkl.lastError ? "Connected · Last request failed" : `Connected${simkl.lastSyncAt ? ` · Last synced ${new Date(simkl.lastSyncAt).toLocaleString()}` : ""}` : "Not connected";
    if (simkl.lastError)
      setSimklError(simkl.lastError);
  }
  function saveSimkl(next) {
    simkl = next;
    preferences.set("simkl", next);
    preferences.sync?.();
    if (!next.lastError)
      setSimklError("");
    renderSimkl();
  }
  function saveSimklClientId() {
    const clientId = simklClientId.value.trim();
    if (clientId === simkl.clientId)
      return;
    simklRevision += 1;
    simklPin.hidden = true;
    saveSimkl({ clientId, accessToken: "", lastError: "", retryAt: 0, lastActivityAt: "", lastSyncAt: "" });
    clearStoredSimklWatched();
  }
  async function connectSimkl() {
    setSimklError("");
    const clientId = simklClientId.value.trim();
    if (!clientId) {
      setSimklError("Enter the Simkl Client ID.");
      return;
    }
    const revision = ++simklRevision;
    simklConnect.disabled = true;
    try {
      saveSimkl({ clientId, accessToken: "", lastError: "", retryAt: 0, lastActivityAt: "", lastSyncAt: "" });
      await clearStoredSimklWatched();
      if (revision !== simklRevision)
        return;
      simklStatus.textContent = "Requesting a PIN…";
      const pin = await requestSimklPin(browserTransport, simkl);
      if (revision !== simklRevision)
        return;
      simklPin.hidden = false;
      const copied = await copyExternalLink(pin.verificationUrl);
      simklPin.textContent = copied ? `Enter ${pin.userCode} at simkl.com/pin · Link copied` : `Open ${pin.verificationUrl} and enter ${pin.userCode}`;
      simklStatus.textContent = "Waiting for Simkl authorization…";
      const connected = await pollSimklPin(browserTransport, simkl, pin, (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
      if (revision !== simklRevision)
        return;
      saveSimkl(connected);
      simklPin.hidden = true;
      const local = parseWatchHistory(await getPreference("watchHistory"));
      if (revision !== simklRevision)
        return;
      const result = await syncSimklHistory(browserTransport, connected, local);
      await persistSimklSync(result, revision);
    } catch (error) {
      if (revision === simklRevision) {
        setSimklError(error instanceof Error ? error.message : "Could not connect Simkl.");
      }
    } finally {
      simklConnect.disabled = false;
      if (revision === simklRevision)
        renderSimkl();
    }
  }
  function disconnectSimkl() {
    simklRevision += 1;
    simklPin.hidden = true;
    setSimklError("");
    saveSimkl({ ...simkl, accessToken: "", lastError: "", retryAt: 0, lastActivityAt: "", lastSyncAt: "" });
    clearStoredSimklWatched();
  }
  function saveTraktCredentials() {
    const clientId = traktClientId.value.trim();
    const clientSecret = traktClientSecret.value.trim();
    if (clientId === trakt.clientId && clientSecret === trakt.clientSecret)
      return;
    traktRevision += 1;
    traktDevice.hidden = true;
    saveTrakt({
      ...trakt,
      clientId,
      clientSecret,
      tokens: null,
      reconnectRequired: false,
      initialHistoryUploaded: false,
      lastSyncAt: "",
      lastError: "",
      retryAt: 0
    });
  }
  async function connectTrakt() {
    setTraktError("");
    const clientId = traktClientId.value.trim();
    const clientSecret = traktClientSecret.value.trim();
    if (!clientId || !clientSecret) {
      setTraktError("Enter both the Trakt Client ID and Client Secret.");
      return;
    }
    const revision = ++traktRevision;
    traktConnect.disabled = true;
    try {
      saveTrakt({
        ...trakt,
        clientId,
        clientSecret,
        tokens: null,
        reconnectRequired: false,
        initialHistoryUploaded: false,
        lastSyncAt: "",
        lastError: "",
        retryAt: 0
      });
      traktStatus.textContent = "Requesting device code…";
      const code = await requestDeviceCode(browserTransport, trakt);
      if (revision !== traktRevision)
        return;
      traktDevice.hidden = false;
      const activation = `${code.verificationUrl.replace(/\/$/, "")}/${encodeURIComponent(code.userCode)}`;
      const copied = await copyExternalLink(activation);
      traktDevice.textContent = copied ? `Enter ${code.userCode} at trakt.tv/activate · Link copied` : `Open ${activation} in your browser`;
      traktStatus.textContent = "Waiting for Trakt authorization…";
      const connected = await pollDeviceToken(browserTransport, trakt, code, (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
      if (revision !== traktRevision)
        return;
      saveTrakt(connected);
      const local = parseWatchHistory(await getPreference("watchHistory"));
      if (revision !== traktRevision)
        return;
      const result = await syncTraktHistory(browserTransport, connected, local);
      const latest = parseWatchHistory(await getPreference("watchHistory"));
      if (revision !== traktRevision)
        return;
      preferences.set("watchHistory", mergeWatchHistory(result.history, latest));
      preferences.sync?.();
      saveTrakt(result.state);
      traktDevice.hidden = true;
    } catch (error) {
      if (revision === traktRevision) {
        setTraktError(error instanceof Error ? error.message : "Could not connect Trakt.");
      }
    } finally {
      traktConnect.disabled = false;
      if (revision === traktRevision)
        renderTrakt();
    }
  }
  async function copyExternalLink(url) {
    const safeUrl = parseTraktExternalLinkRequest({ url }) || parseSimklExternalLinkRequest({ url });
    if (!safeUrl)
      return false;
    try {
      await navigator.clipboard.writeText(safeUrl);
      return true;
    } catch {
      return false;
    }
  }
  async function syncSimklNow() {
    if (!simkl.accessToken)
      return;
    const state = simkl;
    const revision = ++simklRevision;
    simklSync.disabled = true;
    setSimklError("");
    try {
      const local = parseWatchHistory(await getPreference("watchHistory"));
      if (revision !== simklRevision)
        return;
      const result = await syncSimklHistory(browserTransport, state, local);
      await persistSimklSync(result, revision);
    } catch (error) {
      if (revision === simklRevision) {
        setSimklError(error instanceof Error ? error.message : "Could not sync Simkl.");
      }
    } finally {
      simklSync.disabled = false;
    }
  }
  async function persistSimklSync(result, revision) {
    const [storedHistory, storedState] = await Promise.all([
      getPreference("watchHistory"),
      getPreference("episodeWatchState")
    ]);
    if (revision !== simklRevision)
      return;
    const latest = parseWatchHistory(storedHistory);
    const history = mergeWatchHistory(latest, result.history);
    const watchedState = mergeSimklCours(applySimklWatchedPatches(parseEpisodeWatchState(storedState, history), result.watchedPatches), result.watchedCours);
    simkl = result.state;
    preferences.set("watchHistory", history);
    preferences.set("episodeWatchState", watchedState);
    preferences.set("simkl", simkl);
    preferences.sync?.();
    if (!simkl.lastError)
      setSimklError("");
    renderSimkl();
  }
  function clearStoredSimklWatched() {
    simklWatchedReset = simklWatchedReset.then(async () => {
      const [storedHistory, storedState] = await Promise.all([
        getPreference("watchHistory"),
        getPreference("episodeWatchState")
      ]);
      preferences.set("episodeWatchState", clearSimklWatched(parseEpisodeWatchState(storedState, parseWatchHistory(storedHistory))));
      preferences.sync?.();
    });
    return simklWatchedReset;
  }
  async function syncTraktNow() {
    if (!trakt.tokens)
      return;
    const state = trakt;
    const revision = ++traktRevision;
    traktSync.disabled = true;
    setTraktError("");
    try {
      const local = parseWatchHistory(await getPreference("watchHistory"));
      if (revision !== traktRevision)
        return;
      const result = await syncTraktHistory(browserTransport, state, local);
      const latest = parseWatchHistory(await getPreference("watchHistory"));
      if (revision !== traktRevision)
        return;
      preferences.set("watchHistory", mergeWatchHistory(result.history, latest));
      preferences.sync?.();
      saveTrakt(result.state);
    } catch (error) {
      if (revision === traktRevision) {
        setTraktError(error instanceof Error ? error.message : "Could not sync Trakt.");
      }
    } finally {
      traktSync.disabled = false;
    }
  }
  function disconnectTrakt() {
    traktRevision += 1;
    saveTrakt({
      ...trakt,
      tokens: null,
      reconnectRequired: false,
      lastSyncAt: "",
      lastError: "",
      retryAt: 0
    });
    traktDevice.hidden = true;
  }
  function element(id) {
    const value = document.getElementById(id);
    if (!value)
      throw new Error(`Missing element: ${id}`);
    return value;
  }
})();
