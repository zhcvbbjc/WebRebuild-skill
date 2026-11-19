#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ASSET_EXTENSION =
  /\.(?:avif|bmp|css|eot|gif|ico|jpeg|jpg|js|json|map|m4a|m4v|mp3|mp4|ogg|otf|pdf|png|svg|ttf|webm|webp|woff2?|xml|zip)(?:$|[?#])/i;
const TRACKING_PARAM = /^(?:utm_|fbclid$|gclid$|dclid$|msclkid$|yclid$|_ga$|_gl$)/i;
const SENSITIVE_PARAM = /(?:token|secret|password|passwd|session|auth|code|signature|sig|key)/i;
const AUTH_PATH = /\/(?:login|signin|sign-in|register|signup|sign-up|auth|account\/login)(?:[/.?]|$)/i;
const AUTH_TEXT =
  /(?:登录|登入|注册|扫码登录|账号登录|手机号登录|密码登录|短信验证码|邮箱验证码|验证码|忘记密码|login|sign in|sign up|one.?time code|verification code)/i;
const CAPTCHA_TEXT = /(?:captcha|recaptcha|hcaptcha|turnstile|滑块验证|人机验证)/i;
const QR_TEXT = /(?:扫码登录|二维码登录|qrcode|qr code|scan to login)/i;
const OTP_TEXT = /(?:验证码|动态码|one.?time code|verification code|otp|2fa|two.factor)/i;
const OAUTH_TEXT =
  /(?:google|github|wechat|weixin|qq|weibo|apple|facebook|微信|微博|第三方登录|oauth|sso)/i;
const SENSITIVE_FIELD =
  /(?:pass(?:word)?|secret|token|session|cookie|csrf|xsrf|api[-_]?key|credit|card|cvv)/i;
const SAFE_SCHEMA_KEY = /^(?:id|name|title|slug|type|status|kind|page|size|total|count|url|path|code|label)$/i;

function usage() {
  return `Usage:
  node crawl_site.mjs --url <https://...> --out <dir> [options]

Options:
  --inventory <dir>          Inventory directory used to prioritize route templates
  --max-pages <n>            Maximum pages in this run (default: 100)
  --max-depth <n>            Maximum link depth from the seed (default: 3)
  --storage-state <file>     Authorized Playwright storage-state file
  --include-user             Permit /user/ and /account/ routes
  --screenshot <mode>        key | all | none (default: key)
  --dom <mode>               key | all | none (default: key)
  --channel <name>           Installed browser channel: chrome or msedge
  --delay <ms>               Delay between pages (default: 350)
  --wait <ms>                Settle time after network idle (default: 1200)
  --timeout <ms>             Navigation timeout (default: 45000)
  --no-api-schemas           Do not infer JSON response schemas
  --resume                   Resume a previous crawl from crawl/state.json
  --headed                   Show the browser
  --help                     Show this help

Output is written under <out>/crawl:
  state.json, site-graph.json, route-coverage.json, auth-requirements.json,
  api-contracts.json, unresolved.json, pages/<route-id>/*

Authentication:
  The crawler never asks for or stores passwords in evidence. It records the
  login fields and challenge types the site actually presents. Complete the
  login through capture_auth_state.mjs, then rerun this crawler with
  --storage-state and --resume.

Exit codes:
  0  Crawl reached its page/depth boundary without auth or request failures
  2  Crawl is incomplete because of authentication, failures, or a page cap
  1  Fatal setup or browser error`;
}

function parseArgs(argv) {
  const args = {
    url: "",
    out: "",
    inventory: "",
    maxPages: 100,
    maxDepth: 3,
    storageState: "",
    includeUser: false,
    screenshot: "key",
    dom: "key",
    channel: "",
    delay: 350,
    wait: 1200,
    timeout: 45000,
    apiSchemas: true,
    resume: false,
    headed: false,
    help: false,
  };
  const values = new Map([
    ["--url", "url"],
    ["--out", "out"],
    ["--inventory", "inventory"],
    ["--max-pages", "maxPages"],
    ["--max-depth", "maxDepth"],
    ["--storage-state", "storageState"],
    ["--screenshot", "screenshot"],
    ["--dom", "dom"],
    ["--channel", "channel"],
    ["--delay", "delay"],
    ["--wait", "wait"],
    ["--timeout", "timeout"],
  ]);
  const booleans = new Map([
    ["--include-user", "includeUser"],
    ["--no-api-schemas", "noApiSchemas"],
    ["--resume", "resume"],
    ["--headed", "headed"],
    ["--help", "help"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (booleans.has(flag)) {
      const key = booleans.get(flag);
      if (key === "noApiSchemas") args.apiSchemas = false;
      else args[key] = true;
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
  for (const key of ["maxPages", "maxDepth", "delay", "wait", "timeout"]) {
    args[key] = Number(args[key]);
    if (!Number.isInteger(args[key]) || args[key] < 0) {
      throw new Error(`Invalid numeric value: ${key}`);
    }
  }
  if (args.maxPages < 1) throw new Error("--max-pages must be at least 1");
  for (const mode of ["screenshot", "dom"]) {
    if (!["key", "all", "none"].includes(args[mode])) {
      throw new Error(`--${mode} must be key, all, or none`);
    }
  }
  args.out = path.resolve(args.out || "web-rebuild-output");
  if (args.inventory) args.inventory = path.resolve(args.inventory);
  if (args.storageState) args.storageState = path.resolve(args.storageState);
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

function canonicalizeUrl(raw) {
  const url = new URL(raw);
  url.hash = "";
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key) || SENSITIVE_PARAM.test(key)) {
      url.searchParams.delete(key);
    }
  }
  const entries = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  url.search = "";
  for (const [key, value] of entries) url.searchParams.append(key, value);
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

function routeTemplate(rawUrl) {
  const url = new URL(rawUrl);
  const pathname = url.pathname
    .replace(/\/voddetail\/[^/]+\.html$/i, "/voddetail/:id.html")
    .replace(/\/vodtype\/[^/]+\.html$/i, "/vodtype/:id.html")
    .replace(/\/vodshow\/[^/]+\.html$/i, "/vodshow/:filter.html")
    .replace(/\/vodsearch\/[^/]+\.html$/i, "/vodsearch/:query.html")
    .replace(/\/artdetail-[^/]+\.html$/i, "/artdetail-:id.html")
    .replace(/\/arttype\/[^/]+\.html$/i, "/arttype/:id.html")
    .replace(/\/topicdetail-[^/]+\.html$/i, "/topicdetail-:id.html")
    .replace(/\/label\/[^/]+\.html$/i, "/label/:slug.html")
    .replace(/\/user\/[^/]+\.html$/i, "/user/:page.html")
    .replace(/\/\d{4,}(?=\/|$)/g, "/:id");
  return pathname || "/";
}

function shouldSkipUrl(url, root, includeUser) {
  if (url.origin !== root.origin) return true;
  if (ASSET_EXTENSION.test(url.pathname)) return true;
  if (/\/logout(?:[/.?]|$)/i.test(url.pathname)) return true;
  if (!includeUser && /\/(?:user|account)\//i.test(url.pathname)) return true;
  return false;
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

function hashId(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
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

async function collectPageEvidence(page) {
  return page.evaluate(() => {
    const clean = (value, length = 240) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, length);
    const safeUrl = (raw) => {
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
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const fieldLabel = (field) => {
      const aria = field.getAttribute("aria-label");
      if (aria) return clean(aria, 160);
      const labelledBy = field.getAttribute("aria-labelledby");
      if (labelledBy) {
        const label = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.innerText || "")
          .join(" ");
        if (clean(label)) return clean(label, 160);
      }
      if (field.id) {
        const label = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        if (label) return clean(label.innerText || label.textContent, 160);
      }
      const wrapping = field.closest("label");
      if (wrapping) return clean(wrapping.innerText || wrapping.textContent, 160);
      return clean(field.getAttribute("placeholder") || field.getAttribute("name"), 160);
    };
    const links = [];
    const linkSet = new Set();
    for (const anchor of document.querySelectorAll("a[href]")) {
      if (links.length >= 1500) break;
      const href = anchor.href;
      if (!href || linkSet.has(href)) continue;
      linkSet.add(href);
      links.push({
        text: clean(anchor.innerText || anchor.getAttribute("aria-label"), 160),
        href,
      });
    }
    const forms = [...document.forms].slice(0, 100).map((form) => ({
      action: safeUrl(form.action || form.getAttribute("action")),
      method: (form.getAttribute("method") || "get").toLowerCase(),
      fields: [...form.querySelectorAll("input,select,textarea")]
        .slice(0, 200)
        .map((field) => ({
          tag: field.tagName.toLowerCase(),
          type: field.getAttribute("type") || "",
          name: field.getAttribute("name") || "",
          label: fieldLabel(field),
          placeholder: clean(field.getAttribute("placeholder"), 160),
          required: field.hasAttribute("required"),
          disabled: field.hasAttribute("disabled"),
          autocomplete: field.getAttribute("autocomplete") || "",
          visible: visible(field),
        })),
    }));
    const bodyText = clean(document.body?.innerText || "", 20000);
    const passwordFields = [...document.querySelectorAll('input[type="password"]')].map((field) => ({
      type: "password",
      name: field.name || "",
      label: fieldLabel(field),
      required: field.required,
      autocomplete: field.getAttribute("autocomplete") || "",
    }));
    const challengeFields = [...document.querySelectorAll("input,select,textarea")]
      .filter((field) =>
        /(?:otp|code|captcha|verify|verification|2fa|totp)/i.test(
          `${field.name || ""} ${field.id || ""} ${fieldLabel(field)}`,
        ),
      )
      .slice(0, 20)
      .map((field) => ({
        type: field.getAttribute("type") || field.tagName.toLowerCase(),
        name: field.name || "",
        label: fieldLabel(field),
        required: field.required,
        autocomplete: field.getAttribute("autocomplete") || "",
      }));
    const buttons = [...document.querySelectorAll("button,[role=button],input[type=submit]")]
      .filter(visible)
      .slice(0, 200)
      .map((button) =>
        clean(button.innerText || button.value || button.getAttribute("aria-label"), 160),
      )
      .filter(Boolean);
    const motionSelector =
      "[class*='swiper'],[class*='carousel'],[class*='slider'],[class*='slick'],[class*='marquee'],[aria-roledescription='carousel']";
    const interactionCandidates = [];
    const interactionSeen = new Set();
    for (const element of document.querySelectorAll(
      "a[href],button,[role=button],[role=tab],[aria-controls],[data-toggle],[data-target],[data-tab],[data-filter]",
    )) {
      if (interactionCandidates.length >= 500 || !visible(element)) continue;
      const label = clean(
        element.innerText ||
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.value,
        180,
      );
      const role =
        element.getAttribute("role") ||
        (element.tagName === "A" ? "link" : element.tagName === "BUTTON" ? "button" : element.tagName.toLowerCase());
      const href =
        element.tagName === "A" && element.href && /^https?:/i.test(element.href)
          ? safeUrl(element.href)
          : "";
      const form = element.closest("form");
      const data = {};
      for (const attribute of [...element.attributes]) {
        if (!attribute.name.startsWith("data-") || /(?:token|secret|auth|session)/i.test(attribute.name)) {
          continue;
        }
        data[attribute.name] = clean(attribute.value, 200);
      }
      const signature = [
        role,
        element.tagName.toLowerCase(),
        label,
        href,
        element.getAttribute("aria-controls") || "",
        JSON.stringify(data),
      ].join("|");
      if (interactionSeen.has(signature)) continue;
      interactionSeen.add(signature);
      const intentText = `${label} ${role} ${element.className || ""} ${JSON.stringify(data)}`;
      const insideMotion = Boolean(element.closest(motionSelector));
      const formMethod = (form?.getAttribute("method") || "").toLowerCase();
      const intent =
        insideMotion || /carousel|slider|swiper/i.test(intentText)
          ? "carousel"
          : /pagination|paginator|下一页|上一页|next page|previous page/i.test(intentText)
            ? "pagination"
            : /role\s*[="']?tab|tab-list|筛选|filter/i.test(intentText)
              ? "tab-or-filter"
              : /dialog|modal|popup|aria-controls|data-toggle/i.test(intentText)
                ? "dialog-or-menu"
                : /播放|play|player|episode|选集/i.test(intentText)
                  ? "playback"
                  : /收藏|favorite|like|watch|登录|logout|account|user/i.test(intentText)
                    ? "account-or-mutation"
                    : formMethod === "post"
                      ? "state-changing-submit"
                      : href
                        ? "navigation"
                        : "unknown";
      interactionCandidates.push({
        role,
        tag: element.tagName.toLowerCase(),
        label,
        intent,
        href,
        type: element.getAttribute("type") || "",
        formAction: form ? safeUrl(form.action || form.getAttribute("action")) : "",
        formMethod,
        ariaControls: element.getAttribute("aria-controls") || "",
        ariaExpanded: element.getAttribute("aria-expanded") || "",
        disabled: element.matches(":disabled,[aria-disabled='true']"),
        insideMotionRegion: insideMotion,
        data,
        autoCaptureSafe: ["navigation", "tab-or-filter", "dialog-or-menu", "pagination"].includes(intent) &&
          !insideMotion &&
          element.tagName !== "FORM",
      });
    }
    return {
      title: document.title,
      lang: document.documentElement.lang,
      visibleText: bodyText,
      textLength: bodyText.length,
      headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
        .slice(0, 400)
        .map((element) => ({
          level: Number(element.tagName.slice(1)),
          text: clean(element.innerText || element.textContent, 240),
        })),
      buttons,
      counts: {
        links: document.querySelectorAll("a[href]").length,
        buttons: document.querySelectorAll("button,[role=button],input[type=submit]").length,
        images: document.images.length,
        forms: document.forms.length,
        inputs: document.querySelectorAll("input,select,textarea").length,
        iframes: document.querySelectorAll("iframe").length,
        videos: document.querySelectorAll("video").length,
      },
      scroll: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      links,
      forms,
      passwordFields,
      challengeFields,
      interactionCandidates,
      challengeSignals: {
        authText: /(?:登录|注册|扫码|密码|验证码|login|sign in|sign up|verification|password)/i.test(
          bodyText,
        ),
        captcha: /(?:captcha|recaptcha|hcaptcha|turnstile|滑块验证|人机验证)/i.test(
          `${bodyText} ${document.documentElement.innerHTML.slice(0, 200000)}`,
        ),
        qr: /(?:扫码|二维码|qrcode|qr code)/i.test(bodyText) ||
          Boolean(document.querySelector("[class*='qrcode'],[class*='qr-code'],canvas")),
        oauth: /(?:google|github|微信|微博|qq|oauth|sso)/i.test(bodyText),
        canvasCount: document.querySelectorAll("canvas").length,
      },
    };
  });
}

function classifyAuthentication(evidence, requestedUrl, finalUrl, status) {
  const requestedPath = new URL(requestedUrl).pathname;
  const finalPath = new URL(finalUrl).pathname;
  const redirectedToAuth =
    routeTemplate(requestedUrl) !== routeTemplate(finalUrl) &&
    AUTH_PATH.test(finalPath) &&
    !AUTH_PATH.test(requestedPath);
  const loginPage = AUTH_PATH.test(finalPath);
  const password = evidence.passwordFields.length > 0;
  const visibleText = evidence.visibleText || "";
  const signals = evidence.challengeSignals || {};
  const methods = [];
  if (password) methods.push("password");
  if (signals.qr) methods.push("qr");
  if (OTP_TEXT.test(visibleText) || evidence.challengeFields.length > 0) methods.push("otp");
  if (CAPTCHA_TEXT.test(`${visibleText} ${evidence.buttons.join(" ")}`) || signals.captcha) {
    methods.push("captcha");
  }
  if (OAUTH_TEXT.test(visibleText) || signals.oauth) methods.push("oauth");
  const required =
    redirectedToAuth ||
    ((password || methods.length > 0) && AUTH_TEXT.test(visibleText)) ||
    loginPage;
  const authForm =
    evidence.forms.find((form) =>
      form.fields.some((field) => field.type === "password" || SENSITIVE_FIELD.test(field.name)),
    ) ||
    evidence.forms.find((form) => AUTH_PATH.test(form.action || "")) ||
    null;
  const authFields = authForm
    ? authForm.fields
        .filter(
          (field) =>
            field.visible &&
            !["hidden", "submit", "button", "reset", "image"].includes(field.type),
        )
        .map((field) => ({
          type: field.type || field.tag,
          name: field.name,
          label: field.label,
          required: field.required,
          autocomplete: field.autocomplete,
        }))
    : [...evidence.passwordFields, ...evidence.challengeFields];
  return {
    required,
    authPage: loginPage,
    redirectedToAuth,
    requestedUrl: redactedUrl(requestedUrl),
    finalUrl: redactedUrl(finalUrl),
    status,
    methods: [...new Set(methods)],
    fields: [
      ...new Map(
        [...evidence.passwordFields, ...evidence.challengeFields, ...authFields].map((field) => [
          `${field.type}:${field.name}:${field.label}`,
          field,
        ]),
      ).values(),
    ],
    buttons: evidence.buttons.filter((label) => AUTH_TEXT.test(label) || OAUTH_TEXT.test(label)).slice(0, 40),
    notes: [
      password ? "Password field detected." : "",
      signals.qr ? "QR-code login indicator detected." : "",
      methods.includes("otp") ? "One-time verification code may be required." : "",
      methods.includes("captcha") ? "Human verification or CAPTCHA may be required." : "",
      methods.includes("oauth") ? "Third-party or single-sign-on options may be present." : "",
    ].filter(Boolean),
  };
}

function endpointKey(request) {
  const url = new URL(request.url);
  const pathname = url.pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, "/:uuid")
    .replace(/\/\d{4,}(?=\/|$)/g, "/:id")
    .replace(/\/[a-z0-9_-]{24,}(?=\/|$)/gi, "/:token");
  const queryKeys = [...url.searchParams.keys()].sort();
  return `${request.method} ${url.host}${pathname}${queryKeys.length ? `?${queryKeys.join("&")}` : ""}`;
}

function schemaFor(value, depth = 0) {
  if (depth >= 6) return "unknown";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array<unknown>";
    const itemSchemas = [...new Set(value.slice(0, 5).map((item) => schemaFor(item, depth + 1)))];
    return `array<${itemSchemas.join("|")}>`;
  }
  if (typeof value === "object") {
    const fields = {};
    for (const [key, entry] of Object.entries(value).slice(0, 200)) {
      const safeKey = SENSITIVE_FIELD.test(key) ? "<sensitive-field>" : key;
      fields[safeKey] = schemaFor(entry, depth + 1);
    }
    return fields;
  }
  return typeof value;
}

function mergeContract(contracts, request, schema, contentType) {
  const key = endpointKey(request);
  if (!contracts.has(key)) {
    contracts.set(key, {
      method: request.method,
      urlPattern: redactedUrl(request.url).replace(/=%3Credacted%3E/g, "=<value>"),
      host: new URL(request.url).host,
      contentType,
      statuses: [],
      samples: 0,
      responseSchema: schema,
    });
  }
  const contract = contracts.get(key);
  contract.samples += 1;
  if (request.status != null && !contract.statuses.includes(request.status)) {
    contract.statuses.push(request.status);
  }
}

async function discoverLinks(page, root, includeUser) {
  const rawLinks = await page.evaluate(() =>
    [...document.querySelectorAll("a[href]")]
      .slice(0, 2500)
      .map((anchor) => ({
        href: anchor.href,
        text: String(anchor.innerText || anchor.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160),
      }))
      .filter((link) => /^https?:/i.test(link.href)),
  );
  const links = [];
  const seen = new Set();
  for (const link of rawLinks) {
    let url;
    try {
      url = ensureHttpUrl(link.href);
    } catch {
      continue;
    }
    if (shouldSkipUrl(url, root, includeUser)) continue;
    const canonical = canonicalizeUrl(url.href);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    links.push({ url: canonical, redactedUrl: redactedUrl(canonical), text: link.text });
  }
  return links;
}

async function seedFromInventory(args, seedUrl) {
  if (!args.inventory) return [];
  try {
    const routes = JSON.parse(
      await readFile(path.join(args.inventory, "runtime", "routes.json"), "utf8"),
    );
    const seeds = [];
    for (const route of routes) {
      if (!args.includeUser && /^\/user\//i.test(route.pattern)) continue;
      const sample = route.sampleUrls?.find((url) => !/<redacted>/i.test(url));
      if (!sample) continue;
      try {
        const url = ensureHttpUrl(sample);
        if (shouldSkipUrl(url, seedUrl, args.includeUser)) continue;
        seeds.push(canonicalizeUrl(url.href));
      } catch {
        // Ignore stale inventory samples.
      }
    }
    return [...new Set(seeds)];
  } catch {
    return [];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.url) throw new Error(`--url is required\n\n${usage()}`);
  const seedUrl = ensureHttpUrl(args.url);
  const crawlDir = path.join(args.out, "crawl");
  const pagesDir = path.join(crawlDir, "pages");
  await mkdir(pagesDir, { recursive: true });

  const statePath = path.join(crawlDir, "state.json");
  let state = null;
  if (args.resume) {
    try {
      state = JSON.parse(await readFile(statePath, "utf8"));
    } catch {
      state = null;
    }
  }
  if (!state) {
    const privilegedSeeds = await seedFromInventory(args, seedUrl);
    const seedCanonical = canonicalizeUrl(seedUrl.href);
    state = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      seedUrl: seedCanonical,
      maxDepth: args.maxDepth,
      visited: [],
      queued: [
        { url: seedCanonical, depth: 0, parent: null, text: "seed" },
        ...privilegedSeeds
          .filter((url) => url !== seedCanonical)
          .map((url) => ({ url, depth: 1, parent: seedCanonical, text: "inventory sample" })),
      ],
      failures: [],
      authPages: [],
      authGates: [],
      edges: [],
      runs: [],
    };
  }
  state.maxDepth = args.maxDepth;
  const visited = new Set(state.visited || []);
  const queued = new Set((state.queued || []).map((item) => item.url));

  const playwright = await loadPlaywright();
  const browserType = playwright.chromium || playwright.default?.chromium;
  const browser = await launchChromium(browserType, {
    headless: !args.headed,
    channel: args.channel,
  });
  const contextOptions = {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: "en-US",
    colorScheme: "light",
    reducedMotion: "reduce",
  };
  if (args.storageState) contextOptions.storageState = args.storageState;
  const context = await browser.newContext(contextOptions);
  const pageIdPatterns = new Set();
  const contracts = new Map();
  const processedThisRun = [];

  try {
    while (state.queued.length > 0 && processedThisRun.length < args.maxPages) {
      const task = state.queued.shift();
      if (!task) break;
      const canonical = canonicalizeUrl(task.url);
      queued.delete(canonical);
      if (visited.has(canonical)) continue;
      visited.add(canonical);
      const id = `${String(processedThisRun.length + 1).padStart(4, "0")}-${hashId(canonical)}`;
      const pageDir = path.join(pagesDir, id);
      await mkdir(pageDir, { recursive: true });
      const page = await context.newPage();
      const requestRecords = [];
      const requestMap = new Map();
      const schemaPromises = [];
      const pageErrors = [];

      page.on("request", (request) => {
        const record = {
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType(),
          status: null,
          contentType: "",
        };
        requestMap.set(request, record);
        requestRecords.push(record);
      });
      page.on("response", (response) => {
        const request = response.request();
        const record = requestMap.get(request);
        if (!record) return;
        record.status = response.status();
        record.contentType = response.headers()["content-type"] || "";
        if (
          args.apiSchemas &&
          ["xhr", "fetch"].includes(record.resourceType) &&
          request.method() === "GET" &&
          new URL(request.url()).origin === seedUrl.origin &&
          /application\/(?:[^;]+\+)?json/i.test(record.contentType) &&
          response.status() >= 200 &&
          response.status() < 300
        ) {
          schemaPromises.push(
            response
              .json()
              .then((json) => mergeContract(contracts, record, schemaFor(json), record.contentType))
              .catch(() => {}),
          );
        }
      });
      page.on("pageerror", (error) => {
        if (pageErrors.length < 50) pageErrors.push(String(error).slice(0, 2000));
      });

      const pageResult = {
        id,
        requestedUrl: redactedUrl(canonical),
        finalUrl: "",
        routeTemplate: routeTemplate(canonical),
        depth: task.depth,
        parent: task.parent ? redactedUrl(task.parent) : null,
        status: null,
        title: "",
        authentication: null,
        summary: null,
        files: {},
        discoveredLinks: 0,
        endpoints: [],
        pageErrors,
        error: "",
      };
      try {
        const response = await page.goto(canonical, {
          waitUntil: "domcontentloaded",
          timeout: args.timeout,
        });
        await page
          .waitForLoadState("networkidle", { timeout: Math.max(5000, args.timeout / 2) })
          .catch(() => {});
        await page.waitForTimeout(args.wait);
        await Promise.allSettled(schemaPromises);
        const finalUrl = ensureHttpUrl(page.url());
        pageResult.finalUrl = redactedUrl(finalUrl.href);
        pageResult.status = response?.status() ?? null;
        const evidence = await collectPageEvidence(page);
        pageResult.title = evidence.title;
        pageResult.summary = {
          lang: evidence.lang,
          textLength: evidence.textLength,
          headings: evidence.headings.slice(0, 80),
          buttons: evidence.buttons.slice(0, 100),
          counts: evidence.counts,
          scroll: evidence.scroll,
          forms: evidence.forms.map((form) => ({
            action: form.action,
            method: form.method,
            fields: form.fields.map((field) => ({
              tag: field.tag,
              type: field.type,
              name: field.name,
              label: field.label,
              required: field.required,
              disabled: field.disabled,
              autocomplete: field.autocomplete,
            })),
          })),
          interactions: evidence.interactionCandidates.slice(0, 200),
        };
        pageResult.authentication = classifyAuthentication(
          evidence,
          canonical,
          finalUrl.href,
          pageResult.status,
        );
        if (pageResult.authentication.authPage) {
          state.authPages.push(pageResult.authentication);
        }
        if (pageResult.authentication.redirectedToAuth) {
          state.authGates.push({
            requestedUrl: pageResult.authentication.requestedUrl,
            loginUrl: pageResult.authentication.finalUrl,
            methods: pageResult.authentication.methods,
            fields: pageResult.authentication.fields,
          });
        }

        const links = await discoverLinks(page, seedUrl, args.includeUser);
        pageResult.discoveredLinks = links.length;
        for (const link of links) {
          const edgeKey = `${canonicalizeUrl(canonical)}>${link.url}`;
          if (!state.edges.some((edge) => edge.key === edgeKey)) {
            state.edges.push({
              key: edgeKey,
              from: redactedUrl(canonical),
              to: link.redactedUrl,
              text: link.text,
            });
          }
          if (
            !visited.has(link.url) &&
            !queued.has(link.url) &&
            task.depth < state.maxDepth &&
            !shouldSkipUrl(new URL(link.url), seedUrl, args.includeUser)
          ) {
            state.queued.push({
              url: link.url,
              depth: task.depth + 1,
              parent: canonical,
              text: link.text,
            });
            queued.add(link.url);
          }
        }

        const pattern = pageResult.routeTemplate;
        const captureKey = !pageIdPatterns.has(pattern);
        pageIdPatterns.add(pattern);
        if (args.dom === "all" || (args.dom === "key" && captureKey)) {
          const domPath = path.join(pageDir, "dom.html");
          await writeFile(domPath, await sanitizedDom(page), "utf8");
          pageResult.files.dom = path.relative(crawlDir, domPath).replaceAll("\\", "/");
        }
        if (args.screenshot === "all" || (args.screenshot === "key" && captureKey)) {
          const screenshotPath = path.join(pageDir, "screenshot.png");
          await page.screenshot({ path: screenshotPath, type: "png" });
          pageResult.files.screenshot = path
            .relative(crawlDir, screenshotPath)
            .replaceAll("\\", "/");
        }
        pageResult.endpoints = [
          ...new Set(
            requestRecords
              .filter((record) => ["xhr", "fetch"].includes(record.resourceType))
              .map(
                (record) =>
                  `${record.method} ${new URL(record.url).host}${new URL(record.url).pathname}`,
              ),
          ),
        ].slice(0, 500);
      } catch (error) {
        pageResult.error = error.message;
        state.failures.push({
          url: redactedUrl(canonical),
          depth: task.depth,
          error: error.message,
        });
      } finally {
        await page.close().catch(() => {});
        state.visited.push(canonical);
        visited.add(canonical);
        processedThisRun.push(pageResult);
        await writeJson(path.join(pageDir, "summary.json"), pageResult);
        state.updatedAt = new Date().toISOString();
        await writeJson(statePath, state);
      }
      if (args.delay > 0 && processedThisRun.length < args.maxPages) {
        await new Promise((resolve) => setTimeout(resolve, args.delay));
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  state.runs.push({
    startedAt: state.updatedAt,
    processed: processedThisRun.length,
    maxPages: args.maxPages,
    storageStateUsed: Boolean(args.storageState),
  });
  state.updatedAt = new Date().toISOString();
  await writeJson(statePath, state);

  const routeGroups = new Map();
  for (const page of processedThisRun) {
    const group = routeGroups.get(page.routeTemplate) || {
      pattern: page.routeTemplate,
      crawled: 0,
      succeeded: 0,
      failed: 0,
      authRequired: 0,
      sampleUrls: [],
    };
    group.crawled += 1;
    if (page.error || page.status == null || page.status >= 400) group.failed += 1;
    else group.succeeded += 1;
    if (page.authentication?.required) group.authRequired += 1;
    if (group.sampleUrls.length < 5) group.sampleUrls.push(page.finalUrl || page.requestedUrl);
    routeGroups.set(page.routeTemplate, group);
  }

  const authRequirements = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    storageStateProvided: Boolean(args.storageState),
    gatedRoutes: state.authGates,
    authPages: state.authPages,
    loginUrls: [...new Set(state.authPages.map((page) => page.finalUrl))],
    methods: [...new Set(state.authPages.flatMap((page) => page.methods))],
    requiredFields: [
      ...new Map(
        state.authPages
          .flatMap((page) => page.fields)
          .filter(
            (field) =>
              !["hidden", "submit", "button", "reset", "image"].includes(field.type) &&
              Boolean(field.label || field.name),
          )
          .map((field) => [`${field.type}:${field.label}:${field.name}`, field]),
      ).values(),
    ],
    recommendedAction:
      state.authGates.length > 0
        ? "Ask the user to complete an authorized manual login through capture_auth_state.mjs, then rerun with --storage-state and --resume. Do not request a raw password in chat."
        : state.authPages.length > 0 && !args.storageState
          ? "A login page was detected. Report its fields and challenge types to the user, complete an authorized manual login through capture_auth_state.mjs, then rerun with --storage-state and --resume."
          : "No authentication gate was encountered.",
  };
  await writeJson(path.join(crawlDir, "auth-requirements.json"), authRequirements);
  await writeJson(path.join(crawlDir, "api-contracts.json"), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    contracts: [...contracts.values()].sort((a, b) => b.samples - a.samples),
    note: "Only sanitized response shapes are stored. Request/response values, cookies, and authorization headers are excluded.",
  });
  await writeJson(path.join(crawlDir, "route-coverage.json"), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    routeTemplates: [...routeGroups.values()],
    visitedTotal: state.visited.length,
    queuedRemaining: state.queued.length,
  });
  const interactionGroups = new Map();
  for (const page of processedThisRun) {
    const interactions = page.summary?.interactions || [];
    for (const interaction of interactions) {
      const key = `${page.routeTemplate}|${interaction.intent}`;
      if (!interactionGroups.has(key)) {
        interactionGroups.set(key, {
          routeTemplate: page.routeTemplate,
          intent: interaction.intent,
          count: 0,
          samples: [],
          autoCaptureSafe: 0,
          stateChanging: 0,
        });
      }
      const group = interactionGroups.get(key);
      group.count += 1;
      if (group.samples.length < 8) {
        group.samples.push({
          label: interaction.label,
          role: interaction.role,
          tag: interaction.tag,
          href: interaction.href,
          formAction: interaction.formAction,
          formMethod: interaction.formMethod,
          data: interaction.data,
        });
      }
      if (interaction.autoCaptureSafe) group.autoCaptureSafe += 1;
      if (["state-changing-submit", "account-or-mutation", "playback"].includes(interaction.intent)) {
        group.stateChanging += 1;
      }
    }
  }
  await writeJson(path.join(crawlDir, "interaction-map.json"), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    interactions: [...interactionGroups.values()].sort((a, b) => b.count - a.count),
    note:
      "Controls are inventoried without clicking. autoCaptureSafe is a triage hint, not authorization to mutate state.",
  });
  await writeJson(path.join(crawlDir, "site-graph.json"), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    seedUrl: redactedUrl(seedUrl.href),
    nodes: processedThisRun.map((page) => ({
      id: page.id,
      url: page.finalUrl || page.requestedUrl,
      routeTemplate: page.routeTemplate,
      status: page.status,
      title: page.title,
      authRequired: Boolean(page.authentication?.required),
    })),
    edges: state.edges,
  });
  await writeJson(path.join(crawlDir, "unresolved.json"), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    failures: state.failures,
    authenticationGates: state.authGates,
    queuedRemaining: state.queued,
    pageCapReached: state.queued.length > 0 && processedThisRun.length >= args.maxPages,
    nextAction:
      state.authGates.length > 0 || (!args.storageState && state.authPages.length > 0)
        ? "Complete authorized login, then resume."
        : state.queued.length > 0
          ? "Increase --max-pages or --max-depth and resume."
          : "Review remaining failures and sampled interaction states.",
  });

  const crawlNextAction =
    state.authGates.length > 0 || (!args.storageState && state.authPages.length > 0)
      ? "Complete authorized login, then resume."
      : state.failures.length > 0
        ? "Review crawl/unresolved.json and resume after fixing request failures."
        : state.queued.length > 0
          ? "Increase --max-pages or --max-depth and resume."
          : "Review interaction states and begin implementation from rebuild-plan.json.";

  const incomplete =
    state.queued.length > 0 ||
    state.failures.length > 0 ||
    state.authGates.length > 0 ||
    (!args.storageState && state.authPages.length > 0);
  console.log(
    JSON.stringify(
      {
        out: crawlDir,
        pages: processedThisRun.length,
        visitedTotal: state.visited.length,
        queuedRemaining: state.queued.length,
        failures: state.failures.length,
        authGates: state.authGates.length,
        authPages: state.authPages.length,
        authMethods: authRequirements.methods,
        requiredFields: authRequirements.requiredFields,
        apiContracts: contracts.size,
        complete: !incomplete,
        nextAction: crawlNextAction,
      },
      null,
      2,
    ),
  );
  if (incomplete) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`crawl_site: ${error.stack || error.message}`);
  process.exitCode = 1;
});
