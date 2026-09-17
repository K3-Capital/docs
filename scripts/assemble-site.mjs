#!/usr/bin/env node
/**
 * Assemble the docs.k3.capital site from the documentation source builds and gate it.
 *
 * Usage:
 *   node scripts/assemble-site.mjs [--vault-build <dir>] [--sbolt-build <dir>] [--out <dir>] [--skip-verify]
 *
 * The source builds (_book) are produced by each source repository's own toolchain;
 * scripts/build-site.sh runs those builds and then calls this script.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULTS,
  SBOLT_DOC_SET,
  VAULT_DOC_SET,
  assembleDocSet,
  verifySite,
  writeSiteRoot,
} from "./lib/site.mjs";

const PROVIDERS = [
  {
    set: VAULT_DOC_SET,
    flag: "--vault-build",
    buildDir: () => path.join(DEFAULTS.vaultRepoDir, "_book"),
  },
  {
    set: SBOLT_DOC_SET,
    flag: "--sbolt-build",
    buildDir: () => path.join(DEFAULTS.sboltRepoDir, "_book"),
  },
];

function parseArgs(argv) {
  const options = {
    outDir: DEFAULTS.outDir,
    verify: true,
    buildDirs: new Map(PROVIDERS.map((provider) => [provider.set.key, provider.buildDir()])),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const provider = PROVIDERS.find((candidate) => candidate.flag === arg);
    switch (true) {
      case Boolean(provider):
        options.buildDirs.set(provider.set.key, argv[++i]);
        break;
      case arg === "--out":
        options.outDir = argv[++i];
        break;
      case arg === "--skip-verify":
        options.verify = false;
        break;
      case arg === "--help":
      case arg === "-h":
        console.log(
          "Usage: node scripts/assemble-site.mjs [--vault-build <dir>] [--sbolt-build <dir>] [--out <dir>] [--skip-verify]",
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(2);
    }
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));

await mkdir(options.outDir, { recursive: true });

const summary = [];
for (const { set } of PROVIDERS) {
  const buildDir = options.buildDirs.get(set.key);
  const { destination, rewritten, assets } = await assembleDocSet({
    buildDir,
    outDir: options.outDir,
    dirName: set.dirName,
    legacyOrigin: set.legacyOrigin,
    publicBaseUrl: set.publicBaseUrl,
  });

  console.log(`Assembled ${buildDir} -> ${destination}`);
  console.log(`  /${set.dirName}/: ${assets} asset file(s) copied, ${rewritten.length} file(s) rewritten`);
  for (const file of rewritten.slice(0, 5)) {
    console.log(`    rewrote: ${file}`);
  }
  if (rewritten.length > 5) {
    console.log(`    ... and ${rewritten.length - 5} more`);
  }
  summary.push({ set, assets });
}

await writeSiteRoot({ outDir: options.outDir });

console.log(`Assembled ${summary.length} documentation set(s) into ${options.outDir}`);

if (options.verify) {
  const evidence = await verifySite({ outDir: options.outDir });
  for (const set of PROVIDERS.map((provider) => provider.set)) {
    const figures = evidence.perSet[set.key];
    console.log(
      `Verified: /${figures.dirName}/ serves the ${set.label} (${figures.pages} HTML pages, ` +
        `${figures.assetReferences} asset reference(s), ${figures.artifactLinks} generated-artifact link(s), 0 broken)`,
    );
    for (const url of figures.exemptedArtifactLinks) {
      console.log(`  note: tracked pre-existing upstream 404, exempted: ${url}`);
    }
  }
  console.log(`Verified: / redirects to /${DEFAULTS.rootRedirectDirName}/ with a relative target`);
  console.log("Verified: no source-project GitHub Pages origin remains in the artifact");
  console.log(
    `Verified: artifact-wide ${evidence.pages} HTML pages, ${evidence.linksChecked} local links checked, 0 broken`,
  );
  console.log(
    `Verified: ${evidence.mermaidRendered}/${evidence.mermaidBlocks} Mermaid block(s) rendered as inline SVG (0 published as raw source)`,
  );
}
