import { expect, test } from "bun:test";
import { createIinaTransport } from "./trakt";

test("normalizes IINA HTTP responses and request headers", async () => {
    const calls: unknown[] = [];
    const http = {
        async get(url: string, options: unknown) {
            calls.push(["GET", url, options]);
            return {
                statusCode: 200,
                data: [{ progress: 10 }],
                text: "",
                reason: "ok"
            };
        }
    };

    const response = await createIinaTransport(http as never)(
        "GET",
        "https://api.trakt.tv/sync/playback",
        null,
        { Authorization: "Bearer token" }
    );

    expect(response.status).toBe(200);
    expect(response.data).toEqual([{ progress: 10 }]);
    expect(calls[0]).toEqual([
        "GET",
        "https://api.trakt.tv/sync/playback",
        { params: {}, headers: { Authorization: "Bearer token" }, data: null }
    ]);
});
