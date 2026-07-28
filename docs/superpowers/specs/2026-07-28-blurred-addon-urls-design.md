# Blurred Addon URLs Design

## Goal

Let users recognize and inspect each configured Stremio manifest URL without exposing credential-bearing paths by default.

## Addon Row

- Keep the addon name and hostname readable.
- Add the complete canonical manifest URL on a second line with a CSS blur applied by default.
- Add a compact **Reveal** button beside Remove.
- Reveal only after an explicit click or keyboard activation; hover never reveals private data.
- While revealed, change the button label to **Hide** and its accessible label to include the addon name.
- Hide the URL again when the reveal control loses focus or the user presses **Hide**.
- Each addon row manages its own reveal state. Toggling, removing, or re-rendering rows returns URLs to blurred.

## Security and Accessibility

- Keep the URL as text, not an editable field or link.
- Do not place the complete URL in `title`, `aria-label`, or other hover/assistive metadata while blurred.
- The blurred element is `aria-hidden` until revealed, preventing assistive technology from reading secrets unexpectedly.
- The Reveal/Hide control is a native button with a visible keyboard focus state.
- Stored addon data and stream-loading behavior remain unchanged.

## Testing

- The row template contains the URL and Reveal control.
- Rendering assigns the canonical URL while keeping it blurred and hidden from assistive technology.
- Reveal/Hide state changes only for the activated row and resets after re-render.
- Existing addon parsing, persistence, and stream tests continue to pass.
- Run all tests, typecheck, build, and package.

## Deliberate Omissions

- No hover-to-reveal.
- No copying, editing, or opening the URL.
- No global reveal-all setting.
- No new dependency.
