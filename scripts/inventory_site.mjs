#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STATIC_MIME_PATTERN =
  /^(?:text\/css|text\/javascript|application\/(?:javascript|json|manifest\+json|font-[^;]+|x-font-[^;]+)|image\/|font\/)/i;
const TEXT_ASSET_PATTERN =
  /^(?:text\/css|text\/javascript|application\/(?:javascript|json|manifest\+json))/i;
const SAFE_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-encoding",
  "content-language",
  "content-length",
  "content-type",
  "etag",
  "last-modified",
  "server",
  "vary",
  "via",
  "nitro-cache",
  "x-nextjs-cache",
  "x-nextjs-prerender",
  "x-nitro-renderer",
  "x-powered-by",
  "x-vercel-cache",
]);
const SAFE_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
]);
const SECRET_PATTERN =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk_live_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function usage() {
  return `Usage:
  node inventory_site.mjs --url <https://...> [options]

Options:
  --out <dir>                 Output directory (default: web-rebuild-output)
  --wait <ms>                 Settle time after network idle (default: 1500)
  --timeout <ms>              Navigation timeout (default: 45000)
  --headed                    Show the browser
  --channel <name>            Installed browser channel: chrome or msedge
  --full-page                 Save a full-page screenshot
  --export-assets             Download first-page JS/CSS/images/fonts
  --include-third-party       Export third-party static resources too
  --source-maps               Discover and save available source maps
  --extract-source-content    Write safe sourcesContent into recovered-sources/
  --max-asset-mb <number>     Per-asset download cap (default: 12)
  --help                      Show this help

Environment:
  Playwright must be installed in the current project or globally.
  The script never captures cookies, authorization headers, or request bodies.`;
}

