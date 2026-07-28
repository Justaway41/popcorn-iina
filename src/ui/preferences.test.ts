import { expect, test } from "bun:test";
import {
    bindAddonUrlVisibility,
    createAddonUrlVisibilityController,
    getAddonUrlVisibility
} from "./addon-url-visibility";

const preferencesHtml = await Bun.file(
    new URL("../../xyz.brbc.popcorn.iinaplugin/ui/preferences.html", import.meta.url)
).text();

test("links Trakt account and API app creation from preferences", () => {
    expect(preferencesHtml).toContain('href="https://app.trakt.tv/"');
    expect(preferencesHtml).toContain('href="https://trakt.tv/oauth/applications"');
    expect(preferencesHtml.match(/target="_blank"/g)).toHaveLength(2);
    expect(preferencesHtml.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
});

test("keeps addon URLs private until explicitly revealed", () => {
    expect(getAddonUrlVisibility(false)).toEqual({
        label: "Reveal",
        ariaHidden: "true",
        className: "addon-url is-blurred"
    });
    expect(getAddonUrlVisibility(true)).toEqual({
        label: "Hide",
        ariaHidden: "false",
        className: "addon-url"
    });
});

test("defines a private addon URL and reveal control in each row", () => {
    expect(preferencesHtml).toContain(
        '<span class="addon-url is-blurred" aria-hidden="true"></span>'
    );
    expect(preferencesHtml).toContain('class="addon-reveal"');
});

test("toggles an addon URL and focuses before revealing it", () => {
    let controller = createAddonUrlVisibilityController(() => {
        expect(controller.state()).toEqual(getAddonUrlVisibility(false));
    });

    expect(controller.toggle()).toEqual(getAddonUrlVisibility(true));
    expect(controller.toggle()).toEqual(getAddonUrlVisibility(false));
});

test("reveals on bound click after focusing and hides on bound blur", () => {
    const reveal = new EventTarget();
    const enabled = new EventTarget();
    const events: string[] = [];
    const controller = createAddonUrlVisibilityController(() => events.push("focus"));
    bindAddonUrlVisibility(reveal, enabled, controller, (state) => {
        events.push(state.label);
    }, () => {});

    reveal.dispatchEvent(new Event("click"));
    expect(events).toEqual(["focus", "Hide"]);
    reveal.dispatchEvent(new Event("blur"));
    expect(controller.state()).toEqual(getAddonUrlVisibility(false));
    expect(events).toEqual(["focus", "Hide", "Reveal"]);
});

test("hides before the bound enabled-toggle callback", () => {
    const reveal = new EventTarget();
    const enabled = new EventTarget();
    const controller = createAddonUrlVisibilityController(() => {});
    let applied = getAddonUrlVisibility(false);
    bindAddonUrlVisibility(reveal, enabled, controller, (state) => {
        applied = state;
    }, () => {
        expect(applied).toEqual(getAddonUrlVisibility(false));
    });

    reveal.dispatchEvent(new Event("click"));
    enabled.dispatchEvent(new Event("change"));
    expect(controller.state()).toEqual(getAddonUrlVisibility(false));
});

test("keeps addon URL visibility controllers isolated per row", () => {
    const first = createAddonUrlVisibilityController(() => {});
    const second = createAddonUrlVisibilityController(() => {});

    first.toggle();
    expect(first.state()).toEqual(getAddonUrlVisibility(true));
    expect(second.state()).toEqual(getAddonUrlVisibility(false));
});
