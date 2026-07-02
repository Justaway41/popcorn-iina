declare global {
    namespace IINA {
        interface IINAGlobal {
            postMessage(name: string, data: unknown): void;
            onMessage(name: string, callback: (data: unknown) => void): void;
        }
    }
}

export {};
