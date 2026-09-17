import assert from "node:assert/strict";
import test from "node:test";

import {
  extractConcurrency,
  extractRunSteps,
  readWorkflow,
  resolveConcurrencyGroup,
} from "../scripts/lib/workflow.mjs";

const workflow = await readWorkflow();
const runSteps = extractRunSteps(workflow);

/** The pre-fix step, kept as a fixture so the detector is exercised on the real bug. */
const VULNERABLE_STEP = `name: Record documentation source revisions
run: |
  echo "vault docs source: $(git -C vendor/k3-vault-docs rev-parse HEAD)"
  if [ "\${{ github.event_name }}" = "repository_dispatch" ]; then
    echo "dispatch payload repository: \${{ github.event.client_payload.repository }}"
    echo "dispatch payload sha:        \${{ github.event.client_payload.sha }}"
  fi
`;

function interpolatedRunSteps(steps) {
  return steps.filter((step) => step.run.includes("${{"));
}

function stepNamed(name) {
  const step = runSteps.find((candidate) => candidate.name === name);
  assert.ok(step, `workflow has no run step named "${name}"`);
  return step;
}

test("the workflow reader sees the real run steps", () => {
  assert.equal(runSteps.length, 4, "the build job's four run steps");
  for (const name of [
    "Record documentation source revisions",
    "Run portal unit tests",
    "Build documentation sources and assemble the site",
  ]) {
    stepNamed(name);
  }
});

test("no run: script interpolates a ${{ }} expression into the shell", () => {
  const offenders = interpolatedRunSteps(runSteps).map((step) => step.name);
  assert.deepEqual(
    offenders,
    [],
    `these steps interpolate event data directly into the shell: ${offenders.join(", ")}`,
  );
});

test("the detector flags the pre-fix repository_dispatch step", () => {
  const [offender] = interpolatedRunSteps([{ name: "pre-fix", run: VULNERABLE_STEP }]);
  assert.ok(offender, "the shell-interpolation detector must catch the pre-fix step");
  assert.match(offender.run, /github\.event\.client_payload\.repository/);
});

test("dispatch payload values reach the script through env:, not through the shell", () => {
  const step = stepNamed("Record documentation source revisions");

  assert.deepEqual(Object.keys(step.env).sort(), [
    "DISPATCH_REPOSITORY",
    "DISPATCH_SHA",
    "EVENT_NAME",
  ]);
  for (const value of Object.values(step.env)) {
    assert.match(value, /^\$\{\{\s*github\./, `env values must be GitHub expressions: ${value}`);
  }

  assert.doesNotMatch(step.run, /client_payload/, "payload data must not be inlined in the script");
  assert.match(step.run, /\[ "\$EVENT_NAME" = "repository_dispatch" \]/);
  assert.match(step.run, /echo "dispatch payload repository: \$DISPATCH_REPOSITORY"/);
  assert.match(step.run, /echo "dispatch payload sha:        \$DISPATCH_SHA"/);
});

test("pull-request validation and production use different concurrency groups", () => {
  const { group } = extractConcurrency(workflow);

  const pullRequest = resolveConcurrencyGroup(group, {
    event_name: "pull_request",
    event: { pull_request: { number: 42 } },
  });
  const push = resolveConcurrencyGroup(group, { event_name: "push", ref: "refs/heads/main" });
  const dispatch = resolveConcurrencyGroup(group, { event_name: "repository_dispatch" });
  const manual = resolveConcurrencyGroup(group, { event_name: "workflow_dispatch" });

  assert.equal(pullRequest, "docs-pr-42");
  assert.equal(push, "docs-pages-deploy");
  assert.equal(dispatch, "docs-pages-deploy");
  assert.equal(manual, "docs-pages-deploy");

  assert.notEqual(pullRequest, push, "a PR run must not share the production group");

  const otherPr = resolveConcurrencyGroup(group, {
    event_name: "pull_request",
    event: { pull_request: { number: 43 } },
  });
  assert.notEqual(otherPr, pullRequest, "each PR validates in its own group");
});

test("only pull-request runs are cancellable, so a PR cannot cancel a deployment", () => {
  const { cancelInProgress } = extractConcurrency(workflow);

  const asBoolean = (event) => resolveConcurrencyGroup(cancelInProgress, event) === "true";

  assert.equal(
    asBoolean({ event_name: "pull_request", event: { pull_request: { number: 42 } } }),
    true,
  );
  assert.equal(asBoolean({ event_name: "push" }), false);
  assert.equal(asBoolean({ event_name: "repository_dispatch" }), false);
  assert.equal(asBoolean({ event_name: "workflow_dispatch" }), false);
});

test("the concurrency resolver refuses an expression shape it cannot interpret", () => {
  assert.throws(
    () => resolveConcurrencyGroup("docs-pages-deploy", { event_name: "push" }),
    /not a GitHub expression/,
  );
  assert.throws(
    () =>
      resolveConcurrencyGroup("${{ github.event_name != 'push' && 'a' || 'b' }}", {
        event_name: "push",
      }),
    /unsupported expression/,
  );
});
