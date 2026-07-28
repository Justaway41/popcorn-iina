import { expect, test } from "bun:test";
import { getAddonUrlVisibility } from "./addon-url-visibility";

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
