# docs.k3.capital

Static site for the K3 corporate documentation domain. The repository contains no
documentation itself: it builds each documentation source with that project's own
toolchain, assembles the results into one GitHub Pages artifact under fixed paths, and
deploys it. `docs.k3.capital` is pointed at this Pages site with DNS only — no proxy or
edge worker is involved.

Current layout of the deployed artifact:

| Path | Content |
| --- | --- |
| `/` | Redirect to `/vault-infra/` (a chooser page will replace it when more doc sets land) |
| `/vault-infra/` | [K3-Capital/k3-vault-docs](https://github.com/K3-Capital/k3-vault-docs) built with HonKit |

`sBOLD` documentation is not included yet: its source repository does not exist. When it
does, add a second checkout plus a `/<path>/` destination in `scripts/build-site.sh` and
`scripts/assemble-site.mjs`, and turn the root redirect into a chooser page.

## How it is built

`.github/workflows/deploy.yml` runs on pull requests, on pushes to `main`, on manual
dispatch, and on `repository_dispatch` (`docs-source-updated`) so a merge in a
documentation source repository can rebuild the site. It checks out each source
repository at `main`, runs the source project's own build, and calls:

```bash
scripts/build-site.sh          # VAULT_DIR=vendor/k3-vault-docs OUT_DIR=_site
```

which builds `/vault-infra/` from the vault docs `_book` output and then gates the
assembled artifact with `scripts/assemble-site.mjs`:

- `/vault-infra/index.html` exists (the documentation set is served at the expected path);
- `/index.html` redirects to `vault-infra/` with a relative target, so it works both at
  `https://docs.k3.capital/` and at the `https://k3-capital.github.io/docs/` preview URL;
- no reference to the vault docs' previous origin (`k3-capital.github.io/k3-vault-docs`)
  remains — the sidebar links to the generated `llms.txt` artifacts are rewritten to
  page-relative paths, and the absolute URLs inside those artifacts are repointed at the
  canonical `https://docs.k3.capital/vault-infra/` base;
- every local `href`/`src` in the artifact resolves to a file in the artifact (0 broken).

A failing check fails the build, so a broken link or a lost redirect cannot deploy.

## Local verification

```bash
multica repo checkout https://github.com/K3-Capital/k3-vault-docs   # or git clone
mkdir -p vendor && ln -s /path/to/k3-vault-docs vendor/k3-vault-docs

npm test                    # unit tests for the assembly + verification helpers
scripts/build-site.sh       # full build (HonKit + Mermaid) and assembly into _site/
scripts/verify-site.mjs     # re-check an already assembled _site/
python3 -m http.server 8080 --directory _site   # http://localhost:8080/ -> /vault-infra/
```

The vault docs build needs Node 22 and a headless Chromium for the Mermaid plugin
(`npx puppeteer browsers install chrome-headless-shell` in the vault repo if the build
logs a missing-browser error).

## Deployment

GitHub Pages is configured for this repository with **Source: GitHub Actions**, so the
workflow's `deploy` job publishes `_site/` on every push to `main`. Custom domain and DNS
records for `docs.k3.capital` are handled outside this repository; until the domain is
live the site is reachable at `https://k3-capital.github.io/docs/`.