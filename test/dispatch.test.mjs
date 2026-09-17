import assert from "node:assert/strict";
import test from "node:test";

import {
  DISPATCH_EVENT_TYPE,
  DISPATCHER_APP_NAME,
  DISPATCHER_BOT_LOGIN,
  KNOWN_SOURCE_REPOSITORIES,
  assertAuthorizedDispatch,
  assertDispatchSender,
  assertKnownSourceRepository,
  sourceRepositoryOf,
} from "../scripts/lib/dispatch.mjs";
import { DOC_SETS } from "../scripts/lib/site.mjs";
import { extractRunSteps, readWorkflow } from "../scripts/lib/workflow.mjs";

const workflow = await readWorkflow();
const VALIDATE_STEP = "Validate the dispatch source";

/** The pre-fix gate: it accepted any caller whose payload named a known source. */
function payloadOnlyGate({ repository }) {
  return assertKnownSourceRepository(repository);
}

test("every configured doc set has a known source repository", () => {
  assert.deepEqual(KNOWN_SOURCE_REPOSITORIES, [
    "K3-Capital/k3-vault-docs",
    "K3-Capital/sBOLT-docs",
  ]);
  for (const set of DOC_SETS) {
    assert.equal(sourceRepositoryOf(set), `K3-Capital/${set.repoDir.split("/").pop()}`);
  }
});

test("the validator accepts the configured sources and rejects anything else", () => {
  for (const repository of KNOWN_SOURCE_REPOSITORIES) {
    assert.equal(assertKnownSourceRepository(repository), repository);
  }

  for (const bad of [
    undefined,
    "",
    "K3-Capital/docs",
    "attacker/docs",
    "K3-Capital/k3-vault-docs ",
    "k3-capital/k3-vault-docs",
  ]) {
    assert.throws(
      () => assertKnownSourceRepository(bad),
      /unknown documentation source repository/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test("only the dispatcher app's bot identity is an accepted dispatch sender", () => {
  assert.equal(DISPATCHER_BOT_LOGIN, `${DISPATCHER_APP_NAME}[bot]`);
  assert.equal(assertDispatchSender(DISPATCHER_BOT_LOGIN), DISPATCHER_BOT_LOGIN);

  for (const sender of [
    undefined,
    null,
    "",
    "k3-docs-dispatcher",
    "K3-Docs-Dispatcher[bot]",
    "k3-docs-dispatcher[bot] ",
    "k3-lens[bot]",
    "valo",
    "app/k3-lens",
    "github-actions[bot]",
  ]) {
    assert.throws(
      () => assertDispatchSender(sender),
      /not the docs dispatcher app/,
      `expected sender ${JSON.stringify(sender)} to be rejected`,
    );
  }
});

test("an allowed repository name from another actor is rejected", () => {
  // The payload is a claim supplied by the caller: any token that can dispatch to this
  // repository may name either allowlisted source. The pre-fix gate accepted exactly
  // that, so this is the regression the sender check exists to close.
  for (const repository of KNOWN_SOURCE_REPOSITORIES) {
    assert.equal(payloadOnlyGate({ repository }), repository);

    for (const sender of ["k3-lens[bot]", "valo", "attacker[bot]"]) {
      assert.throws(
        () => assertAuthorizedDispatch({ repository, sender }),
        /not the docs dispatcher app/,
        `${sender} must not be able to dispatch a ${repository} rebuild`,
      );
    }
  }
});

test("a dispatch from the dispatcher app still has to name a known source", () => {
  for (const repository of KNOWN_SOURCE_REPOSITORIES) {
    assert.equal(
      assertAuthorizedDispatch({ repository, sender: DISPATCHER_BOT_LOGIN }),
      repository,
    );
  }

  for (const repository of [undefined, "", "K3-Capital/docs", "attacker/docs"]) {
    assert.throws(
      () => assertAuthorizedDispatch({ repository, sender: DISPATCHER_BOT_LOGIN }),
      /unknown documentation source repository/,
    );
  }
});

test("the receiver listens for exactly the event type the senders dispatch", () => {
  // The event name is the contract between the source repositories and this portal:
  // a rename on one side has to fail here rather than silently stop rebuilding the site.
  assert.match(
    workflow,
    new RegExp(`repository_dispatch:\\s*\\n\\s*types: \\[${DISPATCH_EVENT_TYPE}\\]`),
  );
});

test("the receiver checks out exactly the known source repositories", () => {
  for (const repository of KNOWN_SOURCE_REPOSITORIES) {
    assert.match(
      workflow,
      new RegExp(`repository: ${repository.replace(/[.]/g, "\\.")}`),
      `the workflow must check out ${repository}`,
    );
  }

  const checkedOut = [...workflow.matchAll(/^\s*repository: (\S+)$/gm)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(checkedOut)].sort(),
    [...KNOWN_SOURCE_REPOSITORIES].sort(),
    "the workflow must not check out repositories outside the configured doc sets",
  );
});

test("the dispatch sender and payload reach the validator through env:, not the shell", () => {
  const step = extractRunSteps(workflow).find((candidate) => candidate.name === VALIDATE_STEP);
  assert.ok(step, `workflow has no run step named "${VALIDATE_STEP}"`);

  // The authenticated identity is the event sender, never a payload field.
  assert.deepEqual(Object.keys(step.env).sort(), ["DISPATCH_REPOSITORY", "DISPATCH_SENDER"]);
  assert.equal(step.env.DISPATCH_SENDER, "${{ github.event.sender.login }}");
  assert.equal(
    step.env.DISPATCH_REPOSITORY,
    "${{ github.event.client_payload.repository }}",
  );
  assert.match(step.run, /^node scripts\/validate-dispatch-source\.mjs$/);
  assert.match(workflow, /if: github\.event_name == 'repository_dispatch'/);
});

test("the sender is validated before any documentation source is initialised", () => {
  const validateAt = workflow.indexOf(VALIDATE_STEP);
  const portalAt = workflow.indexOf("Checkout portal repository");
  const firstSourceAt = workflow.indexOf("Checkout vault documentation source");

  assert.ok(validateAt > portalAt, "the dispatch gate runs after the portal is checked out");
  assert.ok(
    validateAt < firstSourceAt,
    "a rejected dispatch must fail before the source repositories are checked out",
  );
});
