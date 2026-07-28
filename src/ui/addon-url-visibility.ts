export interface AddonUrlVisibility {
    label: "Reveal" | "Hide";
    ariaHidden: "true" | "false";
    className: string;
}

export function getAddonUrlVisibility(revealed: boolean): AddonUrlVisibility {
    return {
        label: revealed ? "Hide" : "Reveal",
        ariaHidden: revealed ? "false" : "true",
        className: revealed ? "addon-url" : "addon-url is-blurred"
    };
}
