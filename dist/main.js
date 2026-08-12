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
    ShowNextEpisode: "showNextEpisode"
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
    return [entry, ...entries.filter((item) => item.id !== id)].slice(0, MAX_HISTORY_ITEMS);
  }
  function removeHistoryEntry(entries, id) {
    if (!id)
      return entries;
    return entries.filter((entry) => entry.id !== id);
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
  function isImdbId(value) {
    return /^tt\d+$/i.test(value.trim());
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
    return [...entries.values()].sort((a, b) => timestamp(b.lastPlayedAt) - timestamp(a.lastPlayedAt)).slice(0, MAX_HISTORY_ITEMS2);
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
    return entry.episode ? `${entry.media.imdbId}:${entry.episode.season}:${entry.episode.episode}` : entry.media.imdbId;
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
    version: "2.2.0",
    ghRepo: "Justaway41/popcorn-iina",
    ghVersion: 9,
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
  // src/shared/constants.ts
  var DEBUG_LOGS = false;

  // src/plugin/constants.ts
  var SHOW_SIDEBAR_DELAY_MS = 300;
  var SPLASH_URL_MARKER = "assets/Popcorn";
  var PLAYBACK_TICK_INTERVAL_MS = 1000;
  var PROGRESS_SAVE_INTERVAL_MS = 30000;
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
      retryAt: getNonNegativeNumber(item?.retryAt)
    };
  }
  function isSimklConnected(state) {
    return state.clientId !== "" && state.accessToken !== "";
  }
  async function simklScrobble(transport, state, action, context, progress, now = Date.now()) {
    if (!isSimklConnected(state))
      return state;
    if (!isImdbId(context.media.imdbId))
      return state;
    if (state.retryAt > now)
      return state;
    try {
      await request2(transport, state, "POST", `/scrobble/${action}`, buildScrobblePayload(context, progress), now);
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
        lastError: error instanceof SimklError ? error.message : "Simkl request failed.",
        retryAt: error instanceof SimklError ? error.retryAt : 0
      };
    }
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
    const response = await transport(method, `${SIMKL_API}${path}`, body, apiHeaders2(state)).catch(() => {
      throw new Error("Simkl request failed.");
    });
    if (response.status >= 200 && response.status < 300)
      return response.data;
    throw responseError2(response, now);
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
        data: response.data ?? safeJson(response.text),
        headers: {}
      };
    };
  }
  function safeJson(value) {
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
    let pending = Promise.resolve();
    return {
      sendPlayback(action, context, progress) {
        const result = pending.then(async () => {
          const state = read();
          if (!state.accessToken)
            return;
          try {
            const next = await simklScrobble(transport, state, action, context, progress);
            if (sameConnection2(read(), state)) {
              preferences.set("simkl", next);
              preferences.sync();
            }
          } catch (error) {
            onError(error);
          }
        });
        pending = result.then(() => {}, () => {});
        return result;
      }
    };
  }
  function sameConnection2(current, input) {
    return current.clientId === input.clientId && current.accessToken === input.accessToken;
  }

  // src/plugin/intro.ts
  var NEXT_EPISODE_TAIL_SEC = 60;
  var MIN_TAIL_DURATION_SEC = 300;
  function findChapterIntro(chapters) {
    return findChapterInterval(chapters, /^(intro|opening|op)$/i);
  }
  function findChapterCredits(chapters, duration) {
    return findChapterInterval(chapters, /^(ending|credits|outro|ed)$/i, Number.isFinite(duration) && duration > 0 ? duration : null);
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
  function parseAniSkipInterval(value, skipType = "op") {
    const response = record(value);
    if (response?.found !== true || !Array.isArray(response.results))
      return null;
    for (const result of response.results) {
      const item = record(result);
      if (item?.skipType !== skipType)
        continue;
      const interval = record(item.interval);
      const start = numberValue(interval?.startTime);
      const end = numberValue(interval?.endTime);
      if (start !== null && end !== null && start >= 0 && start < end)
        return { start, end };
    }
    return null;
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
    if (!nextReady)
      return null;
    if (isInsideIntro(time, segments.credits))
      return "next";
    return !segments.credits && isInsideTail(time, duration) ? "next" : null;
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

  // src/plugin/main.ts
  var { core, event, global, http, mpv, overlay, preferences, sidebar, utils } = iina;
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
  var watchHistory = parseWatchHistory(preferences.get("watchHistory"));
  var introInterval = null;
  var recapInterval = null;
  var creditsInterval = null;
  var playbackRevision = 0;
  var overlayAction = null;
  var overlayVisible = false;
  var overlayLabel = "";
  var overlayHandlerRegistered = false;
  var prefetchedNextEpisode = null;
  var kitsuMalIds = new Map;
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
    watchHistory = recordPlayback(parseWatchHistory(preferences.get("watchHistory")), context, percent, new Date().toISOString());
    preferences.set("watchHistory", watchHistory);
    preferences.sync();
    sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, { history: watchHistory });
    lastProgressSavedAt = Date.now();
  }
  function sendScrobble(action, percent) {
    const context = activePlaybackContext;
    if (!context || !Number.isFinite(percent) || scrobbleStopSent)
      return;
    if (action === "stop")
      scrobbleStopSent = true;
    trakt.sendPlayback(action, context, percent);
    simkl.sendPlayback(action, context, percent);
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
    activePlaybackContext = payload.playbackContext || null;
    scrobbleStopSent = false;
    pendingResumePercent = typeof payload.resumePercent === "number" && Number.isFinite(payload.resumePercent) && payload.resumePercent >= 0 && payload.resumePercent <= 100 ? payload.resumePercent : null;
    isReplacingPlayback = true;
    reachedNaturalEof = false;
    clearIntro();
    core.osd("Loading stream...");
    mpv.command("loadfile", [url, "replace", "-1", `force-media-title=${title}`]);
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
    introInterval = null;
    recapInterval = null;
    creditsInterval = null;
    prefetchedNextEpisode = null;
    overlayAction = null;
    overlayVisible = true;
    applyOverlayState();
  }
  var OVERLAY_LABELS = {
    recap: "Skip Recap",
    intro: "Skip Intro",
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
    if (requested === "next" && prefetchedNextEpisode) {
      const next = prefetchedNextEpisode;
      prefetchedNextEpisode = null;
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
    const providerId = context.media.providerId || context.media.id || "";
    if (context.media.providerType === "anime" || providerId.startsWith("kitsu:")) {
      const anime = await loadAniSkipSegments(revision, context.media.malId || "", providerId, episode, duration);
      if (!isCurrentRequest(revision, playbackRevision))
        return;
      if (anime) {
        found.intro = found.intro || anime.intro;
        found.credits = found.credits || anime.credits;
        applySegments(found, duration);
      }
    }
    if (found.intro && found.recap && found.credits)
      return;
    const db = await loadIntroDbSegments(revision, context.media.imdbId, episode);
    if (!db || !isCurrentRequest(revision, playbackRevision))
      return;
    found.intro = found.intro || db.intro;
    found.recap = found.recap || db.recap;
    found.credits = found.credits || db.credits;
    applySegments(found, duration);
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
    const known = Number.isFinite(duration) && duration > 0;
    const within = (interval) => interval && (!known || interval.end <= duration) ? interval : null;
    introInterval = within(found.intro);
    recapInterval = within(found.recap);
    creditsInterval = within(found.credits);
    updateIntroOverlay();
  }
  async function loadAniSkipSegments(revision, knownMalId, providerId, episode, duration) {
    try {
      const malId = knownMalId || await loadKitsuMalId(providerId);
      if (!malId || !Number.isFinite(duration) || duration <= 0 || !isCurrentRequest(revision, playbackRevision))
        return null;
      const response = await http.get(`https://api.aniskip.com/v2/skip-times/${encodeURIComponent(malId)}/${episode.episode}` + `?types=op&types=ed&episodeLength=${encodeURIComponent(String(duration))}`, { params: {}, headers: { Accept: "application/json" }, data: {} });
      if (response.statusCode < 200 || response.statusCode >= 300)
        return null;
      const data = safeJson2(response.data ?? response.text);
      return { intro: parseAniSkipInterval(data), credits: parseAniSkipInterval(data, "ed") };
    } catch (error) {
      logDebug("Popcorn: Skip interval lookup failed:", formatError(error));
      return null;
    }
  }
  async function loadIntroDbSegments(revision, imdbId, episode) {
    if (!isImdbId(imdbId) || !(episode.season >= 1) || !(episode.episode >= 1))
      return null;
    try {
      const data = await requestJson(`https://api.introdb.app/segments?imdb_id=${encodeURIComponent(imdbId)}` + `&season=${encodeURIComponent(String(episode.season))}` + `&episode=${encodeURIComponent(String(episode.episode))}`);
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
  async function prefetchNextEpisode(revision) {
    const context = activePlaybackContext;
    const current = context?.episode;
    if (!context || !current)
      return;
    const next = findNextEpisode(context.episodes, current);
    if (!next)
      return;
    try {
      const result = await loadEnabledAddonStreams(parseAddons(preferences.get("addons"), preferences.get("addonManifestUrl")), loadAddonManifest, async (addon) => parsePlayableStreams(await requestJson(buildStremioStreamUrl(addon.manifestUrl, context.media.type, next.id))));
      if (!isCurrentRequest(revision, playbackRevision))
        return;
      const stream = findClosestQualityStream(result.streams, context.resolution || "");
      if (!stream)
        return;
      prefetchedNextEpisode = {
        url: stream.url,
        title: `${context.media.name} · S${String(next.season).padStart(2, "0")}` + `E${String(next.episode).padStart(2, "0")} · ${next.name}`,
        playbackContext: {
          media: context.media,
          episode: next,
          episodes: context.episodes,
          resolution: stream.resolution
        }
      };
      updateIntroOverlay();
    } catch (error) {
      logDebug("Popcorn: Next episode prefetch failed:", formatError(error));
    }
  }
  async function loadAddonManifest(addon) {
    const cached = addonManifests.get(addon.manifestUrl);
    if (cached)
      return cached;
    const manifest = parseAddonManifest(await requestJson(addon.manifestUrl));
    addonManifests.set(addon.manifestUrl, manifest);
    return manifest;
  }
  async function requestJson(url) {
    const response = await http.get(url, {
      params: {},
      headers: { Accept: "application/json" },
      data: {}
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Request failed with HTTP ${response.statusCode}.`);
    }
    const data = safeJson2(response.data ?? response.text);
    if (data === null)
      throw new Error("Response was not valid JSON.");
    return data;
  }
  async function loadKitsuMalId(providerId) {
    const kitsuId = providerId.match(/^kitsu:(\d+)$/i)?.[1] || "";
    if (!kitsuId)
      return "";
    const cached = kitsuMalIds.get(kitsuId);
    if (cached !== undefined)
      return cached;
    const response = await http.get(`https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}/mappings`, { params: {}, headers: { Accept: "application/vnd.api+json" }, data: {} });
    const malId = response.statusCode >= 200 && response.statusCode < 300 ? parseKitsuMalId(response.data ?? safeJson2(response.text)) : "";
    kitsuMalIds.set(kitsuId, malId);
    return malId;
  }
  function safeJson2(value) {
    if (typeof value !== "string")
      return value ?? null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
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
      watchHistory = removeHistoryEntry(parseWatchHistory(preferences.get("watchHistory")), id);
      preferences.set("watchHistory", watchHistory);
      preferences.sync();
      sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, { history: watchHistory });
    });
    sidebar.onMessage(MESSAGE_NAMES.RequestConfiguration, () => {
      watchHistory = parseWatchHistory(preferences.get("watchHistory"));
      sidebar.postMessage(MESSAGE_NAMES.Configuration, {
        addons: parseAddons(preferences.get("addons"), preferences.get("addonManifestUrl")),
        mediaType: parseMediaTypePreference(preferences.get("mediaType")),
        episodeOrder: parseEpisodeOrder(preferences.get("episodeOrder")),
        history: watchHistory
      });
    });
    windowReady = true;
    global.postMessage("playerReady", {});
    trakt.sync(watchHistory).then((synced) => {
      const history = mergeWatchHistory(parseWatchHistory(preferences.get("watchHistory")), synced);
      watchHistory = history;
      preferences.set("watchHistory", history);
      preferences.sync();
      sidebar.postMessage(MESSAGE_NAMES.HistoryUpdated, { history });
    });
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
      showSidebar();
      return;
    }
    clearIntro();
    restorePlayerOptions();
    setPlayerUIHidden(false);
    hideSidebar();
    startPlaybackMonitoring();
    if (pendingResumePercent !== null) {
      mpv.command("seek", [String(pendingResumePercent), "absolute-percent+exact"]);
      pendingResumePercent = null;
    }
    sendScrobble("start", mpv.getNumber("percent-pos"));
    const revision = playbackRevision;
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
    scrobbleStopSent = false;
    pendingResumePercent = null;
    isReplacingPlayback = false;
    reachedNaturalEof = false;
    global.postMessage("playerClosed", {});
  });
  logDebug("Popcorn: Main entry loaded");
})();
