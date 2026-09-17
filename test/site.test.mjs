import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DOC_SETS,
  DEFAULTS,
  SBOLT_DOC_SET,
  VAULT_DOC_SET,
  assembleDocSet,
  assembleSboltDocs,
  assembleVaultDocs,
  checkArtifactLinks,
  checkCopiedAssets,
  extractLinkTargets,
  findBrokenLinks,
  normalizeReadmeUrls,
  relativePrefixForPage,
  resolveLocalTarget,
  rewriteHtmlOrigin,
  rewriteTextOrigin,
  rewriteVaultHtml,
  rewriteVaultText,
  rootRedirectHtml,
  verifySite,
  writeSiteRoot,
} from "../scripts/lib/site.mjs";

const LEGACY = DEFAULTS.legacyOrigin;
const SBOLT_LEGACY = SBOLT_DOC_SET.legacyOrigin;
const SBOLT_BASE = SBOLT_DOC_SET.publicBaseUrl;

/**
 * The shipped doc-set config carries tracked exemptions for pre-existing upstream 404s
 * in the vault artifact. The synthetic fixtures reproduce neither set's real content, so
 * they run with the exemptions cleared; the exemption mechanism has its own test below.
 */
const TEST_DOC_SETS = DOC_SETS.map((set) => ({ ...set, knownUnresolvedArtifactLinks: [] }));

/** Minimal stand-in for a HonKit build of k3-vault-docs. */
async function makeVaultBuild(root) {
  await mkdir(path.join(root, "introduction"), { recursive: true });
  await mkdir(path.join(root, "architecture"), { recursive: true });
  await mkdir(path.join(root, "gitbook"), { recursive: true });

  const sidebar = [
    `<a target="_blank" href="${LEGACY}/llms.txt">llms.txt</a>`,
    `<a target="_blank" href="${LEGACY}/llms-full.txt">llms-full.txt</a>`,
  ].join("\n");

  await writeFile(
    path.join(root, "index.html"),
    `<!doctype html><html><head><title>K3 Vaults</title></head><body>
${sidebar}
<a href="introduction/faq.html">FAQ</a>
<script src="gitbook/gitbook.js"></script>
</body></html>`,
  );
  await writeFile(
    path.join(root, "introduction", "faq.html"),
    `<!doctype html><html><head><title>K3 Vaults - FAQ</title></head><body>
${sidebar}
<a href="../index.html">Home</a>
<link rel="stylesheet" href="../gitbook/style.css">
</body></html>`,
  );
  await writeFile(path.join(root, "gitbook", "style.css"), "body{}\n");
  await writeFile(path.join(root, "gitbook", "gitbook.js"), "// honkit\n");
  await writeFile(
    path.join(root, "architecture", "system-design.html"),
    `<!doctype html><html><head><title>K3 Vaults - System design</title></head><body>
<pre><code class="lang-mermaid"><svg id="my-svg" class="flowchart" viewbox="0 0 10 10"></svg></code></pre>
</body></html>`,
  );
  await writeFile(
    path.join(root, "llms.txt"),
    `# K3 Vaults\n\n- [FAQ](${LEGACY}/introduction/faq.html)\n- [llms-full.txt](${LEGACY}/llms-full.txt)\n`,
  );
  await writeFile(path.join(root, "llms-full.txt"), `# FAQ\n\n[home](${LEGACY}/)\n`);
}

/**
 * Minimal stand-in for a HonKit build of sBOLT-docs: same shape as the vault build, plus
 * the imported `assets/` tree and the generator's `X/README.html` URL (which HonKit
 * actually publishes as `X/index.html`, so it exercises the normalization).
 */
