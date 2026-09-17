/**
 * Helpers for assembling and verifying the docs.k3.capital GitHub Pages artifact.
 *
 * The portal repository does not contain documentation itself. It checks out each
 * documentation source repository, builds it with that project's own toolchain, and
 * copies the build output into a path on this site:
 *
 *   k3-vault-docs (HonKit)  ->  /vault-infra/
 *
 * Everything here is a pure-ish function over the filesystem so the assembly and the
 * checks that gate it can be exercised locally, in unit tests, and in CI through the
 * exact same code path (see scripts/build-site.sh).
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULTS = {
  /** Directory name under the site root that holds the vault documentation. */
  vaultDirName: "vault-infra",
  /** Default checkout location of the vault docs source repository. */
  vaultRepoDir: "vendor/k3-vault-docs",
  /** Default site output directory. */
  outDir: "_site",
  /**
   * Absolute origin used by the vault docs project for its generated llms artifacts
   * (hardcoded in k3-vault-docs/scripts/generate-llms.mjs at the time of writing).
   * Rewritten during assembly so the assembled site does not advertise the old origin.
   */
  legacyOrigin: "https://k3-capital.github.io/k3-vault-docs",
  /**
   * Canonical public location of the vault docs once the site is served at
   * docs.k3.capital. Used for the machine-readable llms artifacts, which are meant to
   * carry absolute published URLs. Change it in one place when the hosting changes.
   */
  publicBaseUrl: "https://docs.k3.capital/vault-infra/",
};

const TEXT_ARTIFACT_EXTENSIONS = [".html", ".txt", ".md", ".json", ".xml", ".yml", ".yaml"];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Relative prefix from a page back to the site root ("" for /index.html, "../" one level down, ...). */
export function vaultPrefixForPage(pageRelPath) {
  const normalized = pageRelPath.split(path.sep).join("/").replace(/^\/+/, "");
  const depth = normalized.split("/").length - 1;
  return "../".repeat(depth);
}

/**
 * HTML rewrite for the vault pages. The vault's SUMMARY.md links the generated
 * llms.txt / llms-full.txt artifacts by absolute old-origin URL, which HonKit renders
 * into the sidebar of every page (and echoes into its inline `gitbook.page.hasChanged`
 * navigation metadata as `url`/`ref`). Rewriting to a page-relative path keeps the
 * assembled artifact self-contained: it navigates correctly whether the site is served
 * at docs.k3.capital/vault-infra/ or at the k3-capital.github.io/docs/ preview URL.
 */
export function rewriteVaultHtml(html, pageRelPath, { legacyOrigin = DEFAULTS.legacyOrigin } = {}) {
  const prefix = vaultPrefixForPage(pageRelPath);
  const pattern = new RegExp(`(href="|"url":"|"ref":")${escapeRegExp(legacyOrigin)}/([^"]*)`, "g");
  return html.replace(pattern, (_match, attribute, file) => `${attribute}${prefix}${file}`);
}

/**
 * Text-artifact rewrite (llms.txt, llms-full.txt, and any other text file that carries
 * the old origin). These are consumed as text, so they keep absolute URLs — pointed at
 * the canonical public base URL instead of the legacy GitHub Pages project URL.
 */
export function rewriteVaultText(text, { legacyOrigin = DEFAULTS.legacyOrigin, publicBaseUrl = DEFAULTS.publicBaseUrl } = {}) {
  const absoluteBase = publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`;
  return text
    .split(`${legacyOrigin}/`).join(absoluteBase)
    .split(legacyOrigin).join(absoluteBase.slice(0, -1));
}

/** Root redirect page. Relative target, so it works on the custom domain and on the project preview URL. */
export function rootRedirectHtml({ vaultDirName = DEFAULTS.vaultDirName, title = "K3 Documentation" } = {}) {
  const target = `${vaultDirName}/`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <meta http-equiv="refresh" content="0; url=${target}" />
    <script>window.location.replace(${JSON.stringify(target)});</script>
  </head>
  <body>
    <p>Redirecting to the <a href="${target}">K3 vault documentation</a>&hellip;</p>
  </body>
</html>
`;
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target) {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/** Recursively list files, returning paths relative to `root` (posix separators). */
export async function listFiles(root, directory = root) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listFiles(root, absolute)));
    } else if (entry.isFile()) {
      found.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  return found;
}

/**
 * Copy the vault build output to /<vaultDirName>/ inside the site and rewrite the
 * legacy origin references. Returns which files were rewritten.
 */
export async function assembleVaultDocs({
  vaultBuildDir,
  outDir,
  vaultDirName = DEFAULTS.vaultDirName,
  legacyOrigin = DEFAULTS.legacyOrigin,
  publicBaseUrl = DEFAULTS.publicBaseUrl,
}) {
  if (!(await isDirectory(vaultBuildDir))) {
    throw new Error(`Vault build output not found: ${vaultBuildDir} (run the vault docs build first)`);
  }
  if (!(await isDirectory(outDir))) {
    throw new Error(`Site output directory not found: ${outDir}`);
  }

  const destination = path.join(outDir, vaultDirName);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(vaultBuildDir, destination, { recursive: true });

  const rewritten = [];
  for (const rel of await listFiles(destination)) {
    const parts = rel.split("/");
    if (parts.some((part) => part === "node_modules")) continue;
    if (!TEXT_ARTIFACT_EXTENSIONS.includes(path.extname(rel).toLowerCase())) continue;

    const file = path.join(destination, rel);
    const original = await readFile(file, "utf8");
    const updated = rel.endsWith(".html")
      ? rewriteVaultHtml(original, rel, { legacyOrigin })
      : rewriteVaultText(original, { legacyOrigin, publicBaseUrl });

    if (updated !== original) {
      await writeFile(file, updated);
      rewritten.push(rel);
    }
  }

  return { destination, rewritten };
}

