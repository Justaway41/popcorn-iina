/**
 * JSON over IINA's HTTP API. Kept apart from the plugin entry so the modules that only need
 * to fetch something do not have to reach into it.
 */

export function safeJson(value: unknown): unknown {
    if (typeof value !== "string") return value ?? null;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

export interface JsonClient {
    getJson(url: string): Promise<unknown>;
    postJson(url: string, body: unknown): Promise<unknown>;
}

export function createJsonClient(http: IINA.API.HTTP): JsonClient {
    const read = (response: { statusCode: number; data?: unknown; text?: string }): unknown => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(`Request failed with HTTP ${response.statusCode}.`);
        }
        const data = safeJson(response.data ?? response.text);
        if (data === null) throw new Error("Response was not valid JSON.");
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
