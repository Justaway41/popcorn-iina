# Blurred Addon URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display each configured Stremio manifest URL blurred by default with an explicit, accessible Reveal/Hide control.

**Architecture:** Keep the stored addon model unchanged. Add one pure presentation helper for the two reveal states, then use it in the existing preferences renderer to update a URL text element and its control within each addon row.

**Tech Stack:** TypeScript, Bun tests/build, existing IINA preferences HTML/CSS.

## Global Constraints

- Complete manifest URLs are blurred and `aria-hidden` by default.
- Hover never reveals the URL.
- Only explicit click or keyboard activation reveals a URL.
- Reveal state is per row and resets whenever rows re-render.
- Losing focus from a revealed row's control hides that URL again.
- The URL is plain text, never an editable field, link, tooltip, or accessible label while blurred.
- Stored addon data and stream loading remain unchanged.
- No copy button, edit action, global reveal, dependency, or unrelated refactor.
- Before every commit, verify author and committer are `Justaway41 <kritarthasapkota999@gmail.com>`.

---

### Task 1: Add Blurred URL Rows and Explicit Reveal

**Files:**
- Create: `src/ui/addon-url-visibility.ts`
- Modify: `src/ui/preferences.test.ts`
- Modify: `src/ui/preferences.ts`
- Modify: `xyz.brbc.popcorn.iinaplugin/ui/preferences.html`

**Interfaces:**
- Produces: `getAddonUrlVisibility(revealed: boolean): { label: "Reveal" | "Hide"; ariaHidden: "true" | "false"; className: string }`
- Consumes: existing `StremioAddon.manifestUrl`

- [ ] **Step 1: Write failing state and template tests**

In `src/ui/preferences.test.ts`, import `getAddonUrlVisibility` and add:

```ts
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
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bun test src/ui/preferences.test.ts
```

Expected: FAIL because the helper module and new row controls do not exist.

- [ ] **Step 3: Implement the pure presentation helper**

Create `src/ui/addon-url-visibility.ts`:

```ts
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
```

- [ ] **Step 4: Add the secure-default row structure and styling**

In `xyz.brbc.popcorn.iinaplugin/ui/preferences.html`:

1. Change the help copy to:

```html
Enabled addons are searched together. Private URL details are blurred until you reveal them.
```

2. Add the URL beneath the readable hostname:

```html
<span class="addon-url is-blurred" aria-hidden="true"></span>
```

3. Add a native button before Remove:

```html
<button class="addon-reveal" type="button">Reveal</button>
```

4. Use these styles:

```css
.addon-url {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
}
.addon-url.is-blurred {
    filter: blur(4px);
    user-select: none;
}
.addon-reveal, .addon-remove { padding: 3px 7px; }
```

Set the addon row grid to:

```css
grid-template-columns: auto minmax(0, 1fr) auto auto;
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
bun test src/ui/preferences.test.ts
```

Expected: both tests PASS.

- [ ] **Step 6: Wire per-row reveal and automatic hiding**

In `src/ui/preferences.ts`:

1. Import `getAddonUrlVisibility`.
2. Query `.addon-url` and `.addon-reveal` alongside existing row elements and include them in template validation.
3. Set `url.textContent = addon.manifestUrl`.
4. Add a local function inside the row mapping:

```ts
const setRevealed = (revealed: boolean) => {
    const state = getAddonUrlVisibility(revealed);
    url.className = state.className;
    url.setAttribute("aria-hidden", state.ariaHidden);
    reveal.textContent = state.label;
    reveal.setAttribute("aria-label", `${state.label} URL for ${addon.name}`);
};
```

5. Initialize with `setRevealed(false)`.
6. On Reveal/Hide click, call `setRevealed(url.classList.contains("is-blurred"))`.
7. On the reveal button's `blur` event, call `setRevealed(false)`.

Do not persist reveal state; the existing `render()` replacement naturally resets every row to blurred.

- [ ] **Step 7: Run focused and full verification**

Run:

```bash
bun test src/ui/preferences.test.ts
bun test
bun run typecheck
bun run build
bun run verify:built-client-version
git diff --check
```

Expected: all tests pass, both TypeScript targets pass, build exits 0, built client version is found, and diff check is clean.

- [ ] **Step 8: Verify identity and commit**

Run:

```bash
git config user.name
git config user.email
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
```

Expected: author and committer are `Justaway41 <kritarthasapkota999@gmail.com>`.

Commit only the four listed files:

```bash
git add src/ui/addon-url-visibility.ts src/ui/preferences.test.ts src/ui/preferences.ts xyz.brbc.popcorn.iinaplugin/ui/preferences.html
git commit -m "feat: reveal blurred addon URLs"
```

- [ ] **Step 9: Package for local IINA testing**

Run:

```bash
bun run package
```

Expected: `xyz.brbc.popcorn.iinaplugin.iinaplgz` is rebuilt successfully.