/** Write the site root files: the redirect page and the Pages .nojekyll marker. */
export async function writeSiteRoot({ outDir, vaultDirName = DEFAULTS.vaultDirName }) {
  await writeFile(path.join(outDir, "index.html"), rootRedirectHtml({ vaultDirName }));
  await writeFile(path.join(outDir, ".nojekyll"), "");
}

/** Extract href/src targets from HTML, ignoring duplicates. */
export function extractLinkTargets(html) {
  const targets = new Set();
  const pattern = /(?:href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    targets.add(match[2] ?? match[3] ?? "");
  }
  return [...targets];
}

function isExternalTarget(target) {
  return (
    target === "" ||
    target.startsWith("#") ||
    target.startsWith("//") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)
  );
}

/**
 * Resolve an in-page link target to a candidate file on disk.
 * Returns null when the target is external / not a local asset we can check.
 */
export async function resolveLocalTarget({ root, pageRelPath, target }) {
  if (isExternalTarget(target)) return null;

  const clean = target.split("#")[0].split("?")[0];
  if (clean === "") return null;

  const absolute = clean.startsWith("/")
    ? path.join(root, clean)
    : path.resolve(path.dirname(path.join(root, pageRelPath)), clean);

  const candidates = clean.endsWith("/")
    ? [path.join(absolute, "index.html")]
    : [absolute, `${absolute}.html`, path.join(absolute, "index.html")];

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return absolute;
}

/**
 * Link check over the assembled site. Absolute paths are resolved against the site root,
 * so /vault-infra/... links are checked exactly as a browser would request them.
 */
export async function findBrokenLinks({ root }) {
  const missing = [];
  let checked = 0;

  for (const page of (await listFiles(root)).filter((rel) => rel.endsWith(".html"))) {
    const html = await readFile(path.join(root, page), "utf8");
    for (const target of extractLinkTargets(html)) {
      const resolved = await resolveLocalTarget({ root, pageRelPath: page, target });
      if (resolved === null) continue;
      checked += 1;
      if (!(await isFile(resolved))) missing.push({ page, target });
    }
  }

  return { checked, missing };
}

/** Gather every occurrence of the legacy origin left in the assembled site. */
export async function findLegacyOriginReferences({ root, legacyOrigin = DEFAULTS.legacyOrigin }) {
  const hits = [];
  for (const rel of await listFiles(root)) {
    if (!TEXT_ARTIFACT_EXTENSIONS.includes(path.extname(rel).toLowerCase())) continue;
    const text = await readFile(path.join(root, rel), "utf8");
    const count = text.split(legacyOrigin).length - 1;
    if (count > 0) hits.push({ file: rel, count });
  }
  return hits;
}

/**
 * Gate for the assembled artifact. Throws on the first failed check; returns the
 * evidence summary printed by scripts/assemble-site.mjs.
 */
export async function verifySite({
  outDir,
  vaultDirName = DEFAULTS.vaultDirName,
  legacyOrigin = DEFAULTS.legacyOrigin,
}) {
  const vaultIndex = path.join(outDir, vaultDirName, "index.html");
  if (!(await isFile(vaultIndex))) {
    throw new Error(`Expected the vault docs index at ${vaultIndex}`);
  }

  const rootIndexPath = path.join(outDir, "index.html");
  if (!(await isFile(rootIndexPath))) {
    throw new Error("Site root index.html (redirect) is missing");
  }
  const rootIndex = await readFile(rootIndexPath, "utf8");
  if (!rootIndex.includes(`url=${vaultDirName}/`)) {
    throw new Error(`Root index.html does not redirect to ${vaultDirName}/`);
  }
  if (!rootIndex.includes(`href="${vaultDirName}/"`)) {
    throw new Error(`Root index.html has no clickable link to ${vaultDirName}/`);
  }

  const legacy = await findLegacyOriginReferences({ root: outDir, legacyOrigin });
  if (legacy.length > 0) {
    const sample = legacy.slice(0, 5).map((hit) => `${hit.file} (${hit.count})`).join(", ");
    throw new Error(`Legacy origin ${legacyOrigin} still referenced in: ${sample}`);
  }

  const { checked, missing } = await findBrokenLinks({ root: outDir });
  if (missing.length > 0) {
    const sample = missing.slice(0, 10).map((hit) => `${hit.page} -> ${hit.target}`).join("\n  ");
    throw new Error(`${missing.length} broken local link(s) in the assembled site:\n  ${sample}`);
  }

  return {
    pages: (await listFiles(outDir)).filter((rel) => rel.endsWith(".html")).length,
    linksChecked: checked,
    vaultDirName,
  };
}
