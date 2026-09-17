/**
 * Helpers for assembling and verifying the docs.k3.capital GitHub Pages artifact.
 *
 * The portal repository does not contain documentation itself. It checks out each
 * documentation source repository, builds it with that project's own toolchain, and
 * copies the build output into a path on this site:
 *
 *   k3-vault-docs (HonKit)  ->  /vault-infra/
 *   sBOLT-docs    (HonKit)  ->  /sBOLT/
 *
 * Everything here is a pure-ish function over the filesystem so the assembly and the
 * checks that gate it can be exercised locally, in unit tests, and in CI through the
 * exact same code path (see scripts/build-site.sh).
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Documentation sets published by this portal, in assembly order.
 *
 * `dirName` is the path segment the set is served under, and `publicBaseUrl` is where
 * that path lives once `docs.k3.capital` is pointed at this Pages site. The sBOLD
 * documentation uses `sBOLT` here: that is the casing the source repository
 * (`K3-Capital/sBOLT-docs`) and the hosting request both use, even though the product
 * and the documentation content are spelled `sBOLD`. It is deliberately a single
 * constant so the segment can be flipped in one place if that reading is wrong.
 */
export const DOC_SETS = [
  {
    key: "vault",
    label: "vault docs",
    dirName: "vault-infra",
    repoDir: "vendor/k3-vault-docs",
    legacyOrigin: "https://k3-capital.github.io/k3-vault-docs",
    publicBaseUrl: "https://docs.k3.capital/vault-infra/",
    /**
     * Pre-existing dangling links in the upstream llms artifact, exempted by name so the
     * gate stays hard for anything new. `architecture/security-assumptions.md` links
     * `../introduction/money-flow.md` and `../introduction/overview.md`; both files exist
     * in the source repository but are absent from its SUMMARY.md, so the vault build
     * never publishes them and its llms generator still rewrites the links to `.html`
     * (the HTML pages keep them as literal `.md`, which is why the site link check does
     * not see the problem). Fixing it is an authoring change in k3-vault-docs. An entry
     * that starts resolving fails the build, so this list cannot rot.
     */
    knownUnresolvedArtifactLinks: [
      "https://docs.k3.capital/vault-infra/introduction/money-flow.html",
      "https://docs.k3.capital/vault-infra/introduction/overview.html",
    ],
  },
  {
    key: "sbolt",
    label: "sBOLD docs",
    dirName: "sBOLT",
    repoDir: "vendor/sBOLT-docs",
    legacyOrigin: "https://k3-capital.github.io/sBOLT-docs",
    publicBaseUrl: "https://docs.k3.capital/sBOLT/",
    knownUnresolvedArtifactLinks: [],
  },
];

export const VAULT_DOC_SET = DOC_SETS[0];
export const SBOLT_DOC_SET = DOC_SETS[1];

export const DEFAULTS = {
  /** Directory name under the site root that holds the vault documentation. */
  vaultDirName: VAULT_DOC_SET.dirName,
  /** Default checkout location of the vault docs source repository. */
  vaultRepoDir: VAULT_DOC_SET.repoDir,
  /** Directory name under the site root that holds the sBOLD documentation. */
  sboltDirName: SBOLT_DOC_SET.dirName,
  /** Default checkout location of the sBOLD docs source repository. */
  sboltRepoDir: SBOLT_DOC_SET.repoDir,
  /** Default site output directory. */
  outDir: "_site",
  /**
   * Absolute origin the vault docs project uses for its generated llms artifacts
   * (hardcoded in k3-vault-docs/scripts/generate-llms.mjs at the time of writing).
   * Rewritten during assembly so the assembled site does not advertise the old origin.
   */
  legacyOrigin: VAULT_DOC_SET.legacyOrigin,
  /**
   * Canonical public location of the vault docs once the site is served at
   * docs.k3.capital. Used for the machine-readable llms artifacts, which are meant to
   * carry absolute published URLs. Change it in one place when the hosting changes.
   */
  publicBaseUrl: VAULT_DOC_SET.publicBaseUrl,
  /** `/` keeps forwarding to the vault docs until a chooser page replaces it. */
  rootRedirectDirName: VAULT_DOC_SET.dirName,
};

