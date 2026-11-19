# Rebuild and Verify

Use this reference after evidence collection. The target is a maintainable local implementation with explicit provenance and verifiable behavior.

## Architecture Map

Create a compact map before writing application code:

- Routes and their loading conditions.
- Shared layouts, navigation, and design tokens.
- Component hierarchy with evidence sources.
- State owned by URL, server data, local client state, and persistent storage.
- API endpoints, data schemas, and state transitions.
- Assets with licensing or hotlink restrictions.

Annotate every non-obvious item as `observed`, `inferred`, or `reconstructed`.

## Local Project

Keep evidence and implementation separate. A practical layout is:

```text
web-rebuild-output/   Evidence and comparison artifacts
app/                  Local implementation
```

Reuse extracted assets through an explicit manifest or design-token layer instead of scattering CDN URLs. Retain file hashes and source URLs in a generated provenance file.

Implement in dependency order:

1. Runtime, build, and test baseline.
2. Page shell, typography, colors, and responsive grid.
3. Shared layout and route system.
4. Static content and media.
5. Interactive components and state transitions.
6. Local data/API adapters.
7. Edge states and accessibility.

If the mirrored frontend is a single minified bundle, use it only as temporary behavioral evidence. Extract or reconstruct maintainable source before extending the app.

## Backend Replacement

Choose the narrowest implementation that preserves observed behavior:

- Static JSON or typed local data for read-only content.
- A small local API for filtering, pagination, validation, or mutations.
- An adapter to a service the user controls for authentication or commerce.
- Fixtures with explicit synthetic labels when the behavior cannot be reproduced safely.

Use observed response shapes as contracts. Add validation at boundaries and test malformed, empty, unauthorized, and server-error cases only when their behavior was observed or the local design requires a deliberate equivalent.

Never embed recovered API keys, private tokens, session cookies, or private endpoint credentials in client code.

## Visual Fidelity

Compare under identical conditions:

- Same route, viewport, device scale, locale, timezone, and reduced-motion setting.
- Same wait condition and data fixtures.
- Same font state. Detect fallback-font flashes separately from settled layout.
- Stable animations disabled or paused for pixel comparison.

Automated comparison should mask time-dependent carousel, slider, marquee, and ticker regions; a self-comparison of the same URL should not report those regions as visual regressions. Verify their content and controls separately.

Capture at least:

- Mobile around 390 CSS pixels wide.
- Tablet around 768 CSS pixels wide when the site has a distinct breakpoint.
- Desktop around 1440 CSS pixels wide.

Patch in this order:

1. Missing or incorrect content.
2. Structural and responsive layout.
3. Typography metrics.
4. Color, borders, shadows, and spacing.
5. Motion and micro-interactions.

Do not tune a screenshot by adding one-off pixel offsets before checking inherited font, line-height, box sizing, grid, and spacing values.

## Behavior Verification

For each important interaction, verify:

- Initial, hover, focus, active, disabled, loading, empty, error, and success states.
- Keyboard and pointer behavior.
- URL and history changes.
- Scroll locking, overlays, focus trapping, and escape behavior.
- Form validation and data submission boundaries.
- Responsive navigation and touch target sizes.
- Reduced motion and basic screen-reader semantics.

Record actual results rather than checking only that a code path exists.

Run representative checks for every discovered route template, not only the homepage. A shared shell should be verified once, while route-specific content, metadata, empty states, pagination, and controls need their own evidence.

## Iteration Loop

1. Run the comparison against the current reference.
2. Group differences by shared cause.
3. Fix the highest-impact cause.
4. Re-run the affected routes and states.
5. Update the fidelity report.

Stop when agreed route and interaction coverage passes, or when blocked by unavailable assets, authentication, or licensing. Preserve unresolved evidence and request direction instead of fabricating certainty.
