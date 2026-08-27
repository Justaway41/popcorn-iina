(() => {
  // Info.json
  var Info_default = {
    name: "Popcorn for IINA",
    identifier: "xyz.brbc.popcorn",
    version: "2.4.2",
    ghRepo: "Justaway41/popcorn-iina",
    ghVersion: 15,
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
      preferredAudio: "English",
      preferredSubtitle: "English",
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
  function isHttpUrl(value) {
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
    const target = entries.find((entry) => entry.id === id);
    if (!id || !target)
      return entries;
    return entries.filter((entry) => historyTitleId(entry) !== historyTitleId(target));
  }
  function historyTitleId(entry) {
    return entry.media.imdbId || entry.media.providerId || entry.media.id;
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
  function cacheRank(cached) {
    return cached === true ? 0 : cached === null ? 1 : 2;
  }
  function pickNextEpisodeStream(streams, options = {}) {
    const target = qualityHeight(options.previousResolution || "");
    const preferredAudio = (options.preferredAudio || "").trim().toLowerCase();
    const preferredSubtitle = (options.preferredSubtitle || "").trim().toLowerCase();
    let bestStream = null;
    let bestRank = [];
    streams.forEach((stream, index) => {
      const height = qualityHeight(stream.resolution);
      if (height === null)
        return;
      const rank = [
        cacheRank(stream.cached),
        languageRank(stream.audioLanguages, preferredAudio),
        languageRank(stream.subtitleLanguages, preferredSubtitle),
        target === null ? -height : Math.abs(height - target),
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
  function languageRank(languages, preferred) {
    if (!preferred)
      return 0;
    if (!languages || languages.length === 0)
      return 1;
    return languages.some((language) => language.trim().toLowerCase() === preferred) ? 0 : 2;
  }
  function compareRanks(a, b) {
    for (let index = 0;index < a.length; index += 1) {
      if (a[index] !== b[index])
        return a[index] - b[index];
    }
    return 0;
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
      if (!isHttpUrl2(url)) {
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
  function isHttpUrl2(value) {
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

  // src/plugin/global.ts
  var { console: console2, global, menu, preferences } = iina;
  migrateStructuredPreferences(preferences);
  applySplashIcon();
  var activePlayerId = null;
  function playerIdsMatch(a, b) {
    return String(a).split("-")[0] === String(b).split("-")[0];
  }
  global.onMessage("playerReady", (_data, playerId) => {
    if (playerId != null)
      activePlayerId = playerId;
  });
  global.onMessage("playerClosed", (_data, playerId) => {
    if (playerId != null && activePlayerId !== null && playerIdsMatch(playerId, activePlayerId)) {
      activePlayerId = null;
    }
  });
  async function showPopcorn() {
    if (activePlayerId !== null) {
      global.postMessage(activePlayerId, "showPopcornSidebar", {});
      return;
    }
    activePlayerId = global.createPlayerInstance({
      url: getSplashUrl(),
      enablePlugins: true,
      disableUI: true
    });
  }
  menu.addItem(menu.item("Popcorn", () => {
    showPopcorn().catch((error) => console2.error(`Popcorn: Menu action failed: ${formatError(error)}`));
  }, { keyBinding: "Shift+p" }));
  logDebug("Popcorn: Global entry loaded");
})();
