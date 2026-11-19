---
name: web-rebuild
description: Extract and reverse-engineer a live website's browser-delivered frontend, assets, source maps, and API behavior, then rebuild and verify a runnable local implementation. Use for website reproduction from URLs, DevTools/Playwright inspection, framework detection, or original-versus-local comparison; not for bypassing authentication, paywalls, rate limits, or access controls.
---

# Web Rebuild

## Outcome

Produce a runnable local implementation that is grounded in browser evidence, not screenshot guesswork. Preserve a clear chain of provenance from each recovered file or behavior to the local artifact that uses it.

Use this preference order:

1. Reuse legally available original static files.
2. Recover readable source from source maps when present.
3. Infer structure from runtime DOM, bundles, and network behavior.
4. Generate only the code and assets that remain missing.

If the user only asks to inspect, explain, or estimate effort, stop after evidence collection and analysis. Rebuild only when the request includes implementation.

## Guardrails

- Work only with sites and accounts the user is authorized to reproduce. Do not bypass login, paywalls, CAPTCHA, bot protection, rate limits, encrypted APIs, or access controls.
- Public delivery does not imply redistribution rights. Preserve copyright and license notices, record third-party assets, and flag assets that cannot be safely shipped.
- Treat source maps as possible source, not guaranteed source. Check `sources`, `sourcesContent`, and licensing before claiming recovery.
- Do not replay state-changing requests discovered in DevTools. Capture their method and shape, then replace them with an implementation or a mock explicitly marked as synthetic.
- Do not save cookies, authorization headers, request bodies, personal data, tokens, or secrets in reports or manifests. Redact them before writing evidence to disk.
- Keep discovery read-only and reasonable in rate. Do not crawl the whole site unless the requested scope requires it.
- Do not use recovered code to impersonate a brand, collect credentials, or mislead users. Reproduce the requested experience only for a legitimate development, migration, research, or interoperability purpose.

## Evidence Collection

For a substantial site, start with the resumable full pipeline:

```bash
cd <skill-directory>
npm install

node scripts/reverse_site.mjs \
  --url "https://example.com/" \
  --out web-rebuild-output \
  --max-pages 200 \
  --max-depth 4 \
  --headed
```

This runs the first-page inventory, transitive asset extraction, route crawl, authentication-gate detection, API schema inference, site graph generation, and rebuild planning in one process. `crawl/state.json` makes the run resumable.

Use the focused probe when only one page is in scope:

```bash
node scripts/inventory_site.mjs \
  --url "https://example.com/" \
  --out web-rebuild-output \
  --export-assets \
  --include-third-party \
  --source-maps
```

The script requires Playwright in the active project or an available browser-compatible replacement. If Playwright is unavailable, collect the same evidence through Chrome DevTools, the in-app browser, or computer-use tools. Read [references/browser-evidence.md](references/browser-evidence.md) before changing the collection strategy.

`--include-third-party` is an extraction decision, not a licensing decision. Use it when cross-origin CSS, fonts, or scripts are part of the page, then classify those assets as third-party dependencies before shipping them. The probe follows CSS `url(...)` and `@import` references, records route templates and repeated DOM structures, and compares the initial server response with hydrated content.

After the inventory, sample distinct page families automatically:

```bash
node scripts/sample_routes.mjs \
  --inventory web-rebuild-output \
  --out web-rebuild-output/route-samples \
  --count 6
```

The sampler chooses one safely navigable URL per route template, excludes account and feed routes by default, saves sanitized DOM, screenshots, summaries, and endpoint shapes. Enable account routes only when they are explicitly in scope and use a user-provided authorized session.

Read [references/full-site-reverse.md](references/full-site-reverse.md) for coverage rules, recovery, and completion criteria.

Collect these evidence classes:

- Initial server HTML and hydrated DOM.
- JavaScript, CSS, images, fonts, and other static resources.
- Response and request metadata, endpoint shapes, GraphQL operation names, and status/error behavior.
- Source map references, recovered source names, and available `sourcesContent`.
- Computed styles, CSS custom properties, layout dimensions, and responsive screenshots.
- Console errors, failed requests, framework globals, and route/link inventory.
- Server-rendered content, declared endpoint hints, repeated component-like structures, and transitive CSS assets.

Store evidence under a dedicated output directory so it cannot be mistaken for application source:

```text
web-rebuild-output/
├── source/                 Extracted static resources
├── recovered-sources/      Files reconstructed from source-map content
├── runtime/                DOM, network, style, and framework evidence
├── screenshots/            Reference captures
├── route-samples/          Representative routes, screenshots, and DOM
├── crawl/                  Site graph, coverage, auth gates, APIs, interactions
├── rebuild-plan.json       Deterministic implementation plan
├── rebuild-brief.md        Human-readable route and gap brief
├── inventory.json          Machine-readable summary
└── provenance.json         Source URL to local file mapping
```

## Classify Before Rebuilding

