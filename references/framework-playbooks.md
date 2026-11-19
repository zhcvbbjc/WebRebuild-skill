# Framework Playbooks

Read only the section that matches the evidence. A site can use several systems at once, such as Next.js for the storefront and Shopify for commerce APIs.

## MACCMS, Apple CMS, or PHP Media Theme

Signals: routes such as `/voddetail/`, `/vodtype/`, `/vodshow/`, `/vodsearch/`, `/artdetail-*`, theme paths such as `/mxtheme/`, and JavaScript referencing `window.maccms`.

Approach:

- Treat the server response as the primary layout and content source; do not classify the site as an SPA solely because a Vue, Swiper, or jQuery component is present.
- Map route templates and pagination before rebuilding. Sample a detail page and a listing page in addition to the homepage.
- Extract the theme CSS, global CSS variables, icon fonts, image paths, carousel markup, card/listing markup, search form, and player container.
- Separate theme code from generic libraries such as jQuery, Layui, Swiper, analytics, traffic diversion, and injected advertising.
- Inspect form actions and declared endpoint attributes. Observe AJAX only when a safe public interaction triggers it.
- Replace server-rendered data with local content models or a local API; do not assume a visible homepage contains every backend contract.
- Validate search, filters, pagination, hover/focus states, lazy images, responsive navigation, and player/error states independently.

## Next.js

Signals: `/_next/static/` chunks, `__NEXT_DATA__`, `__next_f`, App Router payloads, `x-nextjs-*` headers, route segments, and React hydration.

Approach:

- Capture server HTML and client-rendered DOM separately.
- Inventory `/_next/static/` JavaScript and CSS; map route chunks to routes.
- Treat page and layout payloads as data contracts, not stable public APIs.
- Identify Server Actions and route handlers from network calls; do not replay mutations.
- Distinguish static output, ISR, SSR, and client-only behavior.
- Rebuild reusable layouts and route boundaries only after extracting shared chunks and CSS tokens.

## Nuxt

Signals: `/_nuxt/` assets, `__NUXT__`, `__NUXT_DATA__`, Nuxt payload files, Nitro headers, Vue hydration, and server API routes.

Approach:

- Capture the initial payload and the hydrated Vue tree.
- Separate server routes, Nitro endpoints, composables, and client-only modules.
- Inventory fonts, CSS layers, and app config exposed in payloads.
- Check whether route rules produce static, cached, or server-rendered pages.
- Recreate data composables and server endpoints as explicit local boundaries.

## React or Vue SPA

Signals: a minimal root HTML document, large shared chunks, client-side history, React/Vue runtime globals, and route manifests.

Approach:

- Capture the empty shell and several hydrated routes.
- Find the route table in source maps, chunk names, or navigation behavior.
- Separate shared design-system code from page chunks.
- Observe lazy chunks while navigating; collect each route only within the approved scope.
- Derive state from URL, storage keys, and observable behavior without dumping private storage values.

## Astro or Islands

Signals: `astro-island`, `astro-slot`, `/_astro/` assets, static HTML with isolated component hydration, and framework-specific island metadata.

Approach:

- Preserve the final static HTML as the primary content and layout evidence.
- Identify isolated interactive components and their hydration props.
- Avoid converting the whole site to a client-rendered app unless the requested implementation requires it.
- Use the generated CSS asset graph to recover scoped component styles.

## Remix, React Router, or Hydrogen

Signals: `__remixContext`, route modules, loader/action request patterns, server route manifests, and commerce SDK globals.

Approach:

- Map route modules, loaders, actions, and nested outlet structure.
- Separate document and data requests; preserve redirect and error behavior.
- Treat commerce session/cart operations as sensitive and implement them locally or through user-controlled credentials.
- Recover shared route layout before individual page content.

## Angular

Signals: `ng-version`, `_ngcontent-*`, Angular chunks, router globals, and zone/main bundles.

Approach:

- Inspect component boundaries through DOM scoping attributes and source-map paths.
- Map route configuration and lazy modules from bundles or navigation chunks.
- Recover services and RxJS flows from source maps before rewriting.
- Reproduce change detection only where observable behavior requires it.

## SvelteKit

Signals: `_app/` assets, `data-sveltekit-*`, Svelte hydration markers, and server route payloads.

Approach:

- Capture route data payloads and hydrated DOM separately.
- Map `+page`, `+layout`, and server endpoints from source-map names when available.
- Preserve progressive enhancement behavior rather than assuming JavaScript-only rendering.

## WordPress

Signals: `/wp-content/`, `/wp-includes/`, REST API links, theme/plugin assets, and generator metadata.

Approach:

- Inventory theme CSS, template HTML, block markup, plugin scripts, and REST endpoints.
- Separate theme code from third-party plugins; do not redistribute premium plugins or licensed theme assets without permission.
- Recreate editable content through local data or a CMS if requested.
- Preserve public semantics and responsive behavior even when replacing the CMS runtime.

## Shopify or Other Commerce Themes

Signals: Shopify CDN/theme assets, `Shopify.theme`, `/cart.js`, product JSON endpoints, and checkout redirects.

Approach:

- Inventory theme CSS, sections, snippets, and storefront scripts.
- Observe product, collection, cart, search, and localization data contracts.
- Rebuild the storefront shell and public pages locally; replace checkout and account flows with mocks unless authorized credentials and endpoints are in scope.
- Do not copy the checkout or collect payment data. Do not imply affiliation with the original merchant.

## Unknown or Hybrid Stack

Fall back to delivery behavior:

- Whether meaningful content exists before JavaScript.
- Which assets load on first paint versus navigation.
- Which host owns each chunk and endpoint.
- Whether multiple roots, microfrontends, iframes, or web components compose the page.

When evidence is insufficient, label the stack unknown and build from the observable page rather than forcing a framework guess.
