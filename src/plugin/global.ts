import { applySplashIcon, formatError, getSplashUrl, logDebug } from "./utils";

const { console, global, menu } = iina;

applySplashIcon();
let activePlayerId: number | string | null = null;

function playerIdsMatch(a: number | string, b: number | string): boolean {
    return String(a).split("-")[0] === String(b).split("-")[0];
}

global.onMessage("playerReady", (_data, playerId) => {
    if (playerId !== undefined && playerId !== null) activePlayerId = playerId;
});

global.onMessage("playerClosed", (_data, playerId) => {
    if (playerId !== undefined && playerId !== null && activePlayerId !== null && playerIdsMatch(playerId, activePlayerId)) {
        activePlayerId = null;
    }
});

async function showPopcorn(): Promise<void> {
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
    showPopcorn().catch((error) => console.error(`Popcorn: Menu action failed: ${formatError(error)}`));
}, { keyBinding: "Shift+p" }));

logDebug("Popcorn: Global entry loaded");
