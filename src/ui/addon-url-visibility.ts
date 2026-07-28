export interface AddonUrlVisibility {
    label: "Reveal" | "Hide";
    ariaHidden: "true" | "false";
    className: string;
}

export interface AddonUrlVisibilityController {
    state(): AddonUrlVisibility;
    toggle(): AddonUrlVisibility;
    hide(): AddonUrlVisibility;
}

export function getAddonUrlVisibility(revealed: boolean): AddonUrlVisibility {
    return {
        label: revealed ? "Hide" : "Reveal",
        ariaHidden: revealed ? "false" : "true",
        className: revealed ? "addon-url" : "addon-url is-blurred"
    };
}

export function createAddonUrlVisibilityController(
    focusReveal: () => void
): AddonUrlVisibilityController {
    let revealed = false;
    const state = () => getAddonUrlVisibility(revealed);

    return {
        state,
        toggle() {
            if (!revealed) focusReveal();
            revealed = !revealed;
            return state();
        },
        hide() {
            revealed = false;
            return state();
        }
    };
}
