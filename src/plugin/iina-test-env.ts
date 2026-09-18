/**
 * The IINA global, enough of it for a unit test. Plugin modules read `iina` when they load -
 * `utils` destructures its console - so this has to be in place before they are imported, which
 * is what importing this module for its side effect first does.
 */
const environment = globalThis as Record<string, unknown>;

if (!environment.iina) {
    environment.iina = {
        console: { log() {}, warn() {}, error() {} },
        preferences: { get() { return undefined; }, set() {}, sync() {} }
    };
}

export {};
