# Full-Site Reverse Engineering

Use this reference for sites with multiple route families, authentication, APIs, or application-like behavior.

## One-Shot Pipeline

`reverse_site.mjs` orchestrates:

1. `inventory_site.mjs` for first-page runtime, assets, styles, source maps, and technology.
2. `crawl_site.mjs` for resumable route discovery, page evidence, auth gates, API schemas, site graph, and interaction inventory.
3. `plan_rebuild.mjs` for page families, implementation phases, coverage gaps, and verification scope.

The output is evidence, not proof that an exact clone is complete. Completion is determined by coverage and observed behavior, not by elapsed runtime.

## Coverage Model

Prioritize:

1. Seed/landing route.
2. Authentication and account entry points.
3. One current detail page for each content type.
4. One listing/filter page for each content type.
5. Search success, empty result, and malformed query.
6. Pagination first, middle, and last page when discoverable.
7. Playback, application, editor, checkout, or other core task flows.
8. Modal, tab, filter, sort, and responsive variants.
9. Error, unauthorized, not-found, loading, and partial-data states.

Exclude infinite calendars, tracking parameters, duplicate sort permutations, and unbounded user-generated query spaces unless they represent distinct layouts.

Canonicalize URLs by:

- Removing fragments and tracking parameters.
- Removing token-like query parameters.
- Sorting remaining query keys.
- Deduplicating trailing slashes.
- Grouping dynamic IDs into route templates.

Keep enough examples per template to observe state variation. Do not equate "the same template rendered 100 times" with "100 separate implementations."

## Resumability

`crawl/state.json` contains the queue, visited URLs, failures, auth gates, and edges. Use `--resume` after:

- Completing an authorized login.
- Raising `--max-pages` or `--max-depth`.
- Fixing a transient network failure.
- Adding a missing in-scope route.

Do not delete state while evidence is incomplete.

## Authentication and Account Scope

A successful anonymous crawl is not equivalent to a successful authenticated crawl. When account routes are in scope:

- Keep them excluded until the user authorizes access.
- Detect login fields and challenge types.
- Complete authentication manually in a headed browser.
- Reuse the saved session rather than handling raw credentials.
- Verify that protected routes actually render authenticated content.

Account routes can expose personal data. Capture structure and behavior rather than storing personal values. Review the `crawl/auth-requirements.json` and `crawl/unresolved.json` outputs after resuming.

## API Contracts

The crawler stores response structure only:

- HTTP method and redacted URL pattern.
- Status and content type.
- Field names and types.
- Array item shape.
- Sensitive field names replaced with `<sensitive-field>`.

It does not store request bodies, response values, cookies, or authorization headers. Extend contract coverage only through safe public reads or explicitly authorized interactions.

State-changing observations should be recorded as:

- Trigger and precondition.
- Validation and loading states.
- Request method and field shape.
- Success, conflict, authorization, and server-error behavior.
- Local implementation decision: local mutation, controlled adapter, or synthetic fixture.

Never replay a production mutation merely to learn its response.

## Interaction Inventory

`crawl/interaction-map.json` groups visible controls by route template and intent:

- Navigation.
- Tab or filter.
- Pagination.
- Dialog or menu.
- Playback.
- Account or mutation.
- State-changing submit.
- Unknown.

`autoCaptureSafe` is triage only. Clicking a navigation or filter control can still trigger analytics, lazy writes, or production actions. Exercise only interactions required by scope and record their preconditions and side effects.

For each important interaction, capture before and after:

- URL.
- Visible text and key DOM state.
- Expanded/selected values.
- Relevant UI screenshot.
- Network metadata and sanitized schema.
- Loading and error states.

## Media and External Boundaries

Media manifests, streaming endpoints, DRM, checkout providers, CAPTCHA, and third-party sign-in are boundaries, not normal frontend assets.

- Record the integration surface and user-visible behavior.
- Do not bypass DRM, access control, payment, or anti-bot mechanisms.
- Use local fixtures or a user-controlled provider for reconstruction.
- Keep player controls, subtitles, quality menus, errors, and resume behavior in the validation matrix where lawful and authorized.

## Evidence Gaps

`crawl/unresolved.json` is the authoritative worklist. A run is incomplete when it contains:

- Remaining in-scope queue.
- Authentication gates.
- Request failures.
- A reached page/depth cap with more discovered work.
- Route families without successful samples.
- Key interactions that were never exercised.

Report these instead of silently shrinking scope.
