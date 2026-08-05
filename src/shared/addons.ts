import type { PlayableStream } from "./stremio";

export interface StremioAddon {
    name: string;
    manifestUrl: string;
    enabled: boolean;
}

export type AddonResource = "catalog" | "meta" | "stream" | "subtitles";

export interface StremioCatalog {
    id: string;
    type: string;
    name?: string;
    extra: Array<{ name: string; isRequired?: boolean }>;
}

export interface AddonManifest {
    name: string;
    resources: AddonResource[];
    types: string[];
    catalogs: StremioCatalog[];
}

export interface AddonStream extends PlayableStream {
    addonName: string;
}

export interface AddonStreamLoadResult {
    streams: AddonStream[];
    failedAddons: number;
    successfulAddons: number;
}

export function canonicalizeManifestUrl(value: string): string {
    const trimmed = value.trim();
    const normalized = trimmed.replace(/^stremio:\/\//i, "https://");
    const parts = parseUrl(normalized);
    const basePath = parts.path.replace(/\/manifest\.json\/?$/i, "").replace(/\/+$/, "");
    return `${parts.scheme}://${parts.authority}${basePath}/manifest.json${parts.query}`;
}

export function getAddonHostname(manifestUrl: string): string {
    const authority = parseUrl(canonicalizeManifestUrl(manifestUrl)).authority.split("@").pop() || "";
    if (authority.startsWith("[")) return authority.slice(0, authority.indexOf("]") + 1);
    return authority.replace(/:\d+$/, "");
}

export function parseAddons(value: unknown, legacyUrl?: unknown): StremioAddon[] {
    let stored: unknown = value;
    try {
        if (typeof stored === "string") stored = JSON.parse(stored) as unknown;
    } catch {
        stored = [];
    }

    const seen = new Set<string>();
    const addons = Array.isArray(stored) ? stored.flatMap((entry) => {
        const item = getRecord(entry);
        const name = typeof item?.name === "string" ? item.name.trim() : "";
        if (!name || typeof item?.manifestUrl !== "string" || typeof item.enabled !== "boolean") return [];
        try {
            const manifestUrl = canonicalizeManifestUrl(item.manifestUrl);
            if (seen.has(manifestUrl)) return [];
            seen.add(manifestUrl);
            return [{ name, manifestUrl, enabled: item.enabled }];
        } catch {
            return [];
        }
    }) : [];

    if (addons.length > 0 || typeof legacyUrl !== "string" || !legacyUrl.trim()) return addons;
    try {
        const manifestUrl = canonicalizeManifestUrl(legacyUrl);
        return [{ name: getAddonHostname(manifestUrl), manifestUrl, enabled: true }];
    } catch {
        return [];
    }
}

export function parseAddonManifest(value: unknown): AddonManifest {
    const manifest = getRecord(value);
    const name = typeof manifest?.name === "string" ? manifest.name.trim() : "";
    if (!name) throw new Error("Manifest is missing a name.");
    const supported = new Set<AddonResource>(["catalog", "meta", "stream", "subtitles"]);
    const resources = [...new Set((Array.isArray(manifest?.resources) ? manifest.resources : [])
        .map((resource) => typeof resource === "string" ? resource : getString(getRecord(resource)?.name))
        .filter((resource): resource is AddonResource => supported.has(resource as AddonResource)))];
    if (resources.length === 0) throw new Error("Manifest does not provide a supported resource.");
    return {
        name,
        resources,
        types: Array.isArray(manifest?.types)
            ? manifest.types.filter((type): type is string => typeof type === "string" && Boolean(type))
            : [],
        catalogs: Array.isArray(manifest?.catalogs) ? manifest.catalogs.flatMap(parseCatalog) : []
    };
}

export async function loadAddonStreams(
    addons: StremioAddon[],
    load: (addon: StremioAddon) => Promise<PlayableStream[]>
): Promise<AddonStreamLoadResult> {
    const results = await Promise.allSettled(addons.map(load));
    const seen = new Set<string>();
    const streams: AddonStream[] = [];
    let failedAddons = 0;
    let successfulAddons = 0;

    results.forEach((result, index) => {
        if (result.status === "rejected") {
            failedAddons += 1;
            return;
        }
        successfulAddons += 1;
        result.value.forEach((stream) => {
            if (seen.has(stream.url)) return;
            seen.add(stream.url);
            streams.push({ ...stream, addonName: addons[index].name });
        });
    });

    return { streams, failedAddons, successfulAddons };
}

export async function loadEnabledAddonStreams(
    addons: StremioAddon[],
    loadManifest: (addon: StremioAddon) => Promise<AddonManifest>,
    loadStreams: (addon: StremioAddon) => Promise<PlayableStream[]>
): Promise<AddonStreamLoadResult> {
    const enabled = addons.filter((addon) => addon.enabled);
    const manifests = await Promise.allSettled(enabled.map(async (addon) => ({
        addon,
        manifest: await loadManifest(addon)
    })));
    const streamAddons = manifests.flatMap((result) => (
        result.status === "fulfilled" && result.value.manifest.resources.includes("stream")
            ? [result.value.addon]
            : []
    ));
    const result = await loadAddonStreams(streamAddons, loadStreams);
    return {
        ...result,
        failedAddons: result.failedAddons + manifests.filter((item) => item.status === "rejected").length
    };
}

function getRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function getString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function parseCatalog(value: unknown): StremioCatalog[] {
    const item = getRecord(value);
    const id = getString(item?.id);
    const type = getString(item?.type);
    if (!id || !type) return [];
    return [{
        id,
        type,
        ...(getString(item?.name) ? { name: getString(item?.name) } : {}),
        extra: Array.isArray(item?.extra) ? item.extra.flatMap((value) => {
            const extra = getRecord(value);
            const name = getString(extra?.name);
            return name ? [{ name, ...(extra?.isRequired === true ? { isRequired: true } : {}) }] : [];
        }) : []
    }];
}

function parseUrl(value: string): {
    scheme: string;
    authority: string;
    path: string;
    query: string;
} {
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