const TEXT_ARTIFACT_EXTENSIONS = [
  ".html",
  ".txt",
  ".md",
  ".json",
  ".xml",
  ".yml",
  ".yaml",
  // The source trees are copied into the artifact by HonKit, so the scripts and theme
  // files a doc set ships are published too. They are text and they can carry the source
  // project's origin (the llms generators hardcode it), so they are scrubbed like any
  // other artifact — otherwise the "no source origin remains" gate would be a half-truth.
  ".js",
  ".mjs",
  ".css",
];

/** Generated machine-readable artifacts that carry absolute published URLs. */
const LLMS_ARTIFACTS = ["llms.txt", "llms-full.txt"];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Relative prefix from a page back to the site root ("" for /index.html, "../" one level down, ...). */
export function relativePrefixForPage(pageRelPath) {
  const normalized = pageRelPath.split(path.sep).join("/").replace(/^\/+/, "");
  const depth = normalized.split("/").length - 1;
  return "../".repeat(depth);
}

/** Backwards-compatible alias for relativePrefixForPage. */
export const vaultPrefixForPage = relativePrefixForPage;

/**
 * HTML rewrite for a documentation set. The source projects' SUMMARY.md links the
 * generated llms.txt / llms-full.txt artifacts by absolute old-origin URL, which HonKit
 * renders into the sidebar of every page (and echoes into its inline
 * `gitbook.page.hasChanged` navigation metadata as `url`/`ref`). Rewriting to a
 * page-relative path keeps the assembled artifact self-contained: it navigates correctly
 * whether the site is served at docs.k3.capital/<path>/ or at the
 * k3-capital.github.io/docs/ preview URL.
 */
export function rewriteHtmlOrigin(html, pageRelPath, { legacyOrigin }) {
  const prefix = relativePrefixForPage(pageRelPath);
  const pattern = new RegExp(`(href="|"url":"|"ref":")${escapeRegExp(legacyOrigin)}/([^"]*)`, "g");
  return html.replace(pattern, (_match, attribute, file) => `${attribute}${prefix}${file}`);
}

export function rewriteVaultHtml(html, pageRelPath, { legacyOrigin = DEFAULTS.legacyOrigin } = {}) {
  return rewriteHtmlOrigin(html, pageRelPath, { legacyOrigin });
}

/**
 * HonKit publishes `X/README.md` as `X/index.html`, but the sBOLD llms generator emits
 * `X/README.html`, which never exists in the artifact. Map such a URL onto the directory
 * URL HonKit does serve. Without this the published llms artifacts advertise 404s
 * (`checkArtifactLinks` below is the gate that keeps that honest).
 */
export function normalizeReadmeUrls(text, base) {
  const pattern = new RegExp(`${escapeRegExp(base)}([^\\s)"'\`<>]*/)?README\\.html`, "g");
  return text.replace(pattern, (_match, dir) => `${base}${dir ?? ""}`);
}

/**
 * Text-artifact rewrite (llms.txt, llms-full.txt, and any other text file that carries
 * the old origin). These are consumed as text, so they keep absolute URLs — pointed at
 * the set's canonical public base instead of the legacy GitHub Pages project URL.
 */
