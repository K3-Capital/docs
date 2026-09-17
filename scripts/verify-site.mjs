#!/usr/bin/env node
/**
 * Verify an already-assembled site directory without rebuilding it.
 *
 * Usage:
 *   node scripts/verify-site.mjs [--out <dir>]
 *
 * Checks that every documentation set is served at its path, that / still redirects to
 * the vault docs, that no source-project Pages origin remains, and that every local link,
 * generated-artifact link and asset reference in the artifact resolves.
 */
import path from "node:path";
import process from "node:process";

import { DEFAULTS, DOC_SETS, verifySite } from "./lib/site.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex === -1 ? DEFAULTS.outDir : args[outIndex + 1];

if (!outDir) {
  console.error("Usage: node scripts/verify-site.mjs [--out <dir>]");
  process.exit(2);
}

const evidence = await verifySite({ outDir: path.resolve(outDir) });

for (const set of DOC_SETS) {
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
