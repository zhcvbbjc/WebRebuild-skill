# Browser Evidence

Use this reference when collecting or troubleshooting frontend evidence. The goal is a reproducible evidence set with enough detail to reconstruct the site without storing sensitive session data.

## Preflight

1. Open the target in a clean browser profile. Record viewport, locale, timezone, device scale, URL, and whether the page requires a user-provided session.
2. Capture the response before hydration when possible, then capture the settled DOM after the page reaches a stable visual state.
3. Record redirects, final URL, status, content type, cache headers, content security policy, server technology, and compression.
4. Check `robots.txt` and relevant terms for context, but do not treat them as authorization or as a technical guarantee.
5. Ask before using credentials or interacting with account data. Exclude account pages and personal data unless they are explicitly in scope.

## Browser Capture

Use current-session, read-only browser access. A DevTools or Playwright session observes the exact code and responses delivered to an authorized user, including dynamically inserted assets.

Capture:

- Document HTML before and after hydration.
- `document.documentElement.outerHTML` and a compact DOM/ARIA outline.
- Loaded script, stylesheet, image, font, manifest, and worker URLs.
- Network method, status, MIME type, response headers considered non-sensitive, and redacted request URL shapes.
- Framework globals and hydration data such as Next.js, Nuxt, Remix, Astro, or commerce platform objects.
- Same-origin links and visible route controls.
- Viewport and full-page screenshots at each agreed breakpoint.
- Console errors, unhandled exceptions, failed requests, and service-worker behavior.

Do not capture cookies, authorization headers, password fields, request bodies, or response bodies for authenticated domains by default.

## Source Maps

For each JavaScript or CSS resource:

1. Read the final `sourceMappingURL` directive.
2. Resolve relative URLs against the asset URL.
3. Fetch the map only when it is accessible in the same authorized session.
4. Parse `version`, `file`, `sourceRoot`, `sources`, `sourcesContent`, and `names`.
5. Preserve source names even when source content is absent.
6. Record whether content was embedded, downloaded separately, or unavailable.

Do not decompile minified bundles into exact original code from `mappings` alone. Code recovered from `sourcesContent` is evidence; a plausible reconstruction from readable chunks is inference.

When source paths use schemes such as `webpack://`, strip the scheme only for local storage. Keep the original source name in `provenance.json`. Prevent path traversal and collisions in the local tree.

## API Discovery

Group requests by consumer and purpose instead of listing every URL:

- Document and route data.
- Component or search APIs.
- GraphQL operations and fragments.
- Commerce/cart/account APIs.
- Authentication and session endpoints.
- Analytics, experimentation, error reporting, and tracking.
- Media, font, asset, and CDN delivery.

For each useful endpoint, record:

- Method, redacted URL pattern, and operation name.
- Request and response field shapes with sample values removed.
- Status codes and observed error envelopes.
- Caching, pagination, sorting, filtering, and concurrency behavior.
- Whether the call is safe to replay. Assume any non-GET call is unsafe until proven otherwise.

Infer schemas from several successful and unsuccessful examples. Mark optional fields and uncertain unions rather than overfitting one response.

## Dynamic and Protected Sites

- Wait for explicit content markers or a stable network state; fixed sleeps are only a fallback.
- Scroll or interact only when needed to reveal lazily loaded public content, and restore the page afterward.
- Treat bot challenges and anti-automation pages as evidence that automation cannot proceed. Do not solve or evade them.
- If content varies by location, account, experiment, or device, capture that context and compare under the same conditions.
- Service workers can hide requests from normal network logging. Inspect registrations and caches, but do not execute unknown worker code outside the browser sandbox.

## Evidence Quality

Keep these labels separate:

- `observed`: directly present in delivered HTML, assets, source maps, styles, or network traffic.
- `inferred`: concluded from multiple runtime signals or partial code.
- `reconstructed`: written locally because original implementation was unavailable.

A high-fidelity comparison can still coexist with a low-confidence implementation. State both.
