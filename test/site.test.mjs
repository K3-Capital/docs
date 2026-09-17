import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULTS,
  assembleVaultDocs,
  extractLinkTargets,
  findBrokenLinks,
  resolveLocalTarget,
  rewriteVaultHtml,
  rewriteVaultText,
  rootRedirectHtml,
  vaultPrefixForPage,
  verifySite,
  writeSiteRoot,
} from "../scripts/lib/site.mjs";

const LEGACY = DEFAULTS.legacyOrigin;

/** Minimal stand-in for a HonKit build of k3-vault-docs. */
async function makeVaultBuild(root) {
  await mkdir(path.join(root, "introduction"), { recursive: true });
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
    path.join(root, "llms.txt"),
    `# K3 Vaults\n\n- [FAQ](${LEGACY}/introduction/faq.html)\n- [llms-full.txt](${LEGACY}/llms-full.txt)\n`,
  );
  await writeFile(
    path.join(root, "llms-full.txt"),
    `# FAQ\n\n[home](${LEGACY}/)\n`,
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

test("vaultPrefixForPage returns the walk back to the site root", () => {
  assert.equal(vaultPrefixForPage("index.html"), "");
  assert.equal(vaultPrefixForPage("introduction/faq.html"), "../");
  assert.equal(vaultPrefixForPage("reference/deep/page.html"), "../../");
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

test("rewriteVaultText repoints absolute artifact URLs at the canonical public base", () => {
  const text = `- [FAQ](${LEGACY}/introduction/faq.html)\norigin: ${LEGACY}`;
  const rewritten = rewriteVaultText(text);

  assert.match(rewritten, /\(https:\/\/docs\.k3\.capital\/vault-infra\/introduction\/faq\.html\)/);
  assert.match(rewritten, /origin: https:\/\/docs\.k3\.capital\/vault-infra$/m);
  assert.doesNotMatch(rewritten, /k3-capital\.github\.io/);
});

test("rootRedirectHtml redirects to the vault path relatively", () => {
  const html = rootRedirectHtml({ vaultDirName: "vault-infra" });
  assert.match(html, /http-equiv="refresh" content="0; url=vault-infra\/"/);
  assert.match(html, /href="vault-infra\/"/);
  assert.match(html, /window\.location\.replace\("vault-infra\/"\)/);
});

test("assemble + verify produces a servable /vault-infra/ tree and a root redirect", async () => {
  await withTempDir(async (dir) => {
    const build = path.join(dir, "build");
    const out = path.join(dir, "_site");
    await makeVaultBuild(build);
    await mkdir(out, { recursive: true });

    const { destination, rewritten } = await assembleVaultDocs({ vaultBuildDir: build, outDir: out });
    await writeSiteRoot({ outDir: out });

    assert.ok(existsSync(path.join(destination, "index.html")));

    const rootSidebar = await readFile(path.join(out, "vault-infra", "index.html"), "utf8");
    assert.match(rootSidebar, /href="llms\.txt"/);
    const nested = await readFile(path.join(out, "vault-infra", "introduction", "faq.html"), "utf8");
    assert.match(nested, /href="\.\.\/llms\.txt"/);
    const llms = await readFile(path.join(out, "vault-infra", "llms.txt"), "utf8");
    assert.match(llms, /https:\/\/docs\.k3\.capital\/vault-infra\/introduction\/faq\.html/);

    assert.deepEqual(rewritten.sort(), ["index.html", "introduction/faq.html", "llms-full.txt", "llms.txt"]);

    const evidence = await verifySite({ outDir: out });
    assert.equal(evidence.vaultDirName, "vault-infra");
    assert.equal(evidence.pages, 3, "root redirect + 2 vault pages");
    assert.ok(evidence.linksChecked >= 5);
  });
});

test("verifySite rejects an artifact whose root redirect is missing", async () => {
  await withTempDir(async (dir) => {
    const build = path.join(dir, "build");
    const out = path.join(dir, "_site");
    await makeVaultBuild(build);
    await mkdir(out, { recursive: true });
    await assembleVaultDocs({ vaultBuildDir: build, outDir: out });

    await assert.rejects(() => verifySite({ outDir: out }), /root index\.html/);
  });
});

test("verifySite rejects an artifact that still references the legacy origin", async () => {
  await withTempDir(async (dir) => {
    const build = path.join(dir, "build");
    const out = path.join(dir, "_site");
    await makeVaultBuild(build);
    await mkdir(out, { recursive: true });
    await assembleVaultDocs({ vaultBuildDir: build, outDir: out });
    await writeSiteRoot({ outDir: out });
    await writeFile(path.join(out, "vault-infra", "stale.txt"), `${LEGACY}/leftover\n`);

    await assert.rejects(() => verifySite({ outDir: out }), /still referenced/);
  });
});

test("verifySite rejects a broken local link", async () => {
  await withTempDir(async (dir) => {
    const build = path.join(dir, "build");
    const out = path.join(dir, "_site");
    await makeVaultBuild(build);
    await mkdir(out, { recursive: true });
    await assembleVaultDocs({ vaultBuildDir: build, outDir: out });
    await writeSiteRoot({ outDir: out });
    await writeFile(
      path.join(out, "vault-infra", "broken.html"),
      '<a href="missing-page.html">gone</a>',
    );

    await assert.rejects(() => verifySite({ outDir: out }), /broken local link/);
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