/**
 * What a rejected request actually said. IINA rejects with a plain object rather than an Error,
 * and `String` turns that into "[object Object]" - which was the entire diagnosis a user was
 * shown for a failing sync. Read the fields such an object carries, and fall back to its JSON
 * rather than its type name.
 *
 * Kept free of imports so the global entry, which only wants to format an error, does not pull
 * a sync module into its bundle.
 */
export function describeRejection(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    const record = error && typeof error === "object" && !Array.isArray(error)
        ? error as Record<string, unknown>
        : null;
    if (!record) return String(error);
    const described = ["message", "error", "reason", "description", "localizedDescription"]
        .map((key) => typeof record[key] === "string" ? record[key] as string : "")
        .find((value) => value !== "");
    const status = finite(record.statusCode) ?? finite(record.status);
    const code = typeof record.code === "string" ? record.code : (finite(record.code) ?? "");
    const parts = [
        described ?? "",
        status === null ? "" : `status ${status}`,
        code === "" ? "" : `code ${code}`
    ].filter((part) => part !== "");
    if (parts.length > 0) return parts.join(", ");
    try {
        const json = JSON.stringify(error);
        return json && json !== "{}" ? json.slice(0, 200) : "no reason given";
    } catch {
        return "no reason given";
    }
}

function finite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
