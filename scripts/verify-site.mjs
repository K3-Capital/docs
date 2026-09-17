#!/usr/bin/env node
/**
 * Verify an already-assembled site directory without rebuilding it.
 *
 * Usage:
 *   node scripts/verify-site.mjs [--out <dir>]
 *
 * Checks that /<vault dir>/ serves the vault docs, that / redirects there, that no
 * legacy origin reference remains, and that every local link in the artifact resolves.
 */
import path from "node:path";
import process from "node:process";

import { DEFAULTS, verifySite } from "./lib/site.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex === -1 ? DEFAULTS.outDir : args[outIndex + 1];

if (!outDir) {
  console.error("Usage: node scripts/verify-site.mjs [--out <dir>]");
  process.exit(2);
}

const evidence = await verifySite({ outDir: path.resolve(outDir) });

console.log(
  `Verified: /${evidence.vaultDirName}/ serves the vault docs (${evidence.pages} HTML pages, ${evidence.linksChecked} local links checked, 0 broken)`,
);
console.log(`Verified: / redirects to /${evidence.vaultDirName}/`);
console.log(`Verified: no reference to ${DEFAULTS.legacyOrigin} remains in the artifact`);