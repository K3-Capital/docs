/**
 * Reader for `.github/workflows/deploy.yml`.
 *
 * The workflow is the only place where the deploy pipeline's shell-safety and
 * concurrency guarantees live, so the portal tests assert on the real file rather
 * than on a copy of it. The helpers below understand just enough YAML — block
 * scalars and nested `env:` mappings — to expose the two properties that matter:
 *
 *   1. no `run:` script may contain a `${{ ... }}` expression, because GitHub
 *      substitutes expressions before the shell parses the script, which turns
 *      untrusted event data (a `repository_dispatch` payload) into shell code;
 *   2. the build job and the deploy job must not share a concurrency group: builds
 *      are cancellable (a superseded build has nothing to publish), deployments are
 *      not (a Pages publish must never be interrupted), and pull-request validation
 *      must not be able to cancel either one.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  workflowPath: path.resolve(HERE, "../../.github/workflows/deploy.yml"),
};

function indentOf(line) {
  return line.match(/^[ \t]*/)[0].length;
}

function isBlank(line) {
  return line.trim() === "";
}

/** Reads an indented block (a `|`/`>` scalar or a nested mapping) below a key. */
function readIndentedBlock(lines, startIndex, parentIndent) {
  const block = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
      block.push("");
      index += 1;
      continue;
    }
    if (indentOf(line) <= parentIndent) {
      break;
    }
    block.push(line);
    index += 1;
  }

  return { block, next: index };
}

/**
 * Every `run:` script in the workflow, with the `env:` keys of the same step.
 * Returns `[{ name, run, env }]`; steps without a `run:` are omitted.
 */
