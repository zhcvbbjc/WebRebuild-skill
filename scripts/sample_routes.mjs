#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return `Usage:
  node sample_routes.mjs --inventory <dir> --out <dir> [options]

Options:
  --count <n>             Maximum route templates to sample (default: 6)
  --channel <name>        Installed browser channel: chrome or msedge
  --wait <ms>             Settle time after network idle (default: 1500)
  --timeout <ms>          Navigation timeout (default: 45000)
  --include-user          Include /user/ route samples
  --include-feed          Include RSS/feed file samples
  --headed                Show the browser
  --help                  Show this help

Input is the output directory from inventory_site.mjs, which must contain
runtime/routes.json. The script visits at most one URL per route template,
uses a fresh page for each sample, and never records cookies or request bodies.`;
}

function parseArgs(argv) {
  const args = {
    inventory: "",
    out: "",
    count: 6,
    channel: "",
    wait: 1500,
    timeout: 45000,
    includeUser: false,
    includeFeed: false,
    headed: false,
    help: false,
  };
  const values = new Map([
    ["--inventory", "inventory"],
    ["--out", "out"],
    ["--count", "count"],
    ["--channel", "channel"],
    ["--wait", "wait"],
    ["--timeout", "timeout"],
  ]);
  const booleans = new Map([
    ["--include-user", "includeUser"],
    ["--include-feed", "includeFeed"],
    ["--headed", "headed"],
    ["--help", "help"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (booleans.has(flag)) {
      args[booleans.get(flag)] = true;
      continue;
    }
    if (values.has(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      args[values.get(flag)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  for (const key of ["count", "wait", "timeout"]) {
    args[key] = Number(args[key]);
    if (!Number.isInteger(args[key]) || args[key] <= 0) {
      throw new Error(`Invalid numeric value: ${key}`);
    }
  }
  args.inventory = path.resolve(args.inventory);
  args.out = path.resolve(args.out || path.join(args.inventory, "route-samples"));
  return args;
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

function ensureHttpUrl(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http:// and https:// URLs are supported");
  }
  return url;
}

async function loadPlaywright() {
  const projectRequire = createRequire(pathToFileURL(path.join(process.cwd(), "package.json")));
  for (const packageName of ["playwright", "playwright-core"]) {
    try {
      return projectRequire(packageName);
    } catch {
      // Try another resolution source.
    }
  }
  for (const packageName of ["playwright", "playwright-core"]) {
    try {
      return await import(packageName);
    } catch {
      // Try another resolution source.
    }
  }
  throw new Error("Playwright is not available. Run `npm install` in the web-rebuild skill directory.");
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

async function sanitizedDom(page) {
  return page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true);
    const sensitiveName =
      /(?:pass(?:word)?|secret|token|auth|session|cookie|csrf|xsrf|api[-_]?key|credit|card|cvv)/i;
    for (const element of clone.querySelectorAll("script")) element.textContent = "";
    for (const element of clone.querySelectorAll("input")) {
      const type = (element.getAttribute("type") || "").toLowerCase();
      if (type === "hidden" || type === "password" || sensitiveName.test(element.name || "")) {
        element.remove();
      } else {
        element.removeAttribute("value");
      }
    }
    for (const element of clone.querySelectorAll("textarea")) element.textContent = "";
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
      }
    }
    return `<!doctype html>\n${clone.outerHTML}`;
  });
}

async function collectSummary(page) {
  return page.evaluate(() => {
    const clean = (value, length = 240) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, length);
    return {
      title: document.title,
      lang: document.documentElement.lang,
      mainTextLength: clean(document.body?.innerText || "", 100000).length,
      headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
        .slice(0, 300)
        .map((element) => ({
          level: Number(element.tagName.slice(1)),
          text: clean(element.innerText || element.textContent, 240),
        })),
      counts: {
        links: document.querySelectorAll("a[href]").length,
        buttons: document.querySelectorAll("button,[role=button]").length,
        images: document.images.length,
        forms: document.forms.length,
        iframes: document.querySelectorAll("iframe").length,
        videos: document.querySelectorAll("video").length,
      },
      scroll: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
    };
  });
}

function summarizeEndpoints(requests) {
  const groups = new Map();
  for (const request of requests) {
    if (!["xhr", "fetch"].includes(request.resourceType)) continue;
    const url = new URL(request.url);
    const pathname = url.pathname
      .replace(/\/\d{4,}(?=\/|$)/g, "/:id")
      .replace(/\/[a-z0-9_-]{24,}(?=\/|$)/gi, "/:token");
    const key = `${request.method} ${url.host}${pathname}`;
    if (!groups.has(key)) {
      groups.set(key, {
        method: request.method,
        host: url.host,
        pathPattern: pathname,
        statuses: [],
        contentTypes: [],
        count: 0,
      });
    }
    const group = groups.get(key);
    group.count += 1;
    if (request.status != null && !group.statuses.includes(request.status)) {
      group.statuses.push(request.status);
    }
    const mime = request.contentType?.split(";")[0];
    if (mime && !group.contentTypes.includes(mime)) group.contentTypes.push(mime);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function chooseRoutes(groups, args) {
  const selected = [];
  for (const group of groups) {
    if (selected.length >= args.count) break;
    if (!args.includeUser && /^\/user\//i.test(group.pattern)) continue;
    if (!args.includeFeed && /\/rss\//i.test(group.pattern)) continue;
    const sample = group.sampleUrls?.find((url) => !/<redacted>/i.test(url));
    if (!sample) continue;
    selected.push({
      pattern: group.pattern,
      count: group.count,
      url: sample,
      label: group.sampleLabels?.[0] || "",
    });
  }
  return selected;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.inventory) throw new Error(`--inventory is required\n\n${usage()}`);
  const routesPath = path.join(args.inventory, "runtime", "routes.json");
  const groups = JSON.parse(await readFile(routesPath, "utf8"));
  const selected = chooseRoutes(groups, args);
  if (selected.length === 0) throw new Error("No safely navigable route samples were found");

  const playwright = await loadPlaywright();
  const browserType = playwright.chromium || playwright.default?.chromium;
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

  await mkdir(path.join(args.out, "screenshots"), { recursive: true });
  await mkdir(path.join(args.out, "routes"), { recursive: true });
  const results = [];

  try {
    for (let index = 0; index < selected.length; index += 1) {
      const route = selected[index];
      const page = await context.newPage();
      const requests = [];
      const requestMap = new Map();
      page.on("request", (request) => {
        const record = {
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType(),
          status: null,
          contentType: "",
        };
        requestMap.set(request, record);
        requests.push(record);
      });
      page.on("response", (response) => {
        const record = requestMap.get(response.request());
        if (!record) return;
        record.status = response.status();
        record.contentType = response.headers()["content-type"] || "";
      });
      const safeId = `${String(index + 1).padStart(2, "0")}-${createHash("sha256")
        .update(route.pattern)
        .digest("hex")
        .slice(0, 8)}`;
      const result = {
        id: safeId,
        pattern: route.pattern,
        routeCountObservedFromInventory: route.count,
        label: route.label,
        inputUrl: route.url,
        finalUrl: "",
        status: null,
        error: "",
      };
      try {
        const response = await page.goto(route.url, {
          waitUntil: "domcontentloaded",
          timeout: args.timeout,
        });
        await page
          .waitForLoadState("networkidle", { timeout: Math.max(5000, args.timeout / 2) })
          .catch(() => {});
        await page.waitForTimeout(args.wait);
        ensureHttpUrl(page.url());
        result.finalUrl = redactedUrl(page.url());
        result.status = response?.status() ?? null;
        result.summary = await collectSummary(page);
        await writeFile(path.join(args.out, "routes", `${safeId}.html`), await sanitizedDom(page), "utf8");
        await page.screenshot({
          path: path.join(args.out, "screenshots", `${safeId}.png`),
          type: "png",
        });
      } catch (error) {
        result.error = error.message;
      } finally {
        result.endpoints = summarizeEndpoints(requests);
        await page.close().catch(() => {});
        results.push(result);
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const summary = {
    schemaVersion: 1,
    tool: "web-rebuild/sample_routes",
    generatedAt: new Date().toISOString(),
    inventory: args.inventory,
    selectedCount: selected.length,
    routes: results,
    notes: [
      "One representative was selected for each route template unless count was reached.",
      "Account routes and feeds are excluded unless explicitly enabled.",
      "Request bodies, cookies, authorization headers, and form values are not recorded.",
    ],
  };
  await writeJson(path.join(args.out, "summary.json"), summary);
  console.log(
    JSON.stringify(
      {
        out: args.out,
        routes: results.map((route) => ({
          pattern: route.pattern,
          status: route.status,
          title: route.summary?.title || "",
          error: route.error || undefined,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`sample_routes: ${error.stack || error.message}`);
  process.exitCode = 1;
});
