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

export function applySplashIcon(): void {
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
