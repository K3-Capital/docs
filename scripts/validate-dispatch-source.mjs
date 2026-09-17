#!/usr/bin/env node
/**
 * Validates the `repository_dispatch` payload of a documentation rebuild.
 *
 * Run from `.github/workflows/deploy.yml` with `DISPATCH_REPOSITORY` in the
 * environment (never interpolated into the shell). Exits non-zero when the
 * dispatching repository is not one of the configured documentation sources.
 */
import { assertKnownSourceRepository } from "./lib/dispatch.mjs";

try {
  const repository = assertKnownSourceRepository(process.env.DISPATCH_REPOSITORY);
  console.log(`dispatch source accepted: ${repository}`);
} catch (error) {
  console.error(`dispatching repository rejected: ${error.message}`);
  process.exit(1);
}
