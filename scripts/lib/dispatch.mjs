/**
 * The `repository_dispatch` contract between the documentation source repositories
 * (`k3-vault-docs`, `sBOLT-docs`) and this portal.
 *
 * A source repository pushes to `main`, mints a GitHub App token scoped to this
 * repository, and dispatches `DISPATCH_EVENT_TYPE` with the source repository and
 * commit in the payload. This portal is the only repository that assembles and
 * deploys the combined site, so it accepts a dispatch from the configured sources
 * and refuses anything else instead of rebuilding for an unknown caller.
 */
import { DOC_SETS } from "./site.mjs";

/** `repository_dispatch` event type the source repositories send. */
export const DISPATCH_EVENT_TYPE = "docs-source-updated";

/** `owner/name` of the repository behind a configured documentation set. */
export function sourceRepositoryOf(docSet) {
  return `K3-Capital/${docSet.repoDir.split("/").pop()}`;
}

/** The only repositories whose dispatches may trigger a deployment. */
export const KNOWN_SOURCE_REPOSITORIES = DOC_SETS.map(sourceRepositoryOf);

/**
 * Returns `repository` when it is a configured documentation source, and throws
 * otherwise. The dispatched repository name comes from the event payload, so an
 * unexpected value fails the run instead of silently building the site.
 */
export function assertKnownSourceRepository(repository) {
  if (!KNOWN_SOURCE_REPOSITORIES.includes(repository)) {
    throw new Error(
      `unknown documentation source repository ${JSON.stringify(repository)}: ` +
        `expected one of ${KNOWN_SOURCE_REPOSITORIES.join(", ")}`,
    );
  }
  return repository;
}