async function makeSboltBuild(root) {
  await mkdir(path.join(root, "technical-details"), { recursive: true });
  await mkdir(path.join(root, "assets", "brand"), { recursive: true });
  await mkdir(path.join(root, "gitbook"), { recursive: true });

  const sidebar = [
    `<a target="_blank" href="${SBOLT_LEGACY}/llms.txt">llms.txt</a>`,
    `<a target="_blank" href="${SBOLT_LEGACY}/llms-full.txt">llms-full.txt</a>`,
  ].join("\n");

  await writeFile(
    path.join(root, "index.html"),
    `<!doctype html><html><head><title>sBOLD - Liquity v2 Design</title></head><body>
${sidebar}
<a href="technical-details/">Technical Details</a>
<img src="assets/brand/sBOLD-icon.png" alt="sBOLD">
<script src="gitbook/gitbook.js"></script>
</body></html>`,
  );
  await writeFile(
    path.join(root, "technical-details", "index.html"),
    `<!doctype html><html><head><title>sBOLD - Technical Details</title></head><body>
${sidebar}
<a href="../index.html">Home</a>
<img src="../assets/brand/sBOLD-icon@2x.png" alt="sBOLD 2x">
</body></html>`,
  );
  await writeFile(path.join(root, "gitbook", "style.css"), "body{}\n");
  await writeFile(path.join(root, "gitbook", "gitbook.js"), "// honkit\n");
  await writeFile(path.join(root, "assets", "brand", "sBOLD-icon.png"), "PNG-icon\n");
  await writeFile(path.join(root, "assets", "brand", "sBOLD-icon@2x.png"), "PNG-icon-2x\n");
  await writeFile(
    path.join(root, "llms.txt"),
    `# sBOLD\n\n- [Technical Details](${SBOLT_LEGACY}/technical-details/README.html)\n- [llms-full.txt](${SBOLT_LEGACY}/llms-full.txt)\n`,
  );
  await writeFile(
    path.join(root, "llms-full.txt"),
    `# sBOLD\n\nSource: ${SBOLT_LEGACY}\n\nSource: ${SBOLT_LEGACY}/technical-details/README.html\n`,
  );
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "k3-docs-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Build both fixtures into the site layout the workflow produces. */
async function assembleFixture(dir, { verify = false } = {}) {
  const vaultBuild = path.join(dir, "vault-build");
  const sboltBuild = path.join(dir, "sbolt-build");
  const out = path.join(dir, "_site");
  await makeVaultBuild(vaultBuild);
  await makeSboltBuild(sboltBuild);
  await mkdir(out, { recursive: true });

  await assembleVaultDocs({ vaultBuildDir: vaultBuild, outDir: out });
  await assembleSboltDocs({ sboltBuildDir: sboltBuild, outDir: out });
  await writeSiteRoot({ outDir: out });

  return { vaultBuild, sboltBuild, out, ...(verify ? { evidence: await verifySite({ outDir: out, docSets: TEST_DOC_SETS }) } : {}) };
}

test("relativePrefixForPage returns the walk back to the site root", () => {
  assert.equal(relativePrefixForPage("index.html"), "");
  assert.equal(relativePrefixForPage("introduction/faq.html"), "../");
  assert.equal(relativePrefixForPage("reference/deep/page.html"), "../../");
});

test("rewriteVaultHtml makes the llms artifacts reachable relative to each page", () => {
  const html = `<a href="${LEGACY}/llms.txt">llms.txt</a><a href="https://example.com/x">x</a>
<script>gitbook.page.hasChanged({"next":{"url":"${LEGACY}/llms.txt","ref":"${LEGACY}/llms.txt"}});</script>`;

  const rootPage = rewriteVaultHtml(html, "index.html");
  assert.match(rootPage, /href="llms\.txt"/);
  assert.match(rootPage, /"url":"llms\.txt"/);
  assert.match(rootPage, /"ref":"llms\.txt"/);
  assert.doesNotMatch(rootPage, /k3-capital\.github\.io/);
  assert.match(rootPage, /href="https:\/\/example\.com\/x"/, "unrelated links stay untouched");

  const nestedPage = rewriteVaultHtml(html, "introduction/faq.html");
  assert.match(nestedPage, /href="\.\.\/llms\.txt"/);
  assert.match(nestedPage, /"url":"\.\.\/llms\.txt"/);
});

test("rewriteHtmlOrigin rewrites the sBOLD source origin too", () => {
  const html = `<a href="${SBOLT_LEGACY}/llms-full.txt">full</a>`;
  const rewritten = rewriteHtmlOrigin(html, "technical-details/index.html", {
    legacyOrigin: SBOLT_LEGACY,
  });
  assert.match(rewritten, /href="\.\.\/llms-full\.txt"/);
  assert.doesNotMatch(rewritten, /k3-capital\.github\.io/);
});

test("rewriteVaultText repoints absolute artifact URLs at the canonical public base", () => {
  const text = `- [FAQ](${LEGACY}/introduction/faq.html)\norigin: ${LEGACY}`;
  const rewritten = rewriteVaultText(text);

  assert.match(rewritten, /\(https:\/\/docs\.k3\.capital\/vault-infra\/introduction\/faq\.html\)/);
  assert.match(rewritten, /origin: https:\/\/docs\.k3\.capital\/vault-infra$/m);
  assert.doesNotMatch(rewritten, /k3-capital\.github\.io/);
});

test("rewriteTextOrigin repoints the sBOLD origin and maps X/README.html onto the served directory", () => {
  const text = `- [Technical Details](${SBOLT_LEGACY}/technical-details/README.html)\n- [Home](${SBOLT_LEGACY}/)\nSource: ${SBOLT_LEGACY}`;
  const rewritten = rewriteTextOrigin(text, {
    legacyOrigin: SBOLT_LEGACY,
    publicBaseUrl: SBOLT_BASE,
  });

  assert.match(rewritten, /\[Technical Details\]\(https:\/\/docs\.k3\.capital\/sBOLT\/technical-details\/\)/);
  assert.match(rewritten, /\(https:\/\/docs\.k3\.capital\/sBOLT\/\)/);
  assert.doesNotMatch(rewritten, /README\.html/, "an unserved README.html URL must not survive");
  assert.doesNotMatch(rewritten, /k3-capital\.github\.io/);
});

test("normalizeReadmeUrls maps nested README.html onto the directory URL only", () => {
  assert.equal(
    normalizeReadmeUrls(`${SBOLT_BASE}technical-details/README.html`, SBOLT_BASE),
    `${SBOLT_BASE}technical-details/`,
  );
  assert.equal(normalizeReadmeUrls(`${SBOLT_BASE}README.html`, SBOLT_BASE), SBOLT_BASE);
  assert.equal(
    normalizeReadmeUrls(`${SBOLT_BASE}technical-details/interactions.html`, SBOLT_BASE),
    `${SBOLT_BASE}technical-details/interactions.html`,
  );
});

test("rootRedirectHtml redirects to the vault path relatively", () => {
  const html = rootRedirectHtml({ dirName: "vault-infra" });
  assert.match(html, /http-equiv="refresh" content="0; url=vault-infra\/"/);
  assert.match(html, /href="vault-infra\/"/);
  assert.match(html, /window\.location\.replace\("vault-infra\/"\)/);
});

test("assemble + verify serves both doc sets and keeps / forwarding to the vault docs", async () => {
  await withTempDir(async (dir) => {
    const { out, evidence } = await assembleFixture(dir, { verify: true });

    assert.ok(existsSync(path.join(out, "vault-infra", "index.html")));
    assert.ok(existsSync(path.join(out, "sBOLT", "index.html")));
    assert.ok(existsSync(path.join(out, "sBOLT", "technical-details", "index.html")));

    const root = await readFile(path.join(out, "index.html"), "utf8");
    assert.match(root, /url=vault-infra\//, "/ must keep forwarding to the vault docs");
    assert.doesNotMatch(root, /url=sBOLT\//);

    const sboltIndex = await readFile(path.join(out, "sBOLT", "index.html"), "utf8");
    assert.match(sboltIndex, /href="llms\.txt"/, "sBOLD sidebar links are page-relative");

    const sboltLlms = await readFile(path.join(out, "sBOLT", "llms.txt"), "utf8");
    assert.match(sboltLlms, /\(https:\/\/docs\.k3\.capital\/sBOLT\/technical-details\/\)/);
    assert.doesNotMatch(sboltLlms, /README\.html/);
    assert.doesNotMatch(sboltLlms, /k3-capital\.github\.io/);

    assert.deepEqual(evidence.docSets, ["vault", "sbolt"]);
    assert.equal(evidence.perSet.sbolt.dirName, "sBOLT");
    assert.equal(evidence.perSet.sbolt.pages, 2);
    assert.equal(evidence.perSet.sbolt.assetReferences, 2, "one image per sBOLD page");
    assert.equal(evidence.perSet.sbolt.artifactLinks, 4, "llms.txt + llms-full.txt URLs");
    assert.equal(evidence.perSet.vault.dirName, "vault-infra");
    assert.ok(evidence.perSet.vault.pages >= 2);
    assert.deepEqual(
      { blocks: evidence.mermaidBlocks, rendered: evidence.mermaidRendered },
      { blocks: 1, rendered: 1 },
    );
  });
});

test("assembleVaultDocs rewrites only the vault pages and copies assets verbatim", async () => {
  await withTempDir(async (dir) => {
    const build = path.join(dir, "build");
    const out = path.join(dir, "_site");
    await makeVaultBuild(build);
    await mkdir(out, { recursive: true });

    const { destination, rewritten } = await assembleVaultDocs({ vaultBuildDir: build, outDir: out });

    assert.ok(existsSync(path.join(destination, "index.html")));
    const rootSidebar = await readFile(path.join(out, "vault-infra", "index.html"), "utf8");
    assert.match(rootSidebar, /href="llms\.txt"/);
    const nested = await readFile(path.join(out, "vault-infra", "introduction", "faq.html"), "utf8");
    assert.match(nested, /href="\.\.\/llms\.txt"/);
    const llms = await readFile(path.join(out, "vault-infra", "llms.txt"), "utf8");
    assert.match(llms, /https:\/\/docs\.k3\.capital\/vault-infra\/introduction\/faq\.html/);

    assert.deepEqual(rewritten.sort(), ["index.html", "introduction/faq.html", "llms-full.txt", "llms.txt"]);
  });
});

test("the asset copy parity gate reports the files it copied and flags a dropped or truncated asset", async () => {
  await withTempDir(async (dir) => {
    const build = path.join(dir, "build");
    const out = path.join(dir, "_site");
    await makeSboltBuild(build);
    await mkdir(out, { recursive: true });

    const { destination, assets } = await assembleDocSet({
      buildDir: build,
      outDir: out,
      dirName: SBOLT_DOC_SET.dirName,
      legacyOrigin: SBOLT_LEGACY,
      publicBaseUrl: SBOLT_BASE,
    });
    assert.equal(assets, 2);
    assert.equal(destination, path.join(out, "sBOLT"));

    // A pipeline that drops an asset is exactly the regression this gate exists for.
    await rm(path.join(destination, "assets", "brand", "sBOLD-icon.png"));
    const dropped = await checkCopiedAssets({ sourceDir: build, destinationDir: destination });
    assert.deepEqual(dropped.missing, ["brand/sBOLD-icon.png"]);

    // A truncated copy is caught as well: size, not just existence, is compared.
    await writeFile(path.join(destination, "assets", "brand", "sBOLD-icon.png"), "PNG");
    const truncated = await checkCopiedAssets({ sourceDir: build, destinationDir: destination });
    assert.deepEqual(truncated.missing, ["brand/sBOLD-icon.png"]);

    await writeFile(path.join(destination, "assets", "brand", "sBOLD-icon.png"), "PNG-icon\n");
    const intact = await checkCopiedAssets({ sourceDir: build, destinationDir: destination });
    assert.deepEqual(intact, { assets: 2, missing: [] });
  });
});

test("verifySite rejects an artifact that does not serve the sBOLD documentation", async () => {
  await withTempDir(async (dir) => {
    const { out } = await assembleFixture(dir);
    await rm(path.join(out, "sBOLT"), { recursive: true, force: true });

    await assert.rejects(() => verifySite({ outDir: out, docSets: TEST_DOC_SETS }), /\/sBOLT\/ does not serve the sBOLD docs/);
  });
});

test("verifySite rejects an artifact whose root redirect is missing", async () => {
  await withTempDir(async (dir) => {
    const { out } = await assembleFixture(dir);
    await rm(path.join(out, "index.html"));

    await assert.rejects(() => verifySite({ outDir: out, docSets: TEST_DOC_SETS }), /root index\.html/);
  });
});

test("verifySite rejects a root redirect that points at sBOLD instead of the vault docs", async () => {
  await withTempDir(async (dir) => {
    const { out } = await assembleFixture(dir);
    await writeFile(path.join(out, "index.html"), rootRedirectHtml({ dirName: "sBOLT" }));

    await assert.rejects(() => verifySite({ outDir: out, docSets: TEST_DOC_SETS }), /does not redirect to vault-infra\//);
  });
});

test("verifySite rejects an artifact that still references a source-project origin", async () => {
  await withTempDir(async (dir) => {
    const { out } = await assembleFixture(dir);
    await writeFile(path.join(out, "sBOLT", "stale.txt"), `${SBOLT_LEGACY}/leftover\n`);

    await assert.rejects(() => verifySite({ outDir: out, docSets: TEST_DOC_SETS }), /still referenced/);
  });
});

test("verifySite rejects a page that published Mermaid source instead of a diagram", async () => {
  await withTempDir(async (dir) => {
    const { out } = await assembleFixture(dir);
    await writeFile(
      path.join(out, "vault-infra", "architecture", "system-design.html"),
      '<pre><code class="lang-mermaid">flowchart TB\n  A --> B\n</code></pre>',
    );

    await assert.rejects(() => verifySite({ outDir: out, docSets: TEST_DOC_SETS }), /Mermaid block\(s\) were published as raw source/);
  });
});

test("verifySite rejects a broken local link", async () => {
  await withTempDir(async (dir) => {
    const { out } = await assembleFixture(dir);
    await writeFile(path.join(out, "sBOLT", "broken.html"), '<a href="missing-page.html">gone</a>');

    await assert.rejects(() => verifySite({ outDir: out, docSets: TEST_DOC_SETS }), /broken local link/);
  });
});

test("verifySite rejects an asset reference that does not resolve", async () => {
  await withTempDir(async (dir) => {
    const { out } = await assembleFixture(dir);
    await rm(path.join(out, "sBOLT", "assets", "brand", "sBOLD-icon.png"));

    await assert.rejects(
      () => verifySite({ outDir: out, docSets: TEST_DOC_SETS }),
      /asset reference\(s\) in \/sBOLT\/ do not resolve/,
    );
  });
});

test("verifySite rejects an empty asset file", async () => {
  await withTempDir(async (dir) => {
    const { out } = await assembleFixture(dir);
    await writeFile(path.join(out, "sBOLT", "assets", "brand", "sBOLD-icon.png"), "");

    await assert.rejects(
      () => verifySite({ outDir: out, docSets: TEST_DOC_SETS }),
      /asset reference\(s\) in \/sBOLT\/ do not resolve/,
    );
  });
});

test("verifySite rejects an un-normalized README.html link in a generated artifact", async () => {
  await withTempDir(async (dir) => {
    const { out } = await assembleFixture(dir);
    await writeFile(
      path.join(out, "sBOLT", "llms.txt"),
      `# sBOLD\n\n- [Technical Details](${SBOLT_BASE}technical-details/README.html)\n`,
    );

    await assert.rejects(
      () => verifySite({ outDir: out, docSets: TEST_DOC_SETS }),
      /generated-artifact link\(s\) under https:\/\/docs\.k3\.capital\/sBOLT\/ do not resolve/,
    );
  });
});

test("a tracked artifact-link exemption is reported, and fails once the link resolves", async () => {
  await withTempDir(async (dir) => {
    const { out } = await assembleFixture(dir);
    const dangling = `${SBOLT_BASE}technical-details/README.html`;
    await writeFile(path.join(out, "sBOLT", "llms.txt"), `# sBOLD\n\n- [Technical Details](${dangling})\n`);

    const exempted = TEST_DOC_SETS.map((set) =>
      set.key === "sbolt" ? { ...set, knownUnresolvedArtifactLinks: [dangling] } : set,
    );

    const raw = await checkArtifactLinks({
      root: out,
      dirName: SBOLT_DOC_SET.dirName,
      publicBaseUrl: SBOLT_BASE,
      knownUnresolved: [dangling],
    });
    assert.deepEqual(raw.missing.map((hit) => hit.url), [dangling]);
    assert.deepEqual(raw.unexpected, [], "a tracked defect is not a new regression");
    assert.deepEqual(raw.newlyResolved, []);

    const evidence = await verifySite({ outDir: out, docSets: exempted });
    assert.deepEqual(evidence.perSet.sbolt.exemptedArtifactLinks, [dangling]);

    // Fix it upstream and the exemption goes stale — that must fail, not linger silently.
    await writeFile(path.join(out, "sBOLT", "llms.txt"), `# sBOLD\n\n- [Technical Details](${SBOLT_BASE}technical-details/)\n`);
    await assert.rejects(
      () => verifySite({ outDir: out, docSets: exempted }),
      /exempted generated-artifact link\(s\) now resolve/,
    );
  });
});

test("link extraction and resolution skip external targets and resolve directories", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "a"), { recursive: true });
    await writeFile(
      path.join(dir, "a", "index.html"),
      '<a href="/a/">dir</a><a href="#top">anchor</a><a href="mailto:x@y.z">mail</a><img src="/a/page.html">',
    );
    await writeFile(path.join(dir, "a", "page.html"), '<a href="../a/page.html">self</a>');

    const targets = extractLinkTargets(await readFile(path.join(dir, "a", "index.html"), "utf8"));
    assert.deepEqual(targets.sort(), ["#top", "/a/", "/a/page.html", "mailto:x@y.z"]);

    assert.equal(await resolveLocalTarget({ root: dir, pageRelPath: "a/index.html", target: "mailto:x@y.z" }), null);
    assert.equal(await resolveLocalTarget({ root: dir, pageRelPath: "a/index.html", target: "#top" }), null);
    assert.equal(
      await resolveLocalTarget({ root: dir, pageRelPath: "a/index.html", target: "/a/" }),
      path.join(dir, "a", "index.html"),
    );
    assert.equal(
      await resolveLocalTarget({ root: dir, pageRelPath: "a/page.html", target: "../a/page.html" }),
      path.join(dir, "a", "page.html"),
    );

    const { checked, missing } = await findBrokenLinks({ root: dir });
    assert.equal(missing.length, 0);
    assert.equal(checked, 3);
  });
});
