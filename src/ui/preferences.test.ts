import { expect, test } from "bun:test";

const preferencesHtml = await Bun.file(
    new URL("../../xyz.brbc.popcorn.iinaplugin/ui/preferences.html", import.meta.url)
).text();

test("links Trakt account and API app creation from preferences", () => {
    expect(preferencesHtml).toContain('href="https://app.trakt.tv/"');
    expect(preferencesHtml).toContain('href="https://trakt.tv/oauth/applications"');
    expect(preferencesHtml.match(/target="_blank"/g)).toHaveLength(2);
    expect(preferencesHtml.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
});