export function extractRunSteps(text) {
  const lines = text.split("\n");
  const steps = [];
  let current = null;
  let envIndent = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const stepStart = line.match(/^(\s*)-\s+(?:name|uses):\s*(.*)$/);

    if (stepStart) {
      current = { name: stepStart[2].replace(/^["']|["']$/g, ""), run: null, env: {} };
      envIndent = null;
      steps.push(current);
      continue;
    }

    if (current === null || isBlank(line)) {
      continue;
    }

    const indent = indentOf(line);

    if (indent <= indentOf(`  - x`)) {
      current = null;
      envIndent = null;
      continue;
    }

    if (envIndent !== null && indent <= envIndent) {
      envIndent = null;
    }

    if (/^\s*env:\s*$/.test(line)) {
      envIndent = indent;
      continue;
    }

    if (envIndent !== null) {
      const entry = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/);
      if (entry) {
        current.env[entry[1]] = entry[2];
      }
      continue;
    }

    if (/^\s*run:\s*[|>][-+]?\s*$/.test(line)) {
      const { block, next } = readIndentedBlock(lines, index + 1, indent);
      current.run = block.join("\n");
      index = next - 1;
      continue;
    }

    const inlineRun = line.match(/^\s*run:\s*(\S.*?)\s*$/);
    if (inlineRun) {
      current.run = inlineRun[1].replace(/^["']|["']$/g, "");
    }
  }

  return steps.filter((step) => step.run !== null);
}

/**
 * The per-job `concurrency:` blocks as `{ <job>: { group, cancelInProgress } }`.
 *
 * Job-level concurrency is what lets the workflow collapse concurrent builds while
 * keeping deployments non-cancellable: the build job may be cancelled by a newer
 * build, the deploy job may not be cancelled by anything.
 */
export function extractJobConcurrency(text) {
  const lines = text.split("\n");
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsIndex === -1) {
    throw new Error("no top-level jobs: block in the workflow");
  }

  const { next } = readIndentedBlock(lines, jobsIndex + 1, 0);
  const concurrency = {};
  let job = null;

  for (let index = jobsIndex + 1; index < next; index += 1) {
    const line = lines[index];
    if (isBlank(line)) {
      continue;
    }

    const indent = indentOf(line);

    if (indent === 2) {
      const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
      if (header) {
        job = header[1];
        concurrency[job] = {};
        continue;
      }
    }

    if (job === null || indent !== 4 || !/^ {4}concurrency:\s*$/.test(line)) {
      continue;
    }

    const { block } = readIndentedBlock(lines, index + 1, indent);
    for (const entry of block) {
      const group = entry.match(/^\s*group:\s*(.*?)\s*$/);
      if (group) {
        concurrency[job].group = group[1];
      }
      const cancel = entry.match(/^\s*cancel-in-progress:\s*(.*?)\s*$/);
      if (cancel) {
        concurrency[job].cancelInProgress = cancel[1];
      }
    }

    if (!concurrency[job].group || !concurrency[job].cancelInProgress) {
      throw new Error(`job ${job}: concurrency: block must set both group and cancel-in-progress`);
    }
  }

  return concurrency;
}

/**
 * Evaluates the restricted expression shape this workflow uses in
 * `concurrency.group`: `<test> && <value> || <fallback>`, where `<test>` is an
 * `==` comparison against an event property, `<value>` is `format(...)`, and the
 * operands are string literals or event properties. `event` is the `github`
 * context (`{ event_name, event: { ... }, ref, ... }`).
 *
 * It is deliberately strict: any expression it cannot interpret throws, so a
 * rewrite of the concurrency group fails the test instead of silently passing.
 */
export function resolveConcurrencyGroup(expression, event) {
  const inner = expression.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  if (!inner) {
    throw new Error(`not a GitHub expression: ${expression}`);
  }

  return evaluate(inner[1], event);
}

function evaluate(expression, event) {
  const trimmed = expression.trim();

  const orIndex = splitTopLevel(trimmed, "||");
  if (orIndex !== -1) {
    const left = evaluate(trimmed.slice(0, orIndex), event);
    return truthy(left) ? left : evaluate(trimmed.slice(orIndex + 2), event);
  }

  const andIndex = splitTopLevel(trimmed, "&&");
  if (andIndex !== -1) {
    const left = evaluate(trimmed.slice(0, andIndex), event);
    return truthy(left) ? evaluate(trimmed.slice(andIndex + 2), event) : left;
  }

  const comparison = trimmed.match(/^([\w.]+)\s*==\s*(['"])(.*?)\2$/);
  if (comparison) {
    const [, property, , literal] = comparison;
    return readProperty(event, property) === literal ? "true" : "";
  }

  const format = trimmed.match(/^format\(\s*(['"])(.*?)\1\s*,\s*([\s\S]*?)\)$/);
  if (format) {
    return format[2].replace(/\{(\d+)\}/g, (_, index) => String(evaluate(format[3], event)));
  }

  const literal = trimmed.match(/^(['"])(.*?)\1$/);
  if (literal) {
    return literal[2];
  }

  if (/^[\w.]+$/.test(trimmed)) {
    return readProperty(event, trimmed);
  }

  throw new Error(`unsupported expression: ${trimmed}`);
}

/** Index of the first top-level `operator`, or -1. */
function splitTopLevel(expression, operator) {
  let depth = 0;
  let quote = null;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;
      continue;
    }

    if (depth === 0 && expression.startsWith(operator, index)) {
      return index;
    }
  }

  return -1;
}

function readProperty(event, property) {
  // `event` is the `github` context itself, so `github.event_name` is one level
  // below the object the tests hand in.
  const path = property.replace(/^github\.?/, "").split(".").filter(Boolean);
  const value = path.reduce((node, key) => (node == null ? node : node[key]), event);
  return value == null ? "" : String(value);
}

function truthy(value) {
  return value !== "" && value !== "false" && value !== "0" && value != null;
}

/**
 * The effective concurrency group for an event. `group:` is either a literal string
 * (the deploy job's fixed group) or the restricted expression shape above.
 */
export function resolveGroup(expression, event) {
  const trimmed = expression.trim();
  return trimmed.includes("${{") ? resolveConcurrencyGroup(trimmed, event) : trimmed;
}

/**
 * The effective `cancel-in-progress:` flag for an event: a literal boolean, or an
 * expression that must resolve to `true`/`false`.
 */
export function resolveConcurrencyFlag(expression, event) {
  const trimmed = expression.trim();
  if (trimmed === "true" || trimmed === "false") {
    return trimmed === "true";
  }
  return resolveConcurrencyGroup(trimmed, event) === "true";
}

/** Loads the workflow file. */
export async function readWorkflow(workflowPath = DEFAULTS.workflowPath) {
  return readFile(workflowPath, "utf8");
}