export function rewriteTextOrigin(text, { legacyOrigin, publicBaseUrl }) {
  const base = publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`;
  const repointed = text
    .split(`${legacyOrigin}/`).join(base)
    .split(legacyOrigin).join(base.slice(0, -1));
  return normalizeReadmeUrls(repointed, base);
}

export function rewriteVaultText(text, { legacyOrigin = DEFAULTS.legacyOrigin, publicBaseUrl = DEFAULTS.publicBaseUrl } = {}) {
  return rewriteTextOrigin(text, { legacyOrigin, publicBaseUrl });
}

/** Root redirect page. Relative target, so it works on the custom domain and on the project preview URL. */
export function rootRedirectHtml({ dirName = DEFAULTS.rootRedirectDirName, title = "K3 Documentation" } = {}) {
  const target = `${dirName}/`;
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

async function fileSize(target) {
  try {
    const info = await stat(target);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
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
 * Asset copy parity: every file the source build ships under `assets/` must land in the
 * artifact at the same relative path and with the same size. This is the regression guard
 * for the asset class of failure — a pipeline change that copies only rendered HTML (or a
 * filter that drops a directory) silently publishes pages whose images 404.
 */
export async function checkCopiedAssets({ sourceDir, destinationDir, assetsDirName = "assets" }) {
  const sourceAssets = path.join(sourceDir, assetsDirName);
  if (!(await isDirectory(sourceAssets))) return { assets: 0, missing: [] };

  const files = await listFiles(sourceAssets);
  const missing = [];
  for (const rel of files) {
    const [from, to] = await Promise.all([
      fileSize(path.join(sourceAssets, rel)),
      fileSize(path.join(destinationDir, assetsDirName, rel)),
    ]);
    if (from === null || to !== from) missing.push(rel);
  }
  return { assets: files.length, missing };
}

/**
 * Copy a documentation source build to /<dirName>/ inside the site and rewrite the
 * legacy origin references. Returns which files were rewritten plus asset-copy evidence.
 */
export async function assembleDocSet({
  buildDir,
  outDir,
  dirName,
  legacyOrigin,
  publicBaseUrl,
}) {
  if (!(await isDirectory(buildDir))) {
    throw new Error(`Documentation build output not found: ${buildDir} (run the docs build first)`);
  }
  if (!(await isDirectory(outDir))) {
    throw new Error(`Site output directory not found: ${outDir}`);
  }

  const destination = path.join(outDir, dirName);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(buildDir, destination, { recursive: true });

  const rewritten = [];
  for (const rel of await listFiles(destination)) {
    const parts = rel.split("/");
    if (parts.some((part) => part === "node_modules")) continue;
    if (!TEXT_ARTIFACT_EXTENSIONS.includes(path.extname(rel).toLowerCase())) continue;

    const file = path.join(destination, rel);
    const original = await readFile(file, "utf8");
    const updated = rel.endsWith(".html")
      ? rewriteHtmlOrigin(original, rel, { legacyOrigin })
      : rewriteTextOrigin(original, { legacyOrigin, publicBaseUrl });

    if (updated !== original) {
      await writeFile(file, updated);
      rewritten.push(rel);
    }
  }

  const assets = await checkCopiedAssets({ sourceDir: buildDir, destinationDir: destination });
  if (assets.missing.length > 0) {
    const sample = assets.missing.slice(0, 5).join(", ");
    throw new Error(
      `${assets.missing.length}/${assets.assets} asset file(s) from ${path.join(buildDir, "assets")} ` +
        `did not land in ${path.join(destination, "assets")}: ${sample}`,
    );
  }

  return { destination, rewritten, assets: assets.assets };
}

/** Vault-docs wrapper around assembleDocSet (kept for the existing call sites and tests). */
export async function assembleVaultDocs({
  vaultBuildDir,
  outDir,
  vaultDirName = VAULT_DOC_SET.dirName,
  legacyOrigin = VAULT_DOC_SET.legacyOrigin,
  publicBaseUrl = VAULT_DOC_SET.publicBaseUrl,
}) {
  return assembleDocSet({
    buildDir: vaultBuildDir,
    outDir,
    dirName: vaultDirName,
    legacyOrigin,
    publicBaseUrl,
  });
}

/** sBOLD-docs wrapper around assembleDocSet. */
export async function assembleSboltDocs({
  sboltBuildDir,
  outDir,
  sboltDirName = SBOLT_DOC_SET.dirName,
  legacyOrigin = SBOLT_DOC_SET.legacyOrigin,
  publicBaseUrl = SBOLT_DOC_SET.publicBaseUrl,
}) {
  return assembleDocSet({
    buildDir: sboltBuildDir,
    outDir,
    dirName: sboltDirName,
    legacyOrigin,
    publicBaseUrl,
  });
}

/** Write the site root files: the redirect page and the Pages .nojekyll marker. */
export async function writeSiteRoot({ outDir, dirName = DEFAULTS.rootRedirectDirName }) {
  await writeFile(path.join(outDir, "index.html"), rootRedirectHtml({ dirName }));
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

/**
 * Asset-reference check. Covers the `assets/` tree the pages actually consume: every
 * `<img src>` in the doc set must resolve to a non-empty file inside the artifact. A
 * missing image (or a zero-byte one, e.g. a truncated import) fails the build.
 */
export async function checkAssetReferences({ root, dirName }) {
  const broken = [];
  let checked = 0;

  for (const page of (await listFiles(path.join(root, dirName))).filter((rel) => rel.endsWith(".html"))) {
    const pageRelPath = `${dirName}/${page}`;
    const html = await readFile(path.join(root, pageRelPath), "utf8");
    for (const match of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
      const target = match[2] ?? match[3] ?? "";
      const resolved = await resolveLocalTarget({ root, pageRelPath, target });
      if (resolved === null) continue;
      checked += 1;
      const size = await fileSize(resolved);
      if (size === null || size === 0) broken.push({ page: pageRelPath, target });
    }
  }

  return { checked, broken };
}

/**
 * Link check for the generated llms artifacts of a doc set. Those artifacts carry
 * *absolute* URLs under the set's public base (the HTML pages get page-relative rewrites
 * instead), so the HTML link checker cannot see them. Every such URL must resolve to a
 * page that exists inside the assembled doc set.
 *
 * `knownUnresolved` names pre-existing upstream defects that are tracked in the doc-set
 * config instead of being silently tolerated: anything the URL genuinely resolved is
 * reported as `newlyResolved` so the exemption cannot rot once it is fixed upstream.
 */
export async function checkArtifactLinks({ root, dirName, publicBaseUrl, knownUnresolved = [] }) {
  const base = publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`;
  const origin = base.slice(0, -1);
  const docRoot = path.join(root, dirName);
  const missing = [];
  let checked = 0;

  for (const artifact of LLMS_ARTIFACTS) {
    const artifactPath = path.join(docRoot, artifact);
    if (!(await isFile(artifactPath))) {
      throw new Error(`Expected the generated ${artifact} at ${artifactPath}`);
    }

    const text = await readFile(artifactPath, "utf8");
    for (const url of text.match(/https?:\/\/[^\s)"'`<>]+/g) ?? []) {
      const clean = url.split("#")[0].split("?")[0];
      const target = clean === origin ? "" : clean.startsWith(base) ? clean.slice(base.length) : null;
      if (target === null) continue;

      checked += 1;
      const absolute = path.join(docRoot, target);
      const candidates =
        target === "" || clean.endsWith("/")
          ? [path.join(absolute, "index.html")]
          : [absolute, path.join(absolute, "index.html")];
      let found = false;
      for (const candidate of candidates) {
        if (await isFile(candidate)) {
          found = true;
          break;
        }
      }
      if (!found) missing.push({ artifact, url });
    }
  }

  const exempt = new Set(knownUnresolved);
  const missingUrls = new Set(missing.map((hit) => hit.url));

  return {
    checked,
    missing,
    unexpected: missing.filter((hit) => !exempt.has(hit.url)),
    exempted: missing.filter((hit) => exempt.has(hit.url)),
    newlyResolved: knownUnresolved.filter((url) => !missingUrls.has(url)),
  };
}

/**
 * Mermaid rendering gate. The docs are rendered with the HonKit `mermaid-hybrid` plugin
 * (embed: true): the plugin replaces the *content* of each ```mermaid block with an inline
 * <svg>, keeping the surrounding `<pre><code class="lang-mermaid">` element. When the
 * rendering toolchain is missing (no headless browser on the runner), HonKit exits 0 and
 * publishes the raw diagram source instead — the exact silent failure seen in KOP-276. So
 * the gate is: every mermaid block in the artifact must contain an inline SVG.
 */
export async function checkMermaidRendering({ root }) {
  const blockPattern = /<code[^>]*class="lang(?:uage)?-mermaid"[^>]*>([\s\S]*?)<\/code>/g;
  let blocks = 0;
  let rendered = 0;
  const pages = [];

  for (const page of (await listFiles(root)).filter((rel) => rel.endsWith(".html"))) {
    const html = await readFile(path.join(root, page), "utf8");
    const matches = [...html.matchAll(blockPattern)];
    if (matches.length > 0) pages.push(page);
    for (const match of matches) {
      blocks += 1;
      if (/<svg[\s>]/.test(match[1])) rendered += 1;
    }
  }

  return { blocks, rendered, pages };
}

/** Gather every occurrence of any of the given legacy origins left in the assembled site. */
export async function findLegacyOriginReferences({ root, legacyOrigin, legacyOrigins }) {
  const origins = legacyOrigins ?? [legacyOrigin];
  const hits = [];
  for (const rel of await listFiles(root)) {
    if (!TEXT_ARTIFACT_EXTENSIONS.includes(path.extname(rel).toLowerCase())) continue;
    const text = await readFile(path.join(root, rel), "utf8");
    for (const origin of origins) {
      const count = text.split(origin).length - 1;
      if (count > 0) hits.push({ file: rel, origin, count });
    }
  }
  return hits;
}

/**
 * Gate for the assembled artifact. Throws on the first failed check; returns the
 * evidence summary printed by scripts/assemble-site.mjs.
 *
 * Routing: every configured doc set is served at /<dirName>/, and / still forwards to
 * the vault docs. Links: no broken local link, no broken generated-artifact link, no
 * asset reference that resolves to nothing. Assets: each doc set's asset references
 * resolve to non-empty files. Origins: no source-project Pages origin survives.
 */
export async function verifySite({ outDir, docSets = DOC_SETS }) {
  const rootIndexPath = path.join(outDir, "index.html");
  if (!(await isFile(rootIndexPath))) {
    throw new Error("Site root index.html (redirect) is missing");
  }
  const rootIndex = await readFile(rootIndexPath, "utf8");
  const redirectDirName = DEFAULTS.rootRedirectDirName;
  if (!rootIndex.includes(`url=${redirectDirName}/`)) {
    throw new Error(`Root index.html does not redirect to ${redirectDirName}/`);
  }
  if (!rootIndex.includes(`href="${redirectDirName}/"`)) {
    throw new Error(`Root index.html has no clickable link to ${redirectDirName}/`);
  }

  for (const set of docSets) {
    const index = path.join(outDir, set.dirName, "index.html");
    if (!(await isFile(index))) {
      throw new Error(`/${set.dirName}/ does not serve the ${set.label}: ${index} is missing`);
    }
  }

  const legacy = await findLegacyOriginReferences({
    root: outDir,
    legacyOrigins: docSets.map((set) => set.legacyOrigin),
  });
  if (legacy.length > 0) {
    const sample = legacy.slice(0, 5).map((hit) => `${hit.file} (${hit.origin} x${hit.count})`).join(", ");
    throw new Error(`Source-project origin still referenced in the artifact: ${sample}`);
  }

  const perSet = {};
  for (const set of docSets) {
    const assets = await checkAssetReferences({ root: outDir, dirName: set.dirName });
    if (assets.broken.length > 0) {
      const sample = assets.broken.slice(0, 5).map((hit) => `${hit.page} -> ${hit.target}`).join("\n  ");
      throw new Error(
        `${assets.broken.length} asset reference(s) in /${set.dirName}/ do not resolve to a file:\n  ${sample}`,
      );
    }

    const artifacts = await checkArtifactLinks({
      root: outDir,
      dirName: set.dirName,
      publicBaseUrl: set.publicBaseUrl,
      knownUnresolved: set.knownUnresolvedArtifactLinks ?? [],
    });
    if (artifacts.unexpected.length > 0) {
      const sample = artifacts.unexpected
        .slice(0, 5)
        .map((hit) => `${hit.artifact} -> ${hit.url}`)
        .join("\n  ");
      throw new Error(
        `${artifacts.unexpected.length} generated-artifact link(s) under ${set.publicBaseUrl} do not resolve:\n  ${sample}`,
      );
    }
    if (artifacts.newlyResolved.length > 0) {
      throw new Error(
        `${artifacts.newlyResolved.length} exempted generated-artifact link(s) now resolve — remove them from ` +
          `knownUnresolvedArtifactLinks:\n  ${artifacts.newlyResolved.join("\n  ")}`,
      );
    }

    perSet[set.key] = {
      dirName: set.dirName,
      pages: (await listFiles(path.join(outDir, set.dirName))).filter((rel) => rel.endsWith(".html")).length,
      assetReferences: assets.checked,
      artifactLinks: artifacts.checked,
      exemptedArtifactLinks: artifacts.exempted.map((hit) => hit.url),
    };
  }

  const { checked, missing } = await findBrokenLinks({ root: outDir });
  if (missing.length > 0) {
    const sample = missing.slice(0, 10).map((hit) => `${hit.page} -> ${hit.target}`).join("\n  ");
    throw new Error(`${missing.length} broken local link(s) in the assembled site:\n  ${sample}`);
  }

  const mermaid = await checkMermaidRendering({ root: outDir });
  if (mermaid.rendered < mermaid.blocks) {
    const unrendered = mermaid.blocks - mermaid.rendered;
    throw new Error(
      `${unrendered}/${mermaid.blocks} Mermaid block(s) were published as raw source instead of rendered SVG ` +
        `(pages: ${mermaid.pages.join(", ")}) — the docs build is missing its headless browser`,
    );
  }

  return {
    pages: (await listFiles(outDir)).filter((rel) => rel.endsWith(".html")).length,
    linksChecked: checked,
    mermaidBlocks: mermaid.blocks,
    mermaidRendered: mermaid.rendered,
    vaultDirName: VAULT_DOC_SET.dirName,
    docSets: docSets.map((set) => set.key),
    perSet,
  };
}
