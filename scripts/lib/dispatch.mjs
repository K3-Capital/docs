/**
 * The `repository_dispatch` contract between the documentation source repositories
 * (`k3-vault-docs`, `sBOLT-docs`) and this portal.
 *
 * A source repository pushes to `main`, mints a GitHub App installation token scoped to
 * this repository, and dispatches `DISPATCH_EVENT_TYPE` with the source repository and
 * commit in the payload. This portal is the only repository that assembles and deploys
 * the combined site, so it refuses anything else instead of rebuilding for an unknown
 * caller.
 *
 * Two independent checks decide whether a dispatch may rebuild the site:
 *
 *   1. `assertDispatchSender` — the *caller* must be the dedicated dispatcher GitHub App.
 *      A dispatch created with an App installation token carries that App's bot user as
 *      the event sender, so the sender is an identity GitHub authenticated, not a value
 *      the caller chose;
 *   2. `assertKnownSourceRepository` — the payload's repository must be a configured
 *      documentation source, so every rebuild is attributed to a real source.
 *
 * The payload alone is never sufficient. Any principal holding a token that can dispatch
 * to this repository can put any repository name in `client_payload`, which is exactly
 * why check 1 exists and why the payload is only read after the caller is known.
 */
import { DOC_SETS } from "./site.mjs";

/** `repository_dispatch` event type the source repositories send. */
export const DISPATCH_EVENT_TYPE = "docs-source-updated";

/**
 * The dedicated dispatcher GitHub App.
 *
 * It is installed on `K3-Capital/docs` only, with `Contents: Read and write`, so its
 * installation tokens reach this repository and no other, and are requested with the one
 * permission the repository dispatch endpoint requires. They carry no `pages`
 * permission, so the App can ask this portal to rebuild but can never publish the site
 * itself. The source repositories store its credentials; they never hold a token for
 * this repository itself.
 *
 * The App name is part of the contract: `<slug>[bot]` is the sender GitHub attributes to
 * every dispatch the App's tokens create, so the receiver pins the exact bot login. A
 * renamed App (or a different App used as the sender) fails the gate loudly instead of
 * silently rebuilding the site.
 */
export const DISPATCHER_APP_NAME = "k3-docs-dispatcher";

/** Bot login of the dispatcher App's user, as it appears in the event sender. */
export const DISPATCHER_BOT_LOGIN = `${DISPATCHER_APP_NAME}[bot]`;

/** `owner/name` of the repository behind a configured documentation set. */
export function sourceRepositoryOf(docSet) {
  return `K3-Capital/${docSet.repoDir.split("/").pop()}`;
}

/** The only repositories whose dispatches may trigger a deployment. */
export const KNOWN_SOURCE_REPOSITORIES = DOC_SETS.map(sourceRepositoryOf);

/**
 * Returns `sender` when the dispatch was created by the dedicated dispatcher App, and
 * throws otherwise. The sender comes from the event, not from the payload, so a dispatch
 * that merely *claims* to come from a documentation source is still rejected.
 */
export function assertDispatchSender(sender) {
  if (sender !== DISPATCHER_BOT_LOGIN) {
    throw new Error(
      `dispatch sender ${JSON.stringify(sender)} is not the docs dispatcher app: ` +
        `expected ${DISPATCHER_BOT_LOGIN} (GitHub App "${DISPATCHER_APP_NAME}", ` +
        `installed on K3-Capital/docs with "Contents: Read and write")`,
    );
  }
  return sender;
}

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

/**
 * The full authorization check for an incoming dispatch: an authenticated caller that is
 * the dispatcher App *and* a payload that names a configured documentation source.
 * Returns the accepted source repository.
 */
export function assertAuthorizedDispatch({ repository, sender }) {
  assertDispatchSender(sender);
  return assertKnownSourceRepository(repository);
}