function parseArgs(argv) {
  const args = {
    url: "",
    out: path.resolve("web-rebuild-output"),
    wait: 1500,
    timeout: 45000,
    headed: false,
    channel: "",
    fullPage: false,
    exportAssets: false,
    includeThirdParty: false,
    sourceMaps: false,
    extractSourceContent: false,
    maxAssetMb: 12,
    help: false,
  };

  const stringFlags = new Map([
    ["--url", "url"],
    ["--out", "out"],
    ["--wait", "wait"],
    ["--timeout", "timeout"],
    ["--max-asset-mb", "maxAssetMb"],
    ["--channel", "channel"],
  ]);
  const booleanFlags = new Map([
    ["--headed", "headed"],
    ["--full-page", "fullPage"],
    ["--export-assets", "exportAssets"],
    ["--include-third-party", "includeThirdParty"],
    ["--source-maps", "sourceMaps"],
    ["--extract-source-content", "extractSourceContent"],
    ["--help", "help"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (booleanFlags.has(flag)) {
      args[booleanFlags.get(flag)] = true;
      continue;
    }
    if (stringFlags.has(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      args[stringFlags.get(flag)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }

  for (const key of ["wait", "timeout", "maxAssetMb"]) {
    args[key] = Number(args[key]);
    if (!Number.isFinite(args[key]) || args[key] < 0) {
      throw new Error(`Invalid numeric value for --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    }
  }
  args.out = path.resolve(args.out);
  return args;
}

function ensureHttpUrl(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http:// and https:// URLs are supported");
  }
  url.username = "";
  url.password = "";
  return url;
}

function redactedUrl(raw) {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    url.searchParams.set(key, "<redacted>");
  }
  return url.href;
}

function redactedHeaders(headers, allowlist) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    if (allowlist.has(key) && typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

async function loadPlaywright() {
  const projectRequire = createRequire(pathToFileURL(path.join(process.cwd(), "package.json")));
  for (const packageName of ["playwright", "playwright-core"]) {
    try {
      return projectRequire(packageName);
    } catch {
      // Try the next package source.
    }
  }
  for (const packageName of ["playwright", "playwright-core"]) {
    try {
      return await import(packageName);
    } catch {
      // Try the next package source.
    }
  }
  throw new Error(
    "Playwright is not available. Run `npm install` in the web-rebuild skill directory or collect the same evidence with Chrome DevTools/computer use.",
  );
}

async function launchChromium(browserType, { headless, channel }) {
  const attempts = channel
    ? [{ headless, channel }]
    : [{ headless }, { headless, channel: "chrome" }, { headless, channel: "msedge" }];
  let lastError;
  for (const options of attempts) {
    try {
      return await browserType.launch(options);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Could not launch Chromium. Install Playwright browsers or use --channel chrome. ${lastError?.message || ""}`.trim(),
  );
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sanitizeSegment(segment) {
  let value = segment.replace(/[\x00-\x1f<>:"|?*]/g, "_").trim();
  if (!value || value === "." || value === "..") value = "_";
  if (WINDOWS_RESERVED.test(value)) value = `_${value}`;
  return value.slice(0, 140);
}

function extensionFor(url, mimeType = "") {
  const pathname = new URL(url).pathname;
  const extension = path.extname(pathname);
  if (extension && extension.length <= 10) return sanitizeSegment(extension);
  const mime = mimeType.split(";")[0].trim().toLowerCase();
  const known = {
    "application/javascript": ".js",
    "application/json": ".json",
    "application/manifest+json": ".webmanifest",
    "application/x-font-ttf": ".ttf",
    "application/wasm": ".wasm",
    "font/otf": ".otf",
    "font/ttf": ".ttf",
    "font/woff": ".woff",
    "font/woff2": ".woff2",
    "image/avif": ".avif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "image/x-icon": ".ico",
    "text/css": ".css",
    "text/javascript": ".js",
  };
  return known[mime] || "";
}

function localAssetPath(assetUrl, root) {
  const url = new URL(assetUrl);
  const isSameOrigin = url.origin === root.origin;
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return sanitizeSegment(decodeURIComponent(segment));
      } catch {
        return sanitizeSegment(segment);
      }
    });
  if (segments.length === 0) segments.push("index");
  const filename = segments.at(-1);
  if (!path.extname(filename)) {
    segments[segments.length - 1] = `${filename}${extensionFor(assetUrl)}`;
  }
  const base = isSameOrigin ? ["source"] : ["source", "_third-party", sanitizeSegment(url.hostname)];
  return path.join(...base, ...segments);
}

function normalizePathname(pathname) {
  return pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, "/:uuid")
    .replace(/\/\d{4,}(?=\/|$)/g, "/:id")
    .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, "/:token");
}

function endpointKey(record) {
  const url = new URL(record.url);
  return `${record.method} ${url.host}${normalizePathname(url.pathname)}`;
}

function summarizeEndpoints(records) {
  const groups = new Map();
  for (const record of records) {
    if (!["xhr", "fetch"].includes(record.resourceType)) continue;
    const key = endpointKey(record);
    if (!groups.has(key)) {
      const url = new URL(record.url);
      groups.set(key, {
        method: record.method,
        host: url.host,
        pathPattern: normalizePathname(url.pathname),
        operationNames: [],
        statuses: [],
        contentTypes: [],
        count: 0,
      });
    }
    const group = groups.get(key);
    group.count += 1;
    if (record.status != null && !group.statuses.includes(record.status)) {
      group.statuses.push(record.status);
    }
    const mime = record.responseHeaders?.["content-type"]?.split(";")[0];
    if (mime && !group.contentTypes.includes(mime)) group.contentTypes.push(mime);
    const operationName = new URL(record.url).searchParams.get("operationName");
    if (operationName && !group.operationNames.includes(operationName)) {
      group.operationNames.push(operationName);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function htmlTextLength(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

function deliveryMode(rawHtml, hydratedTextLength) {
  const initialTextLength = htmlTextLength(rawHtml);
  if (initialTextLength >= 500 && initialTextLength >= hydratedTextLength * 0.55) {
    return {
      mode: "server-rendered",
      confidence: "high",
      initialTextLength,
      hydratedTextLength,
      reason: "Meaningful page text is present in the initial server response.",
    };
  }
  if (initialTextLength < 250 && hydratedTextLength >= 500) {
    return {
      mode: "client-rendered",
      confidence: "medium",
      initialTextLength,
      hydratedTextLength,
      reason: "The initial response is a shell; meaningful text appears after browser execution.",
    };
  }
  return {
    mode: "hybrid-or-undetermined",
    confidence: "low",
    initialTextLength,
    hydratedTextLength,
    reason: "Both server HTML and browser execution contribute meaningful content.",
  };
}

function routeTemplate(rawUrl) {
  const pathname = new URL(rawUrl).pathname
    .replace(/\/voddetail\/[^/]+\.html$/i, "/voddetail/:id.html")
    .replace(/\/vodtype\/[^/]+\.html$/i, "/vodtype/:id.html")
    .replace(/\/vodshow\/[^/]+\.html$/i, "/vodshow/:filter.html")
    .replace(/\/vodsearch\/[^/]+\.html$/i, "/vodsearch/:query.html")
    .replace(/\/artdetail-[^/]+\.html$/i, "/artdetail-:id.html")
    .replace(/\/arttype\/[^/]+\.html$/i, "/arttype/:id.html")
    .replace(/\/topicdetail-[^/]+\.html$/i, "/topicdetail-:id.html")
    .replace(/\/label\/[^/]+\.html$/i, "/label/:slug.html")
    .replace(/\/user\/[^/]+\.html$/i, "/user/:page.html")
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, "/:uuid")
    .replace(/\/\d{4,}(?=\/|$)/g, "/:id");
  return pathname || "/";
}

function summarizeRoutes(links) {
  const groups = new Map();
  for (const link of links) {
    if (!link.internal || !link.href || /<redacted>/i.test(link.href)) continue;
    let url;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }
    if (/\/(?:logout|login|register)(?:[/.?]|$)/i.test(url.pathname)) continue;
    const pattern = routeTemplate(url.href);
    if (!groups.has(pattern)) {
      groups.set(pattern, {
        pattern,
        count: 0,
        sampleUrls: [],
        sampleLabels: [],
      });
    }
    const group = groups.get(pattern);
    group.count += 1;
    if (group.sampleUrls.length < 3 && !group.sampleUrls.includes(redactedUrl(url.href))) {
      group.sampleUrls.push(redactedUrl(url.href));
      group.sampleLabels.push(link.text);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
}

function cssAssetUrls(text, baseUrl) {
  const urls = new Set();
  const ignore = (value) =>
    !value ||
    /^(?:data:|blob:|about:|javascript:|mailto:|tel:|#)/i.test(value) ||
    /\$\{|\{\{|<redacted>/i.test(value);
  for (const match of String(text).matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    if (!ignore(match[2])) {
      try {
        urls.add(new URL(match[2], baseUrl).href);
      } catch {
        // Ignore malformed CSS URLs.
      }
    }
  }
  for (const match of String(text).matchAll(/@import\s+(?:url\(\s*)?(["']?)([^"')\s]+)\1/gi)) {
    if (!ignore(match[2])) {
      try {
        urls.add(new URL(match[2], baseUrl).href);
      } catch {
        // Ignore malformed imports.
      }
    }
  }
  return [...urls];
}

function detectFramework(evidence) {
  const html = evidence.html || "";
  const scripts = evidence.scriptUrls.join("\n");
  const headers = evidence.responseHeaders || {};
  const globals = evidence.globals || {};
  const assets = evidence.assetText || "";
  const candidates = {
    "MACCMS / Apple CMS theme": [
      ["window.maccms in delivered JavaScript", /window\.maccms|\bmaccms\b/i.test(assets)],
      ["MACCMS media routes", /\/(?:voddetail|vodtype|vodshow|vodsearch)\//i.test(html)],
      ["theme asset path", /\/mxtheme\//i.test(html + scripts)],
    ],
    "Next.js": [
      ["script path /_next/", scripts.includes("/_next/")],
      ["__NEXT_DATA__", globals.nextData],
      ["App Router flight data", globals.nextFlight],
      ["x-nextjs response header", headers["x-nextjs-cache"] || headers["x-nextjs-prerender"]],
    ],
    Nuxt: [
      ["script path /_nuxt/", scripts.includes("/_nuxt/")],
      ["Nuxt payload global", globals.nuxt || globals.nuxtData],
      ["Nitro response header", headers["x-nitro-renderer"] || headers["nitro-cache"]],
    ],
    "React Router / Remix": [
      ["__remixContext", globals.remix],
      ["remix route marker", /data-remix|__remixManifest/i.test(html)],
      ["router data marker", /__reactRouterContext|react-router/i.test(html)],
    ],
    Astro: [
      ["Astro island marker", /astro-island|astro-slot/i.test(html)],
      ["script path /_astro/", scripts.includes("/_astro/")],
      ["Astro generator", /<meta[^>]+name=["']generator["'][^>]+Astro/i.test(html)],
    ],
    "SvelteKit": [
      ["SvelteKit data attribute", /data-sveltekit-/i.test(html)],
      ["script path /_app/", scripts.includes("/_app/")],
      ["Svelte hydration marker", /svelte-[a-z0-9_-]+/i.test(html)],
    ],
    Angular: [
      ["ng-version", /ng-version=/i.test(html)],
      ["Angular scoped content", /_ngcontent-/i.test(html)],
      ["Angular global", globals.angularVersion],
    ],
    Shopify: [
      ["Shopify global", globals.shopify],
      ["Shopify CDN", scripts.includes("cdn.shopify.com")],
      ["Shopify theme asset", /\/cdn\/shop\/t\//i.test(html + scripts)],
    ],
    WordPress: [
      ["wp-content path", /\/wp-content\//i.test(html + scripts)],
      ["wp-includes path", /\/wp-includes\//i.test(html + scripts)],
      ["WordPress REST link", /\/wp-json\//i.test(html)],
    ],
    React: [
      ["React root marker", /data-reactroot|__REACT_DEVTOOLS_GLOBAL_HOOK__/i.test(html)],
      ["React runtime global", globals.react],
    ],
    Vue: [
      ["Vue data marker", /data-v-[a-f0-9]{6,}/i.test(html)],
      ["Vue global", globals.vue],
    ],
  };

  const ranked = Object.entries(candidates)
    .map(([name, tests]) => {
      const reasons = tests.filter(([, active]) => Boolean(active)).map(([reason]) => reason);
      return { name, score: reasons.length, reasons };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  const libraries = [];
  const libraryTests = [
    ["jQuery", /\bjQuery\b|\$\.ajax|\$\(document\)/i.test(assets)],
    ["Swiper", /\bSwiper\b|swiper-wrapper/i.test(html + assets)],
    ["Layui", /\blayui\b|layui-layer/i.test(html + assets)],
    ["Vue.js", /\bVue\b|createApp\(|data-v-[a-f0-9]{6,}/i.test(html + assets)],
    ["React", /\bReact\b|createRoot\(|data-reactroot/i.test(html + assets)],
  ];
  for (const [name, active] of libraryTests) {
    if (active) libraries.push(name);
  }

  return {
    primary: ranked[0]?.name || "Unknown",
    confidence: ranked[0]
      ? ranked[0].score >= 3
        ? "high"
        : ranked[0].score === 2
          ? "medium"
          : "low"
      : "unknown",
    candidates: ranked,
    libraries,
  };
}

async function collectPageEvidence(page) {
  return page.evaluate(() => {
    const compact = (value, length = 160) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, length);
    const safePath = (raw) => {
      if (!raw) return "";
      try {
        const url = new URL(raw, location.href);
        url.username = "";
        url.password = "";
        url.hash = "";
        for (const key of [...url.searchParams.keys()]) {
          url.searchParams.set(key, "<redacted>");
        }
        return url.href;
      } catch {
        return "";
      }
    };

    const computedProperties = [
      "display",
      "position",
      "boxSizing",
      "width",
      "height",
      "minWidth",
      "maxWidth",
      "margin",
      "padding",
      "gap",
      "gridTemplateColumns",
      "gridTemplateRows",
      "flexDirection",
      "alignItems",
      "justifyContent",
      "color",
      "backgroundColor",
      "backgroundImage",
      "fontFamily",
      "fontSize",
      "fontWeight",
      "fontStyle",
      "lineHeight",
      "letterSpacing",
      "textTransform",
      "border",
      "borderRadius",
      "boxShadow",
      "opacity",
      "overflow",
      "transition",
      "transform",
      "zIndex",
    ];
    const selectors = [
      "html",
      "body",
      "header",
      "nav",
      "main",
      "footer",
      "h1",
      "h2",
      "h3",
      "p",
      "a",
      "button",
      "input",
      "select",
      "textarea",
      "[role=button]",
      "section",
    ];
    const computedStyles = [];
    for (const selector of selectors) {
      let count = 0;
      for (const element of document.querySelectorAll(selector)) {
        if (count >= 60) break;
        const style = getComputedStyle(element);
        const item = {
          selector,
          tag: element.tagName.toLowerCase(),
          text: compact(element.innerText || element.getAttribute("aria-label") || "", 100),
          rect: {
            x: Math.round(element.getBoundingClientRect().x),
            y: Math.round(element.getBoundingClientRect().y),
            width: Math.round(element.getBoundingClientRect().width),
            height: Math.round(element.getBoundingClientRect().height),
          },
          style: {},
        };
        for (const property of computedProperties) item.style[property] = style[property];
        computedStyles.push(item);
        count += 1;
      }
    }

    const customProperties = {};
    const rootStyle = getComputedStyle(document.documentElement);
    for (const property of rootStyle) {
      if (property.startsWith("--") && Object.keys(customProperties).length < 1000) {
        customProperties[property] = rootStyle.getPropertyValue(property).trim();
      }
    }

    const links = [];
    const seenLinks = new Set();
    for (const anchor of document.querySelectorAll("a[href]")) {
      const href = safePath(anchor.getAttribute("href"));
      if (!href || seenLinks.has(href) || links.length >= 500) continue;
      seenLinks.add(href);
      links.push({
        text: compact(anchor.innerText || anchor.getAttribute("aria-label"), 120),
        href,
        internal: (() => {
          try {
            return new URL(href).origin === location.origin;
          } catch {
            return false;
          }
        })(),
      });
    }

    const forms = [...document.querySelectorAll("form")].slice(0, 50).map((form) => ({
      action: safePath(form.getAttribute("action")),
      method: (form.getAttribute("method") || "get").toLowerCase(),
      fields: [...form.querySelectorAll("input, select, textarea")].slice(0, 100).map((field) => ({
        tag: field.tagName.toLowerCase(),
        type: field.getAttribute("type") || "",
        name: field.getAttribute("name") || "",
        placeholder: compact(field.getAttribute("placeholder"), 100),
        required: field.hasAttribute("required"),
        disabled: field.hasAttribute("disabled"),
        autocomplete: field.getAttribute("autocomplete") || "",
      })),
    }));

    const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
      .slice(0, 300)
      .map((heading) => ({
        level: Number(heading.tagName.slice(1)),
        text: compact(heading.innerText || heading.textContent, 200),
      }));

    const images = [...document.images].slice(0, 500).map((image) => ({
      src: safePath(image.currentSrc || image.src),
      alt: compact(image.alt, 200),
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      loading: image.loading,
    }));

    const repeatedStructures = [];
    const structureCounts = new Map();
    let inspectedElements = 0;
    for (const element of document.querySelectorAll("article,section,div,ul,ol,li,a")) {
      if (inspectedElements >= 5000) break;
      inspectedElements += 1;
      const classes = [...element.classList].filter((name) => name.length <= 80).slice(0, 3).sort();
      const signature = `${element.tagName.toLowerCase()}${classes.map((name) => `.${name}`).join("")}`;
      if (!structureCounts.has(signature)) {
        structureCounts.set(signature, {
          signature,
          count: 0,
          sampleText: compact(element.innerText, 120),
        });
      }
      structureCounts.get(signature).count += 1;
    }
    for (const entry of [...structureCounts.values()].sort((a, b) => b.count - a.count)) {
      if (entry.count >= 3 && repeatedStructures.length < 30) repeatedStructures.push(entry);
    }

    const endpointHints = new Set();
    for (const element of document.querySelectorAll("[data-endpoint],[data-api],[data-url]")) {
      for (const name of ["data-endpoint", "data-api", "data-url"]) {
        const value = element.getAttribute(name);
        if (value) endpointHints.add(safePath(value));
      }
    }
    const inlineScriptText = [...document.scripts]
      .filter((script) => !script.src)
      .map((script) => script.textContent || "")
      .join("\n");
    for (const match of inlineScriptText.matchAll(/["'`]((?:https?:\/\/|\/)[^"'`\s<>]{3,300})["'`]/g)) {
      const value = match[1];
      if (/(?:\/api\/|ajax|routing|search|detail|play|user|list|ajax)/i.test(value)) {
        endpointHints.add(safePath(value));
      }
      if (endpointHints.size >= 80) break;
    }

    const scriptUrls = [...document.scripts]
      .map((script) => script.src)
      .filter(Boolean)
      .map(safePath);
    const stylesheetUrls = [...document.querySelectorAll('link[rel~="stylesheet"][href]')]
      .map((link) => link.href)
      .map(safePath);

    return {
      page: {
        url: safePath(location.href),
        title: document.title,
        lang: document.documentElement.lang,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        visibleTextLength: compact(document.body?.innerText || "", 100000).length,
        scroll: {
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        },
        headings,
        links,
      },
      computedStyles,
      customProperties,
      forms,
      images,
      repeatedStructures,
      endpointHints: [...endpointHints].filter(Boolean),
      scriptUrls,
      stylesheetUrls,
      globals: {
        nextData: Boolean(window.__NEXT_DATA__),
        nextFlight: Boolean(window.__next_f),
        nuxt: Boolean(window.__NUXT__),
        nuxtData: Boolean(window.__NUXT_DATA__),
        remix: Boolean(window.__remixContext),
        react: Boolean(window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__),
        vue: Boolean(window.Vue || window.__VUE__),
        angularVersion: document.querySelector("[ng-version]")?.getAttribute("ng-version") || "",
        shopify: Boolean(window.Shopify),
      },
    };
  });
}

async function sanitizedDom(page) {
  return page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true);
    const sensitiveName =
      /(?:pass(?:word)?|secret|token|auth|session|cookie|csrf|xsrf|api[-_]?key|credit|card|cvv)/i;

    for (const element of clone.querySelectorAll("script")) {
      if (element.textContent) element.textContent = "";
    }
    for (const element of clone.querySelectorAll("input")) {
      const type = (element.getAttribute("type") || "").toLowerCase();
      if (type === "hidden" || type === "password" || sensitiveName.test(element.name || "")) {
        element.remove();
      } else {
        element.removeAttribute("value");
      }
    }
    for (const element of clone.querySelectorAll("textarea")) element.textContent = "";
    for (const element of clone.querySelectorAll("option[selected]")) {
      element.removeAttribute("selected");
    }
    for (const element of clone.querySelectorAll("*")) {
      for (const attribute of [...element.attributes]) {
        if (sensitiveName.test(attribute.name)) {
          element.removeAttribute(attribute.name);
          continue;
        }
        if (["href", "src", "action", "poster"].includes(attribute.name.toLowerCase())) {
          try {
            const url = new URL(attribute.value, location.href);
            url.username = "";
            url.password = "";
            url.hash = "";
            for (const key of [...url.searchParams.keys()]) {
              url.searchParams.set(key, "<redacted>");
            }
            element.setAttribute(attribute.name, url.href);
          } catch {
            element.removeAttribute(attribute.name);
          }
        }
        if (attribute.name.toLowerCase() === "srcset") {
          element.removeAttribute(attribute.name);
        }
      }
    }
    for (const meta of clone.querySelectorAll("meta[content]")) {
      const marker = `${meta.getAttribute("name") || ""} ${meta.getAttribute("property") || ""}`;
      if (sensitiveName.test(marker)) meta.removeAttribute("content");
    }
    return `<!doctype html>\n${clone.outerHTML}`;
  });
}

async function exportStaticAssets({
  candidates,
  context,
  root,
  outDir,
  includeThirdParty,
  maxBytes,
  seenUrls = new Set(),
  usedPaths = new Set(),
}) {
  const files = [];
  const warnings = [];
  const textAssets = [];
  let totalBytes = 0;

  for (const candidate of candidates) {
    const url = new URL(candidate.url);
    if (seenUrls.has(url.href)) continue;
    seenUrls.add(url.href);
    if (!["http:", "https:"].includes(url.protocol)) continue;
    if (!includeThirdParty && url.origin !== root.origin) continue;

    try {
      const response = await context.request.get(candidate.url, {
        failOnStatusCode: false,
        timeout: 30000,
        maxRedirects: 5,
      });
      if (!response.ok()) {
        warnings.push(`Skipped ${redactedUrl(candidate.url)}: HTTP ${response.status()}`);
        continue;
      }
      const declaredLength = Number(response.headers()["content-length"] || 0);
      if (declaredLength > maxBytes) {
        warnings.push(`Skipped ${redactedUrl(candidate.url)}: content-length exceeds cap`);
        continue;
      }
      const body = await response.body();
      if (body.length > maxBytes) {
        warnings.push(`Skipped ${redactedUrl(candidate.url)}: body exceeds cap`);
        continue;
      }
      if (totalBytes + body.length > maxBytes * 20) {
        warnings.push("Stopped asset export after reaching the aggregate safety cap");
        break;
      }
      totalBytes += body.length;

      let relativePath = localAssetPath(candidate.url, root);
      if (usedPaths.has(relativePath)) {
        const extension = path.extname(relativePath);
        relativePath = relativePath.slice(0, -extension.length || undefined);
        relativePath = `${relativePath}-${sha256(Buffer.from(candidate.url)).slice(0, 8)}${extension}`;
      }
      usedPaths.add(relativePath);
      const absolutePath = path.join(outDir, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, body);
      files.push({
        sourceUrl: redactedUrl(candidate.url),
        localPath: relativePath.replaceAll("\\", "/"),
        contentType: response.headers()["content-type"] || candidate.mimeType || "",
        bytes: body.length,
        sha256: sha256(body),
      });
      if (TEXT_ASSET_PATTERN.test(response.headers()["content-type"] || candidate.mimeType || "")) {
        textAssets.push({
          url: candidate.url,
          contentType: response.headers()["content-type"] || candidate.mimeType || "",
          body,
        });
      }
    } catch (error) {
      warnings.push(`Asset failed ${redactedUrl(candidate.url)}: ${error.message}`);
    }
  }
  return { files, warnings, textAssets };
}

function sourceMapReference(text) {
  const matches = [
    ...String(text).matchAll(/sourceMappingURL\s*=\s*([^\s*]+)/g),
  ];
  return matches.at(-1)?.[1]?.trim() || "";
}

function safeSourcePath(sourceName, fallback) {
  let value = String(sourceName || fallback)
    .replace(/^[a-z]+:\/+/i, "")
    .replace(/^\/+/, "")
    .split(/[?#]/, 1)[0];
  const parts = value
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .map(sanitizeSegment);
  if (parts.length === 0) parts.push("source");
  return path.join(...parts);
}

async function recoverSourceMaps({
  assets,
  context,
  outDir,
  extractSourceContent,
}) {
  const maps = [];
  const warnings = [];
  let recoveredBytes = 0;
  let mapIndex = 0;

  for (const asset of assets) {
    if (!TEXT_ASSET_PATTERN.test(asset.contentType || "")) continue;
    let body;
    try {
      const response = await context.request.get(asset.sourceUrl, {
        failOnStatusCode: false,
        timeout: 30000,
        maxRedirects: 5,
      });
      if (!response.ok()) continue;
      body = await response.body();
    } catch {
      continue;
    }

    const reference = sourceMapReference(body.toString("utf8"));
    if (!reference) continue;
    mapIndex += 1;
    const mapRecord = {
      assetUrl: redactedUrl(asset.sourceUrl),
      sourceMappingURL: reference.startsWith("data:") ? "<inline-source-map>" : reference,
      mapUrl: "",
      available: false,
      sourceCount: 0,
      sourcesWithContent: 0,
      recoveredSources: [],
      note: "",
    };

    try {
      let mapJson;
      if (reference.startsWith("data:")) {
        const comma = reference.indexOf(",");
        if (comma < 0) throw new Error("Malformed inline source map");
        const header = reference.slice(0, comma);
        const payload = reference.slice(comma + 1);
        const text = header.includes(";base64")
          ? Buffer.from(payload, "base64").toString("utf8")
          : decodeURIComponent(payload);
        mapJson = JSON.parse(text);
        mapRecord.mapUrl = `inline:${mapIndex}`;
      } else {
        const mapUrl = new URL(reference, asset.sourceUrl);
        mapRecord.mapUrl = redactedUrl(mapUrl.href);
        const response = await context.request.get(mapUrl.href, {
          failOnStatusCode: false,
          timeout: 30000,
          maxRedirects: 5,
        });
        if (!response.ok()) {
          mapRecord.note = `Source map unavailable: HTTP ${response.status()}`;
          maps.push(mapRecord);
          continue;
        }
        mapJson = await response.json();
        const mapBody = Buffer.from(JSON.stringify(mapJson, null, 2));
        const mapFile = path.join(
          outDir,
          "runtime",
          "sourcemaps",
          `${String(mapIndex).padStart(3, "0")}-${sha256(Buffer.from(mapUrl.href)).slice(0, 10)}.map`,
        );
        await mkdir(path.dirname(mapFile), { recursive: true });
        await writeFile(mapFile, mapBody);
        mapRecord.localPath = path.relative(outDir, mapFile).replaceAll("\\", "/");
      }

      mapRecord.available = true;
      mapRecord.sourceCount = Array.isArray(mapJson.sources) ? mapJson.sources.length : 0;
      const sources = Array.isArray(mapJson.sources) ? mapJson.sources : [];
      const contents = Array.isArray(mapJson.sourcesContent) ? mapJson.sourcesContent : [];
      mapRecord.sourcesWithContent = contents.filter((content) => typeof content === "string").length;
      mapRecord.sources = sources.slice(0, 2000).map((source, index) => ({
        name: String(source),
        hasContent: typeof contents[index] === "string",
      }));

      if (extractSourceContent) {
        const used = new Set();
        for (let index = 0; index < contents.length; index += 1) {
          const content = contents[index];
          if (typeof content !== "string") continue;
          if (SECRET_PATTERN.test(content)) {
            warnings.push(
              `Skipped potentially sensitive recovered source ${String(sources[index] || index)}`,
            );
            continue;
          }
          const bytes = Buffer.byteLength(content);
          if (recoveredBytes + bytes > 50 * 1024 * 1024) {
            warnings.push("Stopped source recovery after reaching the 50 MB safety cap");
            break;
          }
          let relativePath = safeSourcePath(sources[index], `source-${index}`);
          if (used.has(relativePath)) {
            const extension = path.extname(relativePath);
            relativePath = relativePath.slice(0, -extension.length || undefined);
            relativePath = `${relativePath}-${index}${extension}`;
          }
          used.add(relativePath);
          const localPath = path.join(
            outDir,
            "recovered-sources",
            String(mapIndex).padStart(3, "0"),
            relativePath,
          );
          await mkdir(path.dirname(localPath), { recursive: true });
          await writeFile(localPath, content, "utf8");
          recoveredBytes += bytes;
          mapRecord.recoveredSources.push({
            name: String(sources[index] || index),
            localPath: path.relative(outDir, localPath).replaceAll("\\", "/"),
            bytes,
          });
        }
      }
    } catch (error) {
      mapRecord.note = `Source map could not be read: ${error.message}`;
    }
    maps.push(mapRecord);
  }
  return { maps, warnings };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.url) throw new Error(`--url is required\n\n${usage()}`);
  const inputUrl = ensureHttpUrl(args.url);
  const maxBytes = Math.round(args.maxAssetMb * 1024 * 1024);
  const playwright = await loadPlaywright();
  const browserType = playwright.chromium || playwright.default?.chromium;
  if (!browserType) throw new Error("Playwright did not expose a Chromium browser");

  await mkdir(path.join(args.out, "runtime"), { recursive: true });
  await mkdir(path.join(args.out, "screenshots"), { recursive: true });
  await mkdir(path.join(args.out, "source"), { recursive: true });
  await mkdir(path.join(args.out, "recovered-sources"), { recursive: true });

  const startedAt = new Date().toISOString();
  const browser = await launchChromium(browserType, {
    headless: !args.headed,
    channel: args.channel,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: "en-US",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const networkByRequest = new Map();
  const consoleEntries = [];
  const pageErrors = [];

  page.on("request", (request) => {
    networkByRequest.set(request, {
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      requestHeaders: redactedHeaders(request.headers(), SAFE_REQUEST_HEADERS),
      status: null,
      responseHeaders: {},
      failure: "",
    });
  });
  page.on("response", (response) => {
    const record = networkByRequest.get(response.request());
    if (!record) return;
    record.status = response.status();
    record.responseHeaders = redactedHeaders(response.headers(), SAFE_RESPONSE_HEADERS);
    record.mimeType = response.headers()["content-type"] || "";
  });
  page.on("requestfailed", (request) => {
    const record = networkByRequest.get(request);
    if (record) record.failure = request.failure()?.errorText || "request failed";
  });
  page.on("console", (message) => {
    if (consoleEntries.length >= 500) return;
    consoleEntries.push({
      type: message.type(),
      text: message.text().slice(0, 4000),
    });
  });
  page.on("pageerror", (error) => {
    if (pageErrors.length >= 100) return;
    pageErrors.push(String(error).slice(0, 4000));
  });

  try {
    const navigation = await page.goto(inputUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: args.timeout,
    });
    await page
      .waitForLoadState("networkidle", { timeout: Math.max(5000, args.timeout / 2) })
      .catch(() => {});
    await page.waitForTimeout(args.wait);
    const finalUrl = ensureHttpUrl(page.url());

    let serverHtml = "";
    let serverResponse = {
      status: null,
      contentType: "",
      bytes: 0,
      title: "",
      textLength: 0,
      formCount: 0,
      scriptSrcCount: 0,
      stylesheetCount: 0,
    };
    try {
      const rawResponse = await context.request.get(inputUrl.href, {
        failOnStatusCode: false,
        timeout: args.timeout,
        maxRedirects: 5,
      });
      serverHtml = await rawResponse.text();
      serverResponse = {
        status: rawResponse.status(),
        contentType: rawResponse.headers()["content-type"] || "",
        bytes: Buffer.byteLength(serverHtml),
        title: /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(serverHtml)?.[1]?.trim() || "",
        textLength: htmlTextLength(serverHtml),
        formCount: (serverHtml.match(/<form\b/gi) || []).length,
        scriptSrcCount: (serverHtml.match(/<script\b[^>]*\bsrc\s*=/gi) || []).length,
        stylesheetCount: (serverHtml.match(/<link\b[^>]*\brel\s*=\s*["'][^"']*stylesheet/gi) || []).length,
      };
    } catch (error) {
      serverResponse.error = error.message;
    }

    const pageEvidence = await collectPageEvidence(page);
    const finalHtml = await sanitizedDom(page);
    const network = [...networkByRequest.values()].map((record) => ({
      method: record.method,
      url: redactedUrl(record.url),
      resourceType: record.resourceType,
      requestHeaders: record.requestHeaders,
      status: record.status,
      responseHeaders: record.responseHeaders,
      mimeType: record.mimeType || "",
      failure: record.failure,
    }));
    const endpoints = summarizeEndpoints([...networkByRequest.values()]);
    let framework = detectFramework({
      html: finalHtml,
      scriptUrls: pageEvidence.scriptUrls,
      responseHeaders: navigation ? redactedHeaders(navigation.headers(), SAFE_RESPONSE_HEADERS) : {},
      globals: pageEvidence.globals,
    });
    const rendering = deliveryMode(serverHtml, pageEvidence.page.visibleTextLength);
    framework = { ...framework, delivery: rendering.mode };
    const routes = summarizeRoutes(pageEvidence.page.links);

    await writeFile(path.join(args.out, "runtime", "dom.html"), finalHtml, "utf8");
    await writeJson(path.join(args.out, "runtime", "page.json"), pageEvidence.page);
    await writeJson(path.join(args.out, "runtime", "server-response.json"), serverResponse);
    await writeJson(path.join(args.out, "runtime", "routes.json"), routes);
    await writeJson(path.join(args.out, "runtime", "repeated-structures.json"), {
      repeatedStructures: pageEvidence.repeatedStructures,
      declaredEndpointHints: pageEvidence.endpointHints,
    });
    await writeJson(path.join(args.out, "runtime", "network.json"), {
      requests: network,
      endpoints,
    });
    await writeJson(path.join(args.out, "runtime", "computed-styles.json"), {
      computedStyles: pageEvidence.computedStyles,
      customProperties: pageEvidence.customProperties,
    });
    await writeJson(path.join(args.out, "runtime", "forms.json"), pageEvidence.forms);
    await writeJson(path.join(args.out, "runtime", "images.json"), pageEvidence.images);
    await writeJson(path.join(args.out, "runtime", "console.json"), {
      console: consoleEntries,
      pageErrors,
    });

    await page.screenshot({
      path: path.join(args.out, "screenshots", "viewport.png"),
      type: "png",
    });
    if (args.fullPage) {
      await page.screenshot({
        path: path.join(args.out, "screenshots", "full-page.png"),
        type: "png",
        fullPage: true,
      });
    }

    const candidates = [...networkByRequest.values()].filter((record) => {
      if (record.status !== 200 || !record.mimeType) return false;
      return STATIC_MIME_PATTERN.test(record.mimeType);
    });
    const uniqueCandidates = [
      ...new Map(candidates.map((candidate) => [candidate.url, candidate])).values(),
    ];

    let exportResult = { files: [], warnings: [], textAssets: [] };
    if (args.exportAssets) {
      const seenAssetUrls = new Set();
      const usedAssetPaths = new Set();
      let pendingCandidates = uniqueCandidates;
      for (let round = 0; round < 4 && pendingCandidates.length > 0; round += 1) {
        const roundResult = await exportStaticAssets({
          candidates: pendingCandidates,
          context,
          root: finalUrl,
          outDir: args.out,
          includeThirdParty: args.includeThirdParty,
          maxBytes,
          seenUrls: seenAssetUrls,
          usedPaths: usedAssetPaths,
        });
        exportResult.files.push(...roundResult.files);
        exportResult.warnings.push(...roundResult.warnings);
        exportResult.textAssets.push(...roundResult.textAssets);

        const referencedUrls = new Set();
        for (const asset of roundResult.textAssets) {
          if (!asset.contentType.toLowerCase().includes("css")) continue;
          for (const referenced of cssAssetUrls(asset.body.toString("utf8"), asset.url)) {
            referencedUrls.add(referenced);
          }
        }
        if (round === 0) {
          const inlineCss = [
            finalHtml,
            ...Object.values(pageEvidence.customProperties || {}),
          ].join("\n");
          for (const referenced of cssAssetUrls(inlineCss, finalUrl.href)) {
            referencedUrls.add(referenced);
          }
        }
        pendingCandidates = [...referencedUrls]
          .filter((url) => !seenAssetUrls.has(url))
          .filter((url) => args.includeThirdParty || new URL(url).origin === finalUrl.origin)
          .map((url) => ({
            url,
            status: 200,
            mimeType: "",
          }));
      }
    }

    const assetText = exportResult.textAssets
      .map((asset) => asset.body.toString("utf8", 0, Math.min(asset.body.length, 2 * 1024 * 1024)))
      .join("\n")
      .slice(0, 12 * 1024 * 1024);
    framework = detectFramework({
      html: finalHtml,
      scriptUrls: pageEvidence.scriptUrls,
      responseHeaders: navigation ? redactedHeaders(navigation.headers(), SAFE_RESPONSE_HEADERS) : {},
      globals: pageEvidence.globals,
      assetText,
    });
    framework = { ...framework, delivery: rendering.mode };
    await writeJson(path.join(args.out, "runtime", "technology.json"), framework);

    let sourceMapResult = { maps: [], warnings: [] };
    if (args.sourceMaps) {
      sourceMapResult = await recoverSourceMaps({
        assets: uniqueCandidates,
        context,
        outDir: args.out,
        extractSourceContent: args.extractSourceContent,
      });
    }

    let robots = null;
    try {
      const robotsUrl = new URL("/robots.txt", finalUrl);
      const robotsResponse = await context.request.get(robotsUrl.href, {
        failOnStatusCode: false,
        timeout: 15000,
      });
      robots = {
        url: redactedUrl(robotsUrl.href),
        status: robotsResponse.status(),
        contentType: robotsResponse.headers()["content-type"] || "",
      };
    } catch {
      // robots.txt is contextual evidence, not a requirement.
    }

    const warnings = [
      ...exportResult.warnings,
      ...sourceMapResult.warnings,
      ...pageErrors.map((error) => `Page error: ${error}`),
    ];
    if (!args.includeThirdParty) {
      const omittedCritical = uniqueCandidates.filter((candidate) => {
        const mime = candidate.mimeType || "";
        return (
          new URL(candidate.url).origin !== finalUrl.origin &&
          /(?:css|javascript)/i.test(mime)
        );
      }).length;
      if (omittedCritical > 0) {
        warnings.push(
          `${omittedCritical} cross-origin script/style resource(s) were inventoried but not exported. Review ownership and rerun with --include-third-party if they are part of the page.`,
        );
      }
    }
    const inventory = {
      schemaVersion: 1,
      tool: "web-rebuild/inventory_site",
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - Date.parse(startedAt),
      inputUrl: redactedUrl(inputUrl.href),
      finalUrl: redactedUrl(finalUrl.href),
      viewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
      framework,
      page: {
        title: pageEvidence.page.title,
        lang: pageEvidence.page.lang,
        visibleTextLength: pageEvidence.page.visibleTextLength,
        headings: pageEvidence.page.headings.length,
        links: pageEvidence.page.links.length,
        forms: pageEvidence.forms.length,
        images: pageEvidence.images.length,
        scrollWidth: pageEvidence.page.scroll.width,
        scrollHeight: pageEvidence.page.scroll.height,
      },
      serverResponse,
      rendering,
      counts: {
        networkRequests: network.length,
        endpoints: endpoints.length,
        routeTemplates: routes.length,
        repeatedStructures: pageEvidence.repeatedStructures.length,
        declaredEndpointHints: pageEvidence.endpointHints.length,
        staticResources: uniqueCandidates.length,
        exportedAssets: exportResult.files.length,
        sourceMaps: sourceMapResult.maps.length,
        recoveredSources: sourceMapResult.maps.reduce(
          (total, map) => total + map.recoveredSources.length,
          0,
        ),
      },
      endpoints,
      routeTemplates: routes.slice(0, 30),
      repeatedStructures: pageEvidence.repeatedStructures,
      declaredEndpointHints: pageEvidence.endpointHints,
      robots,
      warnings,
      evidenceFiles: [
        "runtime/dom.html",
        "runtime/page.json",
        "runtime/server-response.json",
        "runtime/routes.json",
        "runtime/repeated-structures.json",
        "runtime/network.json",
        "runtime/computed-styles.json",
        "runtime/forms.json",
        "runtime/images.json",
        "runtime/console.json",
        "runtime/technology.json",
        "screenshots/viewport.png",
      ],
    };
    const provenance = {
      schemaVersion: 1,
      generatedAt: inventory.generatedAt,
      inputUrl: inventory.inputUrl,
      finalUrl: inventory.finalUrl,
      exportedAssets: exportResult.files,
      sourceMaps: sourceMapResult.maps,
      labels: {
        observed: "Directly present in delivered HTML, assets, styles, source maps, or network traffic.",
        inferred: "Concluded from multiple runtime signals or partial code.",
        reconstructed: "Written locally because original implementation was unavailable.",
      },
      retentionNotice:
        "Session cookies, authorization headers, request bodies, and form values are intentionally excluded.",
    };
    await writeJson(path.join(args.out, "inventory.json"), inventory);
    await writeJson(path.join(args.out, "provenance.json"), provenance);

    console.log(
      JSON.stringify(
        {
          out: args.out,
          framework,
          counts: inventory.counts,
          warnings: warnings.length,
          next:
            "Read runtime/technology.json, then the matching framework playbook. Review inventory.json before rebuilding.",
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`inventory_site: ${error.stack || error.message}`);
  process.exitCode = 1;
});
