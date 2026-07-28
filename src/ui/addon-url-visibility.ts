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

export function bindAddonUrlVisibility(
    reveal: EventTarget,
    enabled: EventTarget,
    controller: AddonUrlVisibilityController,
    setVisibility: (state: AddonUrlVisibility) => void,
    onEnabledChange: () => void
): void {
    reveal.addEventListener("click", () => setVisibility(controller.toggle()));
    reveal.addEventListener("blur", () => setVisibility(controller.hide()));
    enabled.addEventListener("change", () => {
        setVisibility(controller.hide());
        onEnabledChange();
    });
}
