#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";

function usage() {
  return `Usage:
  node capture_auth_state.mjs --url <login-url> [options]

Options:
  --out <file>            Storage-state output (default: .web-rebuild-private/auth-state.json)
  --channel <name>        Installed browser channel: chrome or msedge
  --timeout <ms>          Initial navigation timeout (default: 45000)
  --help                  Show this help

The browser opens in headed mode. Inspect the detected login fields, complete
login manually, then press Enter in the terminal. Cookies and web storage are
saved to the output file; passwords and page contents are not printed.

Use the resulting file with:
  node crawl_site.mjs ... --storage-state <file> --resume`;
}

function parseArgs(argv) {
  const args = {
    url: "",
    out: path.resolve(".web-rebuild-private", "auth-state.json"),
    channel: "",
    timeout: 45000,
    help: false,
  };
  const values = new Map([
    ["--url", "url"],
    ["--out", "out"],
    ["--channel", "channel"],
    ["--timeout", "timeout"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") {
      args.help = true;
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
  args.out = path.resolve(args.out);
  args.timeout = Number(args.timeout);
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
    throw new Error("Invalid --timeout");
  }
  return args;
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

async function launchChromium(browserType, { channel }) {
  const attempts = channel ? [{ headless: false, channel }] : [
    { headless: false },
    { headless: false, channel: "chrome" },
    { headless: false, channel: "msedge" },
  ];
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

async function inspectAuthPage(page) {
  return page.evaluate(() => {
    const clean = (value, length = 200) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, length);
    const labelFor = (field) => {
      const aria = field.getAttribute("aria-label");
      if (aria) return clean(aria);
      const labelledBy = field.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.innerText || "")
          .join(" ");
        if (clean(text)) return clean(text);
      }
      if (field.id) {
        const label = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        if (label) return clean(label.innerText || label.textContent);
      }
      const wrapping = field.closest("label");
      if (wrapping) return clean(wrapping.innerText || wrapping.textContent);
      return clean(field.getAttribute("placeholder") || field.getAttribute("name"));
    };
    const fields = [...document.querySelectorAll("input,select,textarea")]
      .filter((field) => {
        const type = (field.getAttribute("type") || "").toLowerCase();
        return !["hidden", "submit", "button", "reset", "image"].includes(type);
      })
      .slice(0, 50)
      .map((field) => ({
        type: field.getAttribute("type") || field.tagName.toLowerCase(),
        name: field.getAttribute("name") || "",
        label: labelFor(field),
        required: field.hasAttribute("required"),
        autocomplete: field.getAttribute("autocomplete") || "",
      }));
    const text = clean(document.body?.innerText || "", 20000);
    return {
      url: location.href.replace(/([?&][^=]+)=[^&]*/g, "$1=<redacted>"),
      title: document.title,
      fields,
      challengeTypes: [
        fields.some((field) => field.type === "password") ? "password" : "",
        /(?:验证码|动态码|one.?time code|otp|2fa)/i.test(text) ? "otp" : "",
        /(?:captcha|recaptcha|hcaptcha|turnstile|滑块验证)/i.test(text) ? "captcha" : "",
        /(?:扫码|二维码|qrcode|qr code)/i.test(text) ? "qr" : "",
        /(?:google|github|微信|微博|qq|oauth|sso)/i.test(text) ? "oauth" : "",
      ].filter(Boolean),
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.url) throw new Error(`--url is required\n\n${usage()}`);
  const loginUrl = new URL(args.url);
  if (!["http:", "https:"].includes(loginUrl.protocol)) {
    throw new Error("Only http:// and https:// URLs are supported");
  }

  const playwright = await loadPlaywright();
  const browserType = playwright.chromium || playwright.default?.chromium;
  const browser = await launchChromium(browserType, { channel: args.channel });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: "en-US",
  });
  const page = await context.newPage();
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    await page.goto(loginUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: args.timeout,
    });
    await page.waitForTimeout(1000);
    const requirements = await inspectAuthPage(page);
    console.log(
      JSON.stringify(
        {
          detectedLoginRequirements: requirements,
          action:
            "Complete login in the opened browser, including QR, OTP, CAPTCHA, or password steps if requested.",
        },
        null,
        2,
      ),
    );
    await terminal.question("Press Enter after the authenticated account page is visible...");
    const final = await inspectAuthPage(page);
    const state = await context.storageState();
    await mkdir(path.dirname(args.out), { recursive: true });
    await writeFile(args.out, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(
      JSON.stringify(
        {
          savedTo: args.out,
          finalUrl: final.url,
          cookies: state.cookies.length,
          originsWithStorage: state.origins.length,
          note:
            "Treat this file as a secret. Keep it outside the rebuild evidence and never commit it.",
        },
        null,
        2,
      ),
    );
  } finally {
    terminal.close();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`capture_auth_state: ${error.stack || error.message}`);
  process.exitCode = 1;
});
