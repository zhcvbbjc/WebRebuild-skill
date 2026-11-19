#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MOTION_SELECTOR = [
  "[class*='swiper']",
  "[class*='carousel']",
  "[class*='slider']",
  "[class*='slick']",
  "[class*='marquee']",
  "[aria-roledescription='carousel']",
].join(",");

function usage() {
  return `Usage:
  node compare_sites.mjs --reference <url> --candidate <url> [options]

Options:
  --out <dir>             Report directory (default: verification)
  --width <px>            Viewport width (default: 1440)
  --height <px>           Viewport height (default: 1000)
  --wait <ms>             Settle time after network idle (default: 1200)
  --timeout <ms>          Navigation timeout (default: 45000)
  --headed                Show the browsers
  --channel <name>        Installed browser channel: chrome or msedge
  --full-page             Save full-page screenshots (diff may use a shorter common area)
  --help                  Show this help

Both pages use the same locale, timezone, viewport, reduced-motion preference,
and animation-disabling stylesheet. The report compares viewport pixels and a
compact set of visible DOM semantics.`;
}

function parseArgs(argv) {
  const args = {
    reference: "",
    candidate: "",
    out: path.resolve("verification"),
    width: 1440,
    height: 1000,
    wait: 1200,
    timeout: 45000,
    headed: false,
    channel: "",
    fullPage: false,
    help: false,
  };
  const values = new Map([
    ["--reference", "reference"],
    ["--candidate", "candidate"],
    ["--out", "out"],
    ["--width", "width"],
    ["--height", "height"],
    ["--wait", "wait"],
    ["--timeout", "timeout"],
    ["--channel", "channel"],
  ]);
  const booleans = new Map([
    ["--headed", "headed"],
    ["--full-page", "fullPage"],
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

  for (const key of ["width", "height", "wait", "timeout"]) {
    args[key] = Number(args[key]);
    if (!Number.isFinite(args[key]) || args[key] <= 0) {
      throw new Error(`Invalid numeric value: ${key}`);
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
  throw new Error(
    "Playwright is not available. Run `npm install` in the web-rebuild skill directory or perform the same comparison with browser tools.",
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizedSet(values) {
  return new Set(
    values
      .map((value) =>
        String(value)
          .toLowerCase()
          .replace(/\s+/g, " ")
          .replace(/[^\p{L}\p{N} ]/gu, "")
          .trim(),
      )
      .filter(Boolean),
  );
}

function jaccard(referenceValues, candidateValues) {
  const a = normalizedSet(referenceValues);
  const b = normalizedSet(candidateValues);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

async function captureSite({ browserType, url, args, label }) {
  const browser = await launchChromium(browserType, {
    headless: !args.headed,
    channel: args.channel,
  });
  const context = await browser.newContext({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const consoleEntries = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()) && consoleEntries.length < 100) {
      consoleEntries.push({ type: message.type(), text: message.text().slice(0, 1000) });
    }
  });
  page.on("pageerror", (error) => {
    if (pageErrors.length < 50) pageErrors.push(String(error).slice(0, 1000));
  });
  page.on("requestfailed", (request) => {
    if (failedRequests.length < 100) {
      failedRequests.push({
        url: request.url().replace(/\?.*$/, ""),
        reason: request.failure()?.errorText || "request failed",
      });
    }
  });

  const response = await page.goto(url.href, {
    waitUntil: "domcontentloaded",
    timeout: args.timeout,
  });
  await page
    .waitForLoadState("networkidle", { timeout: Math.max(5000, args.timeout / 2) })
    .catch(() => {});
  await page.waitForTimeout(args.wait);
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
        caret-color: transparent !important;
      }
      html { scroll-behavior: auto !important; }
    `,
  });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.activeElement?.blur?.();
  });
  await page.waitForTimeout(100);

  const evidence = await page.evaluate((motionSelector) => {
    const clean = (value, length = 300) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, length);
    const selectors = [
      "body",
      "header",
      "nav",
      "main",
      "footer",
      "h1",
      "h2",
      "h3",
      "button",
      "input",
      "[role=button]",
    ];
    const boxes = [];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      boxes.push({
        selector,
        tag: element.tagName.toLowerCase(),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        display: style.display,
        visibility: style.visibility,
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
      });
    }
    const visibleText = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const motionRegions = [...document.querySelectorAll(motionSelector)]
      .filter(visibleText)
      .slice(0, 100)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector: motionSelector,
          className: String(element.className || "").slice(0, 300),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      });
    const linkEvidence = [...document.querySelectorAll("a[href]")]
      .filter(visibleText)
      .slice(0, 500)
      .map((anchor) => {
        let pathname = "";
        try {
          pathname = new URL(anchor.href).pathname;
        } catch {
          pathname = "";
        }
        return {
          text: clean(anchor.innerText || anchor.getAttribute("aria-label"), 160),
          pathname,
          insideMotionRegion: Boolean(anchor.closest(motionSelector)),
        };
      });
    return {
      url: location.href.replace(/([?&][^=]+)=[^&]*/g, "$1=<redacted>"),
      title: document.title,
      lang: document.documentElement.lang,
      viewport: { width: innerWidth, height: innerHeight },
      documentSize: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
        .filter(visibleText)
        .slice(0, 300)
        .map((heading) => clean(heading.innerText || heading.textContent, 300)),
      buttons: [...document.querySelectorAll("button,[role=button],input[type=submit]")]
        .filter(visibleText)
        .slice(0, 300)
        .map((button) =>
          clean(button.innerText || button.value || button.getAttribute("aria-label"), 160),
        ),
      links: linkEvidence,
      motionRegions,
      counts: {
        headings: document.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
        links: document.querySelectorAll("a[href]").length,
        buttons: document.querySelectorAll("button,[role=button],input[type=submit]").length,
        images: document.images.length,
        forms: document.forms.length,
      },
      boxes,
      accessibility: {
        language: document.documentElement.lang || "",
        headingsWithoutText: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(
          (heading) => !clean(heading.innerText || heading.getAttribute("aria-label")),
        ).length,
        imagesWithoutAlt: [...document.images].filter((image) => !image.hasAttribute("alt")).length,
        inputsWithoutLabel: [...document.querySelectorAll("input,select,textarea")].filter(
          (field) => {
            if (field.getAttribute("aria-label") || field.getAttribute("aria-labelledby")) return false;
            if (field.id && document.querySelector(`label[for="${CSS.escape(field.id)}"]`)) return false;
            return !field.closest("label");
          },
        ).length,
      },
    };
  }, MOTION_SELECTOR);

  const motionMatches = await page.locator(MOTION_SELECTOR).count();

  const screenshot = await page.screenshot({
    type: "png",
    fullPage: args.fullPage,
    animations: "disabled",
    mask: motionMatches > 0 ? [page.locator(MOTION_SELECTOR)] : [],
  });
  await context.close();
  await browser.close();
  return {
    label,
    url: redactedUrl(url.href),
    status: response?.status() ?? null,
    evidence,
    screenshot,
    console: consoleEntries,
    pageErrors,
    failedRequests,
  };
}

async function pixelDiff({ browserType, referenceBuffer, candidateBuffer }) {
  const browser = await launchChromium(browserType, {
    headless: true,
    channel: "",
  });
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async ({ referenceDataUrl, candidateDataUrl }) => {
        const load = (src) =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = src;
          });
        const [referenceImage, candidateImage] = await Promise.all([
          load(referenceDataUrl),
          load(candidateDataUrl),
        ]);
        const width = Math.min(referenceImage.width, candidateImage.width);
        const height = Math.min(referenceImage.height, candidateImage.height);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(referenceImage, 0, 0);
        const referencePixels = context.getImageData(0, 0, width, height);
        context.clearRect(0, 0, width, height);
        context.drawImage(candidateImage, 0, 0);
        const candidatePixels = context.getImageData(0, 0, width, height);

        const threshold = 24;
        let changedPixels = 0;
        let totalDifference = 0;
        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;
        const diffCanvas = document.createElement("canvas");
        diffCanvas.width = width;
        diffCanvas.height = height;
        const diffContext = diffCanvas.getContext("2d");
        const diffPixels = diffContext.createImageData(width, height);

        for (let offset = 0; offset < referencePixels.data.length; offset += 4) {
          const red = Math.abs(referencePixels.data[offset] - candidatePixels.data[offset]);
          const green = Math.abs(
            referencePixels.data[offset + 1] - candidatePixels.data[offset + 1],
          );
          const blue = Math.abs(
            referencePixels.data[offset + 2] - candidatePixels.data[offset + 2],
          );
          const alpha = Math.abs(
            referencePixels.data[offset + 3] - candidatePixels.data[offset + 3],
          );
          const difference = red + green + blue + alpha;
          totalDifference += difference;
          const pixelIndex = offset / 4;
          const x = pixelIndex % width;
          const y = Math.floor(pixelIndex / width);

          if (red + green + blue >= threshold) {
            changedPixels += 1;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            diffPixels.data[offset] = 255;
            diffPixels.data[offset + 1] = 0;
            diffPixels.data[offset + 2] = 190;
            diffPixels.data[offset + 3] = 255;
          } else {
            const luminance =
              0.2126 * referencePixels.data[offset] +
              0.7152 * referencePixels.data[offset + 1] +
              0.0722 * referencePixels.data[offset + 2];
            const faded = Math.round(210 + luminance * 0.15);
            diffPixels.data[offset] = faded;
            diffPixels.data[offset + 1] = faded;
            diffPixels.data[offset + 2] = faded;
            diffPixels.data[offset + 3] = 255;
          }
        }
        diffContext.putImageData(diffPixels, 0, 0);
        const totalPixels = width * height;
        return {
          imageWidth: width,
          imageHeight: height,
          referenceSize: { width: referenceImage.width, height: referenceImage.height },
          candidateSize: { width: candidateImage.width, height: candidateImage.height },
          comparedPixels: totalPixels,
          changedPixels,
          changedRatio: totalPixels ? changedPixels / totalPixels : 0,
          meanChannelDifference: totalPixels
            ? totalDifference / (totalPixels * 4 * 255)
            : 0,
          changedBounds:
            changedPixels > 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
          diffDataUrl: diffCanvas.toDataURL("image/png"),
        };
      },
      {
        referenceDataUrl: `data:image/png;base64,${referenceBuffer.toString("base64")}`,
        candidateDataUrl: `data:image/png;base64,${candidateBuffer.toString("base64")}`,
      },
    );
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function boxSimilarity(referenceBoxes, candidateBoxes) {
  const candidateBySelector = new Map(candidateBoxes.map((box) => [box.selector, box]));
  const values = [];
  for (const reference of referenceBoxes) {
    const candidate = candidateBySelector.get(reference.selector);
    if (!candidate) {
      values.push(0);
      continue;
    }
    const width = Math.max(reference.rect.width, candidate.rect.width, 1);
    const height = Math.max(reference.rect.height, candidate.rect.height, 1);
    const positionDelta =
      Math.abs(reference.rect.x - candidate.rect.x) / Math.max(reference.rect.x + width, 1) +
      Math.abs(reference.rect.y - candidate.rect.y) / Math.max(reference.rect.y + height, 1);
    const sizeDelta =
      Math.abs(reference.rect.width - candidate.rect.width) / width +
      Math.abs(reference.rect.height - candidate.rect.height) / height;
    values.push(Math.max(0, 1 - positionDelta / 2 - sizeDelta / 2));
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 1;
}

function reportHtml({ reference, candidate, comparison }) {
  const issueItems = comparison.issues.length
    ? comparison.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")
    : "<li>No automated differences detected in the compared dimensions.</li>";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Web rebuild comparison</title>
  <style>
    body { margin: 0; padding: 24px; font: 15px/1.5 system-ui, sans-serif; background: #f5f5f2; color: #181817; }
    h1 { margin-top: 0; }
    .meta { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    figure { margin: 0; padding: 12px; background: white; border: 1px solid #ddd; border-radius: 10px; }
    img { width: 100%; height: auto; display: block; }
    figcaption { margin-bottom: 8px; font-weight: 600; }
    ul { background: white; border: 1px solid #ddd; border-radius: 10px; padding: 18px 18px 18px 38px; }
    code { overflow-wrap: anywhere; }
    @media (max-width: 1000px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Web rebuild comparison</h1>
  <div class="meta">
    <strong>Reference</strong><code>${escapeHtml(reference.url)}</code>
    <strong>Candidate</strong><code>${escapeHtml(candidate.url)}</code>
    <strong>Viewport</strong><span>${comparison.viewport.width} × ${comparison.viewport.height}</span>
    <strong>Pixel difference</strong><span>${(comparison.pixels.changedRatio * 100).toFixed(2)}%</span>
    <strong>Heading similarity</strong><span>${(comparison.headingsSimilarity * 100).toFixed(1)}%</span>
    <strong>Link-target similarity</strong><span>${(comparison.linkTargetsSimilarity * 100).toFixed(1)}%</span>
    <strong>Link-label similarity</strong><span>${(comparison.linkLabelsSimilarity * 100).toFixed(1)}%</span>
    <strong>Box similarity</strong><span>${(comparison.boxSimilarity * 100).toFixed(1)}%</span>
  </div>
  <h2>Prioritized issues</h2>
  <ul>${issueItems}</ul>
  <h2>Visual evidence</h2>
  <div class="grid">
    <figure><figcaption>Reference</figcaption><img src="reference.png" alt="Reference site"></figure>
    <figure><figcaption>Candidate</figcaption><img src="candidate.png" alt="Candidate site"></figure>
    <figure><figcaption>Difference</figcaption><img src="diff.png" alt="Pixel difference"></figure>
  </div>
</body>
</html>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.reference || !args.candidate) {
    throw new Error(`--reference and --candidate are required\n\n${usage()}`);
  }
  const referenceUrl = ensureHttpUrl(args.reference);
  const candidateUrl = ensureHttpUrl(args.candidate);
  const playwright = await loadPlaywright();
  const browserType = playwright.chromium || playwright.default?.chromium;
  if (!browserType) throw new Error("Playwright did not expose a Chromium browser");

  await mkdir(args.out, { recursive: true });
  const reference = await captureSite({
    browserType,
    url: referenceUrl,
    args,
    label: "reference",
  });
  const candidate = await captureSite({
    browserType,
    url: candidateUrl,
    args,
    label: "candidate",
  });
  const pixels = await pixelDiff({
    browserType,
    referenceBuffer: reference.screenshot,
    candidateBuffer: candidate.screenshot,
  });

  const headingsSimilarity = jaccard(reference.evidence.headings, candidate.evidence.headings);
  const linkLabelsSimilarity = jaccard(
    reference.evidence.links.map((link) => link.text),
    candidate.evidence.links.map((link) => link.text),
  );
  const linkTargetsSimilarity = jaccard(
    reference.evidence.links
      .filter((link) => !link.insideMotionRegion)
      .map((link) => link.pathname),
    candidate.evidence.links
      .filter((link) => !link.insideMotionRegion)
      .map((link) => link.pathname),
  );
  const linksSimilarity = linkTargetsSimilarity * 0.75 + linkLabelsSimilarity * 0.25;
  const boxesSimilarity = boxSimilarity(reference.evidence.boxes, candidate.evidence.boxes);
  const issues = [];
  if (reference.status !== 200 || candidate.status !== 200) {
    issues.push(
      `HTTP status differs: reference ${reference.status}, candidate ${candidate.status}.`,
    );
  }
  if (pixels.changedRatio > 0.02) {
    issues.push(
      `Visual difference is ${(pixels.changedRatio * 100).toFixed(2)}%; inspect the largest changed region first.`,
    );
  }
  if (headingsSimilarity < 0.9) {
    issues.push(`Visible heading content similarity is ${(headingsSimilarity * 100).toFixed(1)}%.`);
  }
  if (linkTargetsSimilarity < 0.9) {
    issues.push(`Link-target similarity is ${(linkTargetsSimilarity * 100).toFixed(1)}%.`);
  }
  if (linkLabelsSimilarity < 0.75) {
    issues.push(`Link-label similarity is ${(linkLabelsSimilarity * 100).toFixed(1)}%.`);
  }
  if (boxesSimilarity < 0.85) {
    issues.push(`Key element geometry similarity is ${(boxesSimilarity * 100).toFixed(1)}%.`);
  }
  if (reference.pageErrors.length !== candidate.pageErrors.length) {
    issues.push(
      `Page-error count differs: reference ${reference.pageErrors.length}, candidate ${candidate.pageErrors.length}.`,
    );
  }
  for (const key of ["headingsWithoutText", "imagesWithoutAlt", "inputsWithoutLabel"]) {
    const referenceValue = reference.evidence.accessibility[key];
    const candidateValue = candidate.evidence.accessibility[key];
    if (candidateValue > referenceValue) {
      issues.push(`${key} is worse in the candidate (${candidateValue} versus ${referenceValue}).`);
    }
  }

  const comparison = {
    schemaVersion: 1,
    tool: "web-rebuild/compare_sites",
    generatedAt: new Date().toISOString(),
    viewport: { width: args.width, height: args.height },
    reference: {
      url: reference.url,
      status: reference.status,
      evidence: reference.evidence,
      console: reference.console,
      pageErrors: reference.pageErrors,
      failedRequests: reference.failedRequests,
    },
    candidate: {
      url: candidate.url,
      status: candidate.status,
      evidence: candidate.evidence,
      console: candidate.console,
      pageErrors: candidate.pageErrors,
      failedRequests: candidate.failedRequests,
    },
    pixels,
    headingsSimilarity,
    linksSimilarity,
    linkLabelsSimilarity,
    linkTargetsSimilarity,
    boxSimilarity: boxesSimilarity,
    issues,
    caveats: [
      "A pixel comparison covers only the captured viewport and settled state.",
      "Common carousel, slider, marquee, and Slick regions are masked because their active state can be time-dependent.",
      "Verify interactions, responsive breakpoints, focus states, and data/error states separately.",
      "Cosmetic thresholds are diagnostic defaults, not universal fidelity requirements.",
    ],
  };

  const diffMatch = /^data:image\/png;base64,(.+)$/.exec(pixels.diffDataUrl);
  const diffBuffer = diffMatch ? Buffer.from(diffMatch[1], "base64") : null;
  await writeFile(path.join(args.out, "reference.png"), reference.screenshot);
  await writeFile(path.join(args.out, "candidate.png"), candidate.screenshot);
  if (diffBuffer) await writeFile(path.join(args.out, "diff.png"), diffBuffer);
  await writeFile(
    path.join(args.out, "report.json"),
    `${JSON.stringify(comparison, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(args.out, "index.html"),
    reportHtml({ reference, candidate, comparison }),
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        out: args.out,
        pixelDifference: Number((pixels.changedRatio * 100).toFixed(3)),
        headingsSimilarity: Number((headingsSimilarity * 100).toFixed(2)),
        linksSimilarity: Number((linksSimilarity * 100).toFixed(2)),
        linkLabelsSimilarity: Number((linkLabelsSimilarity * 100).toFixed(2)),
        linkTargetsSimilarity: Number((linkTargetsSimilarity * 100).toFixed(2)),
        boxSimilarity: Number((boxesSimilarity * 100).toFixed(2)),
        issues,
        report: path.join(args.out, "index.html"),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`compare_sites: ${error.stack || error.message}`);
  process.exitCode = 1;
});
