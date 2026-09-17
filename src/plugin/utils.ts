import { DEBUG_LOGS, POPCORN_SPLASH_CANDIDATES } from "./constants";

const { console } = iina;

export function getSplashUrl(): string {
    for (const candidate of POPCORN_SPLASH_CANDIDATES) {
        try {
            if (iina.file.exists(candidate)) return candidate;
        } catch (error) {
            logDebug("Popcorn: Splash check failed:", error);
        }
    }
    return POPCORN_SPLASH_CANDIDATES[0];
}

export function isHttpUrl(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return normalized.startsWith("https://") || normalized.startsWith("http://");
}

export function sanitizeMediaTitle(title: string): string {
    return String(title).replace(/[\n\r,=]/g, " ");
}

export function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function logDebug(...args: unknown[]): void {
    if (DEBUG_LOGS) console.log(...args);
}