Identify the delivery model from multiple signals: response headers, DOM markers, route behavior, globals, chunk names, and asset structure. Do not classify from one marker alone.

Separate the site framework from its browser libraries. A server-rendered PHP or MACCMS theme can still contain Vue components for a carousel while pages and routes remain server-rendered. Read asset signatures before accepting a one-marker framework result.

Once the stack is clear, read [references/framework-playbooks.md](references/framework-playbooks.md) and use only the matching section. Distinguish:

- Static/server HTML from a hydrated client application.
- Framework bundles from independently deployed microfrontends.
- Published application code from CMS themes, commerce themes, or plugin code.
- Public endpoints from endpoints that operate on the user's authenticated session.

Record each finding as `observed`, `inferred`, or `reconstructed`. Keep the evidence and confidence alongside architectural claims.

## Authentication

Never ask a user to paste a password, one-time code, or session token into chat. When the crawler detects login, read `crawl/auth-requirements.json` and tell the user exactly what the site requests: account/email/phone fields, password, QR login, one-time code, CAPTCHA, or third-party sign-in. Then follow [references/auth-and-sessions.md](references/auth-and-sessions.md).

Use `capture_auth_state.mjs` to open a headed authorized login session and save Playwright storage state after the user completes QR, OTP, CAPTCHA, or password steps manually. Keep that file outside the evidence tree and never commit it. Resume with:

```bash
node scripts/reverse_site.mjs \
  --url "https://example.com/" \
  --out web-rebuild-output \
  --storage-state ".web-rebuild-private/auth-state.json" \
  --max-pages 1000 \
  --resume
```

A login page detected without a usable session is an incomplete run, not a successful anonymous approximation.

## Reverse and Rebuild

Read [references/rebuild-and-verify.md](references/rebuild-and-verify.md) when mapping the application or implementing the local replacement.

Build in this order:

1. Reproduce the page shell, design tokens, layout, and static assets.
2. Recover route topology, component boundaries, and shared state.
3. Map content and behavior to typed local domain models.
4. Reproduce interactions and transitions.
5. Implement backend boundaries as local APIs, deterministic fixtures, or adapters to services the user controls.
6. Replace every unknown with an explicit limitation instead of silently inventing production behavior.

Prefer adapting extracted files into a maintainable local structure over serving an opaque mirrored bundle. Keep an untouched copy of extracted evidence for comparison.

The homepage alone is not a sufficient inventory for a multi-route site. Use `runtime/routes.json` to identify route templates, then sample at least one representative for every in-scope page family: home, content detail, listing/filter, search, account, and playback or application-specific flows. Include pagination, empty results, and error states where observable.

Use `crawl/api-contracts.json` for observed response shapes and `crawl/interaction-map.json` for tabs, filters, dialogs, pagination, playback, account actions, and forms. Generate the implementation brief with:

```bash
node scripts/plan_rebuild.mjs --out web-rebuild-output
```

Read `rebuild-plan.json` and `rebuild-brief.md` before implementation. Treat queued routes, failures, auth gates, and unmapped state-changing controls as incomplete work.

## Verify

Compare the reference and rebuild at identical viewport, locale, route, and timing. Start with the reusable comparison helper:

```bash
node scripts/compare_sites.mjs \
  --reference "https://example.com/" \
  --candidate "http://localhost:3000/" \
  --out web-rebuild-output/verification
```

Then verify the dimensions a screenshot diff cannot cover:

- DOM hierarchy and semantic roles.
- Text content and heading order.
- Layout at desktop and mobile breakpoints.
- Fonts, colors, spacing, borders, shadows, and interaction states.
- Navigation, forms, validation, loading, empty, error, and success states.
- Network contracts and local API behavior.
- Keyboard access, focus visibility, reduced motion, and basic accessibility.

Fix differences in descending user impact: broken behavior, missing content, layout, visual styling, then minor polish. Re-run the comparison after each repair batch.

## Completion Gate

Call the reverse engineering complete only when:

- `crawl/state.json` has no remaining in-scope queue.
- `crawl/unresolved.json` has no unexplained failures or authentication gates.
- Every in-scope route template has representative evidence and a rendered local page.
- Every observed business operation has either a local contract, a user-controlled adapter, or an explicit synthetic fixture.
- Forms, tabs, filters, pagination, dialogs, playback/application controls, loading, empty, error, and responsive states have been exercised or explicitly excluded.
- Asset references resolve locally or are documented external dependencies.
- Original-versus-local verification passes for the agreed route and interaction matrix.

If a requirement is unavailable, stop with an evidence-backed blocker and request the smallest missing input. Do not label an anonymous public scrape as a complete authenticated reconstruction.

## Deliverable

Report:

- The delivered project command and entry URL.
- What was extracted, recovered, inferred, and hand-written.
- Which routes and interactions are verified versus incomplete.
- Third-party assets or content that require licensing review.
- Known backend, authentication, analytics, and edge-case limitations.

Treat unresolved evidence as a limitation. Never represent a visual approximation as an exact source recovery.
