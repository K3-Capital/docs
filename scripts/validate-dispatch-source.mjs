#!/usr/bin/env node
/**
 * Authorizes an incoming `repository_dispatch` before the portal builds anything.
 *
 * Run from `.github/workflows/deploy.yml` with `DISPATCH_SENDER` and
 * `DISPATCH_REPOSITORY` in the environment (never interpolated into the shell). Exits
 * non-zero unless the dispatch was created by the dedicated dispatcher App and its
 * payload names a configured documentation source.
 */
import { assertAuthorizedDispatch } from "./lib/dispatch.mjs";

try {
  const repository = assertAuthorizedDispatch({
    repository: process.env.DISPATCH_REPOSITORY,
    sender: process.env.DISPATCH_SENDER,
  });
  console.log(`dispatch accepted: ${process.env.DISPATCH_SENDER} -> ${repository}`);
} catch (error) {
  console.error(`dispatch rejected: ${error.message}`);
  process.exit(1);
}
