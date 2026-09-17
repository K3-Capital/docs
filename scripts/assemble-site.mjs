#!/usr/bin/env node
/**
 * Assemble the docs.k3.capital site from the documentation source builds and gate it.
 *
 * Usage:
 *   node scripts/assemble-site.mjs [--vault-build <dir>] [--out <dir>] [--skip-verify]
 *
 * The vault docs build (_book) is produced by the source repository's own toolchain;
 * scripts/build-site.sh runs that build and then calls this script.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULTS,
  assembleVaultDocs,
  verifySite,
  writeSiteRoot,
} from "./lib/site.mjs";

function parseArgs(argv) {
  const options = {
    vaultBuildDir: path.join(DEFAULTS.vaultRepoDir, "_book"),
    outDir: DEFAULTS.outDir,
    verify: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--vault-build":
        options.vaultBuildDir = argv[++i];
        break;
      case "--out":
        options.outDir = argv[++i];
        break;
      case "--skip-verify":
        options.verify = false;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: node scripts/assemble-site.mjs [--vault-build <dir>] [--out <dir>] [--skip-verify]",
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

const { destination, rewritten } = await assembleVaultDocs({
  vaultBuildDir: options.vaultBuildDir,
  outDir: options.outDir,
});

await writeSiteRoot({ outDir: options.outDir });

console.log(`Assembled ${options.vaultBuildDir} -> ${destination}`);
console.log(`Copied 1 documentation set; rewrote legacy origin in ${rewritten.length} file(s)`);
for (const file of rewritten.slice(0, 5)) {
  console.log(`  rewrote: ${file}`);
}
if (rewritten.length > 5) {
  console.log(`  ... and ${rewritten.length - 5} more`);
}

if (options.verify) {
  const evidence = await verifySite({ outDir: options.outDir });
  console.log(
    `Verified: /${evidence.vaultDirName}/ serves the vault docs (${evidence.pages} HTML pages, ${evidence.linksChecked} local links checked, 0 broken)`,
  );
  console.log("Verified: / redirects to /vault-infra/");
  console.log(`Verified: no reference to ${DEFAULTS.legacyOrigin} remains in the artifact`);
}
