import { expect, test } from "bun:test";
import {
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

test("hides a revealed addon URL on blur or addon toggle", () => {
    const controller = createAddonUrlVisibilityController(() => {});

    controller.toggle();
    expect(controller.hide()).toEqual(getAddonUrlVisibility(false));
    controller.toggle();
    expect(controller.hide()).toEqual(getAddonUrlVisibility(false));
});

test("keeps addon URL visibility controllers isolated per row", () => {
    const first = createAddonUrlVisibilityController(() => {});
    const second = createAddonUrlVisibilityController(() => {});

    first.toggle();
    expect(first.state()).toEqual(getAddonUrlVisibility(true));
    expect(second.state()).toEqual(getAddonUrlVisibility(false));
});
