#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  return `Usage:
  node reverse_site.mjs --url <https://...> --out <dir> [options]

Options:
  --max-pages <n>          Maximum crawl pages (default: 100)
  --max-depth <n>          Maximum link depth (default: 3)
  --storage-state <file>   Authorized Playwright storage state
  --include-user           Include account routes
  --resume                 Resume the crawl queue
  --channel <name>         Installed browser channel: chrome or msedge
  --headed                 Show the browser
  --help                   Show this help

The command runs the full public evidence pipeline in one process:
  1. Route, asset, style, source-map, and technology inventory.
  2. CSS dependency closure and cross-origin asset export.
  3. Stateful multi-route crawl with API schema inference.
  4. Login-gate detection and exact field/challenge requirements.
  5. Site graph, coverage, unresolved work, and rebuild evidence.

If login is required, the command stops with exit code 2 after recording what
the site asks for. Complete the login through capture_auth_state.mjs, then run
this command again with --storage-state <file> --resume.`;
}

function parseArgs(argv) {
  const args = {
    url: "",
    out: "",
    maxPages: 100,
    maxDepth: 3,
    storageState: "",
    includeUser: false,
    resume: false,
    channel: "",
    headed: false,
    help: false,
  };
  const values = new Map([
    ["--url", "url"],
    ["--out", "out"],
    ["--max-pages", "maxPages"],
    ["--max-depth", "maxDepth"],
    ["--storage-state", "storageState"],
    ["--channel", "channel"],
  ]);
  const booleans = new Map([
    ["--include-user", "includeUser"],
    ["--resume", "resume"],
    ["--headed", "headed"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") {
      args.help = true;
      continue;
    }
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
  for (const key of ["maxPages", "maxDepth"]) {
    args[key] = Number(args[key]);
    if (!Number.isInteger(args[key]) || args[key] < 0) {
      throw new Error(`Invalid numeric value: ${key}`);
    }
  }
  args.out = path.resolve(args.out || "web-rebuild-output");
  if (args.storageState) args.storageState = path.resolve(args.storageState);
  return args;
}

function runNode(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.url) throw new Error(`--url is required\n\n${usage()}`);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const inventoryScript = path.join(scriptDir, "inventory_site.mjs");
  const crawlScript = path.join(scriptDir, "crawl_site.mjs");
  const planScript = path.join(scriptDir, "plan_rebuild.mjs");
  await mkdir(args.out, { recursive: true });

  const commonBrowserArgs = [];
  if (args.channel) commonBrowserArgs.push("--channel", args.channel);
  if (args.headed) commonBrowserArgs.push("--headed");

  const inventoryCode = await runNode(inventoryScript, [
    "--url",
    args.url,
    "--out",
    args.out,
    "--export-assets",
    "--include-third-party",
    "--source-maps",
    "--extract-source-content",
    ...commonBrowserArgs,
  ]);
  if (inventoryCode !== 0) {
    console.error(`reverse_site: inventory stage failed with exit code ${inventoryCode}`);
    process.exitCode = inventoryCode;
    return;
  }

  const crawlArgs = [
    "--url",
    args.url,
    "--out",
    args.out,
    "--inventory",
    args.out,
    "--max-pages",
    String(args.maxPages),
    "--max-depth",
    String(args.maxDepth),
    ...commonBrowserArgs,
  ];
  if (args.includeUser) crawlArgs.push("--include-user");
  if (args.resume) crawlArgs.push("--resume");
  if (args.storageState) crawlArgs.push("--storage-state", args.storageState);
  const crawlCode = await runNode(crawlScript, crawlArgs);
  const planCode = await runNode(planScript, ["--out", args.out]);

  let authRequirements = null;
  try {
    authRequirements = JSON.parse(
      await readFile(path.join(args.out, "crawl", "auth-requirements.json"), "utf8"),
    );
  } catch {
    // The crawl may have failed before writing this artifact.
  }
  const orchestration = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    url: args.url,
    output: args.out,
    inventoryExitCode: inventoryCode,
    crawlExitCode: crawlCode,
    planExitCode: planCode,
    authentication: authRequirements,
    complete: crawlCode === 0 && planCode === 0,
  };
  await writeFile(
    path.join(args.out, "reverse-run.json"),
    `${JSON.stringify(orchestration, null, 2)}\n`,
    "utf8",
  );

  if (crawlCode === 2 && authRequirements) {
    const authenticationNeeded =
      (authRequirements.gatedRoutes?.length || 0) > 0 ||
      ((authRequirements.authPages?.length || 0) > 0 && !args.storageState);
    console.log(
      JSON.stringify(
        {
          status: authenticationNeeded ? "authorization-required" : "coverage-incomplete",
          methods: authRequirements.methods,
          requiredFields: authRequirements.requiredFields,
          gatedRoutes: authRequirements.gatedRoutes,
          next: authenticationNeeded
            ? "Report these requirements to the user. Use capture_auth_state.mjs for authorized manual login, then rerun with --storage-state and --resume."
            : "Increase --max-pages or --max-depth and resume. Review crawl/unresolved.json for the authoritative worklist.",
        },
        null,
        2,
      ),
    );
  }
  process.exitCode = crawlCode;
}

main().catch((error) => {
  console.error(`reverse_site: ${error.stack || error.message}`);
  process.exitCode = 1;
});
