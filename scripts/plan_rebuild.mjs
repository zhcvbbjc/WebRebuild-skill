#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  return `Usage:
  node plan_rebuild.mjs --out <inventory-dir>

Reads inventory.json, runtime/routes.json, crawl/route-coverage.json,
crawl/api-contracts.json, crawl/interaction-map.json, and
crawl/auth-requirements.json. Writes rebuild-plan.json and rebuild-brief.md.
Missing artifacts are reported as gaps rather than treated as success.`;
}

function parseArgs(argv) {
  const args = { out: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") {
      args.help = true;
      continue;
    }
    if (flag === "--out") {
      const value = argv[index + 1];
      if (!value) throw new Error("--out requires a value");
      args.out = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

async function optionalJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function escapeMarkdown(value) {
  return String(value || "").replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.out) throw new Error(`--out is required\n\n${usage()}`);
  const inventory = await optionalJson(path.join(args.out, "inventory.json"), null);
  const routeInventory = await optionalJson(path.join(args.out, "runtime", "routes.json"), []);
  const coverage = await optionalJson(path.join(args.out, "crawl", "route-coverage.json"), null);
  const apiContracts = await optionalJson(path.join(args.out, "crawl", "api-contracts.json"), {
    contracts: [],
  });
  const interactions = await optionalJson(path.join(args.out, "crawl", "interaction-map.json"), {
    interactions: [],
  });
  const auth = await optionalJson(path.join(args.out, "crawl", "auth-requirements.json"), null);
  const unresolved = await optionalJson(path.join(args.out, "crawl", "unresolved.json"), null);

  if (!inventory) {
    throw new Error(`inventory.json not found under ${args.out}`);
  }

  const gaps = [];
  if (!coverage) gaps.push("No full crawl coverage file was found.");
  if (unresolved?.queuedRemaining?.length) {
    gaps.push(`${unresolved.queuedRemaining.length} discovered URLs remain queued.`);
  }
  if (auth?.gatedRoutes?.length) {
    gaps.push(`${auth.gatedRoutes.length} authenticated routes remain gated.`);
  }
  if (!apiContracts.contracts?.length) {
    gaps.push("No sanitized API response contract was observed.");
  }
  if (!inventory.counts?.sourceMaps) {
    gaps.push("No source map was observed.");
  }

  const coverageByPattern = new Map(
    (coverage?.routeTemplates || []).map((group) => [group.pattern, group]),
  );
  const pageFamilies = routeInventory.map((route) => {
    const crawled = coverageByPattern.get(route.pattern);
    return {
      routeTemplate: route.pattern,
      discoveredLinks: route.count,
      samples: route.sampleUrls || [],
      crawlSucceeded: crawled?.succeeded || 0,
      crawlFailed: crawled?.failed || 0,
      authRequired: crawled?.authRequired || 0,
      status:
        crawled?.failed > 0
          ? "has-failures"
          : crawled?.succeeded > 0
            ? "sampled"
            : "not-sampled",
    };
  });

  const phases = [
    {
      id: "foundation",
      title: "Application foundation",
      outputs: [
        "Runnable project with fixed viewport and browser baselines",
        "Shared layout, navigation, typography, colors, and CSS token layer",
        "Asset manifest with provenance and licensing status",
      ],
      exitCriteria: [
        "Shared shell renders without unresolved local asset URLs",
        "Desktop and mobile screenshots have no structural regressions",
      ],
    },
    {
      id: "routes",
      title: "Route-family implementation",
      outputs: pageFamilies.map((family) => `${family.routeTemplate} page family`),
      exitCriteria: [
        "Every sampled route family renders its primary content",
        "Pagination, empty state, and not-found behavior are represented",
      ],
    },
    {
      id: "interactions",
      title: "Interaction and state model",
      outputs: interactions.interactions.map(
        (interaction) => `${interaction.routeTemplate}: ${interaction.intent} (${interaction.count})`,
      ),
      exitCriteria: [
        "Tabs, filters, dialogs, search, loading, and error states are exercised",
        "Mutation controls cannot silently call the original production service",
      ],
    },
    {
      id: "services",
      title: "API and data boundaries",
      outputs: apiContracts.contracts.map(
        (contract) => `${contract.method} ${contract.urlPattern}`,
      ),
      exitCriteria: [
        "Observed response shapes are validated at local API boundaries",
        "Unknown or gated services are explicit adapters or deterministic fixtures",
      ],
    },
    {
      id: "verification",
      title: "Fidelity and regression gate",
      outputs: [
        "Original-versus-local comparison report for each page family",
        "Interaction, accessibility, responsive, and network verification records",
      ],
      exitCriteria: [
        "No unresolved high-impact differences in the agreed route scope",
        "Every known limitation is documented in the handoff",
      ],
    },
  ];

  const plan = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: inventory.finalUrl,
    technology: inventory.framework,
    rendering: inventory.rendering,
    counts: inventory.counts,
    pageFamilies,
    apiContracts: apiContracts.contracts || [],
    interactions: interactions.interactions || [],
    authentication: auth,
    gaps,
    phases,
    status: gaps.length ? "evidence-incomplete" : "implementation-ready",
  };
  await writeFile(
    path.join(args.out, "rebuild-plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
    "utf8",
  );

  const routeRows = pageFamilies
    .map(
      (family) =>
        `| \`${escapeMarkdown(family.routeTemplate)}\` | ${family.discoveredLinks} | ${family.crawlSucceeded} | ${family.authRequired} | ${escapeMarkdown(family.status)} |`,
    )
    .join("\n");
  const gapsMarkdown = gaps.length
    ? gaps.map((gap) => `- ${gap}`).join("\n")
    : "- No evidence-level gaps were detected by the deterministic planner.";
  const phaseMarkdown = phases
    .map(
      (phase, index) =>
        `${index + 1}. **${phase.title}**\n   - Outputs: ${phase.outputs.join("; ") || "none detected"}\n   - Exit: ${phase.exitCriteria.join("; ")}`,
    )
    .join("\n");
  const brief = `# Rebuild brief

Source: ${inventory.finalUrl}  
Technology: ${inventory.framework?.primary || "unknown"}  
Rendering: ${inventory.rendering?.mode || inventory.framework?.delivery || "unknown"}  
Plan status: **${plan.status}**

## Page families

| Route template | Discovered | Sampled | Auth required | Status |
| --- | ---: | ---: | ---: | --- |
${routeRows || "| none | 0 | 0 | 0 | not-sampled |"}

## Evidence gaps

${gapsMarkdown}

## Implementation phases

${phaseMarkdown}

## Required handoff

- Project run command and entry URL.
- Extracted, recovered, inferred, and hand-written code inventory.
- Route and interaction coverage matrix.
- Auth, API, asset, and content limitations.
- Licensing review for third-party themes, images, fonts, and media.
`;
  await writeFile(path.join(args.out, "rebuild-brief.md"), brief, "utf8");
  console.log(
    JSON.stringify(
      {
        out: args.out,
        status: plan.status,
        pageFamilies: pageFamilies.length,
        apiContracts: plan.apiContracts.length,
        interactionGroups: plan.interactions.length,
        gaps: gaps.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`plan_rebuild: ${error.stack || error.message}`);
  process.exitCode = 1;
});
