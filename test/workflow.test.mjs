import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULTS, SBOLT_DOC_SET, VAULT_DOC_SET } from "../scripts/lib/site.mjs";
import {
  extractJobConcurrency,
  extractRunSteps,
  readWorkflow,
  resolveConcurrencyFlag,
  resolveConcurrencyGroup,
  resolveGroup,
} from "../scripts/lib/workflow.mjs";

const workflow = await readWorkflow();
const runSteps = extractRunSteps(workflow);
const jobConcurrency = extractJobConcurrency(workflow);

const EVENTS = {
  pullRequest: { event_name: "pull_request", event: { pull_request: { number: 42 } } },
  otherPullRequest: { event_name: "pull_request", event: { pull_request: { number: 43 } } },
  push: { event_name: "push", ref: "refs/heads/main" },
  manual: { event_name: "workflow_dispatch" },
  dispatch: { event_name: "repository_dispatch" },
};

function groupFor(job, event) {
  return resolveGroup(jobConcurrency[job].group, event);
}

function cancellable(job, event) {
  return resolveConcurrencyFlag(jobConcurrency[job].cancelInProgress, event);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  assert.equal(runSteps.length, 5, "the build job's five run steps");
  for (const name of [
    "Validate the dispatch source",
    "Record documentation source revisions",
    "Run portal unit tests",
    "Build documentation sources and assemble the site",
  ]) {
    stepNamed(name);
  }
});

test("the workflow checks out and builds every configured documentation source", () => {
  // The workflow's checkout targets and the assembler's doc-set config must not drift:
  // renaming a source repo or a destination path in one place has to fail here.
  for (const set of [VAULT_DOC_SET, SBOLT_DOC_SET]) {
    assert.match(
      workflow,
      new RegExp(`repository: ${escapeRegExp(`K3-Capital/${set.repoDir.split("/").pop()}`)}`),
      `the workflow must check out ${set.repoDir}`,
    );
    assert.match(
      workflow,
      new RegExp(`path: ${escapeRegExp(set.repoDir)}`),
      `the workflow must check ${set.repoDir.split("/").pop()} out at ${set.repoDir}`,
    );
    assert.match(
      workflow,
      new RegExp(`cache-dependency-path:[\\s\\S]*?${escapeRegExp(set.repoDir)}/package-lock\\.json`),
      `the npm cache must key on ${set.repoDir}/package-lock.json`,
    );
    assert.match(
      workflow,
      new RegExp(`_site/${escapeRegExp(set.dirName)}`),
      `the artifact summary must count the /${set.dirName}/ pages`,
    );
  }

  const record = stepNamed("Record documentation source revisions");
  assert.match(record.run, /echo "vault docs source: \$\(git -C vendor\/k3-vault-docs rev-parse HEAD\)"/);
  assert.match(record.run, /echo "sBOLD docs source: \$\(git -C vendor\/sBOLT-docs rev-parse HEAD\)"/);
  assert.equal(DEFAULTS.sboltDirName, SBOLT_DOC_SET.dirName);
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

test("the build job collapses concurrent builds and gives PR validation its own group", () => {
  assert.equal(groupFor("build", EVENTS.pullRequest), "docs-pr-42");
  assert.equal(groupFor("build", EVENTS.otherPullRequest), "docs-pr-43");
  assert.equal(groupFor("build", EVENTS.push), "docs-pages-build");
  assert.equal(groupFor("build", EVENTS.manual), "docs-pages-build");
  assert.equal(groupFor("build", EVENTS.dispatch), "docs-pages-build");

  assert.notEqual(
    groupFor("build", EVENTS.pullRequest),
    groupFor("build", EVENTS.dispatch),
    "a PR run must not share the production build group",
  );

  for (const job of ["build", "deploy"]) {
    for (const [name, event] of Object.entries(EVENTS)) {
      assert.notEqual(
        groupFor(job, event),
        "",
        `job ${job} must have a concurrency group for the ${name} event`,
      );
    }
  }
});

test("every build is cancellable, so only the newest concurrent build survives", () => {
  for (const [name, event] of Object.entries(EVENTS)) {
    assert.equal(
      cancellable("build", event),
      true,
      `the build job must be cancellable for the ${name} event: a superseded build has nothing to publish`,
    );
  }
});

test("no deployment can be cancelled, and builds never share the deploy group", () => {
  for (const [name, event] of Object.entries(EVENTS)) {
    assert.equal(
      cancellable("deploy", event),
      false,
      `the deploy job must not be cancellable for the ${name} event`,
    );
    assert.notEqual(
      groupFor("deploy", event),
      groupFor("build", event),
      `job deploy must not share a concurrency group with job build for the ${name} event`,
    );
  }

  assert.equal(groupFor("deploy", EVENTS.dispatch), "docs-pages-deploy");
  assert.equal(groupFor("deploy", EVENTS.push), "docs-pages-deploy");
  assert.equal(groupFor("deploy", EVENTS.manual), "docs-pages-deploy");
});

test("concurrency lives on the jobs, not on the workflow", () => {
  // A workflow-level group would cancel whole runs — including a run that is already
  // deploying — so the guarantees above are expressed per job instead.
  assert.doesNotMatch(workflow, /^concurrency:/m, "no top-level concurrency: block");
  assert.deepEqual(Object.keys(jobConcurrency).sort(), ["build", "deploy"]);
});

/**
 * The pre-fix workflow, kept as a fixture: one workflow-level group that serialised
 * production runs without collapsing concurrent builds and without protecting the
 * deploy from cancellation semantics of its own.
 */
const PRE_FIX_WORKFLOW = `name: Build and deploy docs.k3.capital
on:
  push:
    branches:
      - main
concurrency:
  group: docs-pages-deploy
  cancel-in-progress: false
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Run portal unit tests
        run: npm test
`;

function buildIsCollapsible(text) {
  const job = extractJobConcurrency(text).build;
  if (job?.cancelInProgress === undefined) {
    return false;
  }
  return resolveConcurrencyFlag(job.cancelInProgress, EVENTS.dispatch);
}

function deployIsProtected(text) {
  const job = extractJobConcurrency(text).deploy;
  if (job?.cancelInProgress === undefined) {
    return false;
  }
  return !resolveConcurrencyFlag(job.cancelInProgress, EVENTS.dispatch);
}

test("the concurrency gates flag the pre-fix workflow", () => {
  assert.equal(buildIsCollapsible(PRE_FIX_WORKFLOW), false, "pre-fix builds cannot collapse");
  assert.equal(deployIsProtected(PRE_FIX_WORKFLOW), false, "pre-fix deployments are unprotected");

  assert.equal(buildIsCollapsible(workflow), true);
  assert.equal(deployIsProtected(workflow), true);
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
