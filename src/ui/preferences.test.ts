import { expect, test } from "bun:test";
import {
    bindAddonUrlVisibility,
    createAddonUrlVisibilityController,
    getAddonUrlVisibility
} from "./addon-url-visibility";

const preferencesHtml = await Bun.file(
    new URL("../../xyz.brbc.popcorn.iinaplugin/ui/preferences.html", import.meta.url)
).text();
const preferencesSource = await Bun.file(new URL("./preferences.ts", import.meta.url)).text();

test("uses IINA's preference-page API from window", () => {
    expect(preferencesSource).toContain("window.iina");
    expect(preferencesSource).not.toContain("const preferences = iina.preferences");
});

test("relays Trakt links through IINA's native browser opener", () => {
    expect(preferencesHtml).toContain('href="https://trakt.tv/join"');
    expect(preferencesHtml).toContain('href="https://app.trakt.tv/settings/apps/api"');
    expect(preferencesHtml.match(/data-external-url/g)).toHaveLength(2);
    expect(preferencesHtml).not.toContain('target="_blank"');
    expect(preferencesHtml.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
    expect(preferencesSource).toContain('preferences.set("externalLinkRequest"');
    expect(preferencesSource).not.toContain("window.open(");
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

test("offers TMDB and Anime Kitsu presets with capability badges", () => {
    expect(preferencesHtml).toContain('data-url="https://94c8cb9f702d-tmdb-addon.baby-beamup.club/manifest.json"');
    expect(preferencesHtml).toContain('data-url="https://anime-kitsu.strem.fun/manifest.json"');
    expect(preferencesHtml).toContain('class="addon-capabilities"');
    expect(preferencesSource).toContain("manifest?.resources");
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
