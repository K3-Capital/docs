import assert from "node:assert/strict";
import test from "node:test";

import {
  DISPATCH_EVENT_TYPE,
  KNOWN_SOURCE_REPOSITORIES,
  assertKnownSourceRepository,
  sourceRepositoryOf,
} from "../scripts/lib/dispatch.mjs";
import { DOC_SETS } from "../scripts/lib/site.mjs";
import { readWorkflow } from "../scripts/lib/workflow.mjs";

const workflow = await readWorkflow();

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

test("the dispatch payload reaches the validator through env:, not through the shell", () => {
  assert.match(
    workflow,
    /if: github\.event_name == 'repository_dispatch'[\s\S]*?env:\s*\n\s*DISPATCH_REPOSITORY: \$\{\{ github\.event\.client_payload\.repository \}\}[\s\S]*?run: node scripts\/validate-dispatch-source\.mjs/,
  );
});
