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
| `/sBOLT/` | [K3-Capital/sBOLT-docs](https://github.com/K3-Capital/sBOLT-docs) built with HonKit |

The sBOLD documentation is served under `/sBOLT/` — the casing the source repository and
the hosting request use. The product and the documentation content are spelled `sBOLD`;
the path segment is the single constant `dirName` in the `sbolt` entry of `DOC_SETS`
(`scripts/lib/site.mjs`), so it can be flipped in one place if that reading is wrong.

The two doc sets are configured in one place, `DOC_SETS` in `scripts/lib/site.mjs`. Adding
a third means adding an entry there, a matching checkout in `.github/workflows/deploy.yml`,
and (when there is more than one set) turning the root redirect into a chooser page.

## How it is built

`.github/workflows/deploy.yml` runs on pull requests, on pushes to `main`, on manual
dispatch, and on `repository_dispatch` (`docs-source-updated`) so a merge in a
documentation source repository can rebuild the site. It checks out each source
repository at `main`, runs the source project's own build, and calls:

```bash
scripts/build-site.sh    # VAULT_DIR=vendor/k3-vault-docs SBOLT_DIR=vendor/sBOLT-docs OUT_DIR=_site
```

which builds each source into `_book`, assembles `/vault-infra/` and `/sBOLT/`, and gates
the result with `scripts/assemble-site.mjs`. A failing check fails the build, so a broken
link, a lost redirect or a missing asset cannot deploy.

Per documentation set:

- `/<dir>/index.html` exists — the set is actually served at its path;
- `/index.html` redirects to `vault-infra/` with a relative target, so it works both at
  `https://docs.k3.capital/` and at the `https://k3-capital.github.io/docs/` preview URL;
- no reference to the source project's previous origin remains. The sidebar links to the
  generated `llms.txt` artifacts (and HonKit's inline `gitbook.page.hasChanged` navigation
  metadata) are rewritten to page-relative paths; the absolute URLs inside the llms
  artifacts are repointed at the set's canonical base; and the source trees HonKit copies
  into the build (`scripts/`, theme CSS) are scrubbed too;
- every `<img src>` resolves to a non-empty file, and every file the source build shipped
  under `assets/` landed in the artifact with the same size — a pipeline that copies only
  rendered HTML, or drops or truncates an asset, fails here;
- every absolute URL the generated `llms.txt` / `llms-full.txt` publish under the set's
  base resolves to a page in the artifact. Exceptions are tracked by name in the set's
  `knownUnresolvedArtifactLinks`; an exempted link that starts resolving fails the build,
  so the list cannot rot.

Artifact-wide:

- every local `href`/`src` in the artifact resolves to a file in the artifact (0 broken);
- every ```` ```mermaid ```` block in the artifact contains a rendered inline SVG — HonKit
  exits 0 while publishing raw diagram source if its headless browser is missing, so this
  is a build failure rather than a silent regression.

### Tracked upstream defects

`knownUnresolvedArtifactLinks` currently exempts two links in the vault artifact:
`/vault-infra/introduction/money-flow.html` and `/vault-infra/introduction/overview.html`.
`architecture/security-assumptions.md` links `../introduction/money-flow.md` and
`../introduction/overview.md`; both files exist in `k3-vault-docs` but are absent from its
`SUMMARY.md`, so the vault build never publishes them, and its llms generator rewrites the
links to `.html` anyway. Fixing it is an authoring change in `k3-vault-docs`; when it is
fixed, the build fails until the two entries are removed.

### Workflow gates

Because the deploy job holds a Pages write token, the workflow itself is treated as
part of the artifact and gated by `test/workflow.test.mjs`:

- no `run:` script contains a `${{ ... }}` expression. Expressions are substituted
  before the shell parses the script, so a `repository_dispatch` payload (attacker-
  influenced data) would become shell code. Payload values are passed through `env:`
  and read as quoted shell variables instead.
- a `repository_dispatch` must come from the dedicated dispatcher App *and* name a
  configured documentation source. `scripts/validate-dispatch-source.mjs` is the first
  step after the portal checkout, so an unexpected caller is rejected before any source
  repository is initialised. The payload's repository is a claim the caller writes, so it
  is only read once the event sender — the dispatcher App's bot identity — has been
  matched against `DISPATCHER_BOT_LOGIN`.
- concurrency lives on the jobs, not on the workflow: the `build` job collapses
  concurrent builds (`cancel-in-progress: true` — a superseded build is a pure function
  of the source branches and has nothing to publish), while the `deploy` job runs in its
  own `docs-pages-deploy` group with `cancel-in-progress: false`, so a Pages publish is
  never interrupted. Pull-request validation keeps its own per-PR group and can cancel
  neither a production build nor a deployment.
- the checkout repositories, vendor paths, npm cache keys and artifact-summary paths match
  `DOC_SETS`, so the workflow and the assembler cannot drift apart silently.

## Rebuilding when a source repository changes

`docs` is the only repository that assembles and deploys the combined site, and the only
one holding Pages credentials. Each documentation source repository
(`k3-vault-docs`, `sBOLT-docs`) carries a small `notify-docs-portal.yml` workflow that
runs after a push to its `main`:

1. mints a short-lived GitHub App installation token scoped to `K3-Capital/docs` and to
   `contents: write` — the one permission the dispatch endpoint needs
   (`actions/create-github-app-token`, with `repositories: docs`,
   `permission-contents: write`) — no long-lived PAT, and no permission for the source
   repository itself;
2. POSTs a `repository_dispatch` to this repository with
   `event_type: docs-source-updated` and `client_payload: { repository, sha, ref }`.

The sender's token is scoped to this repository alone, so the source repositories gain no
deployment credentials of any kind. The workflow file and its contract test live in the
source repositories; the contract itself is asserted on this side too
(`test/dispatch.test.mjs` checks the event type, the known source repositories and the
caller gate against the workflow).

### The dispatcher App

The senders authenticate with a **dedicated** dispatcher App, `k3-docs-dispatcher`:

- created and installed on `K3-Capital/docs` **only**, with `Contents: Read and write` and
  no other repository permission. Its installation token reaches this repository and no
  other, and is requested with the single permission the dispatch endpoint needs; it
  carries no `pages` permission, so the App can ask for a rebuild but never publish the
  site;
- its credentials (`DOCS_DISPATCH_APP_ID`, `DOCS_DISPATCH_APP_PRIVATE_KEY`) are stored as
  repository or organisation secrets visible to `k3-vault-docs` and `sBOLT-docs`.

Do not reuse the broader K3 App for this. What each source repository stores is the App
**private key**, and a key can mint installation tokens for every installation and
repository of the App that owns it, so copying a wide App's key into two more repositories
expands its blast radius well beyond the dispatch it is needed for.

The receiving side pins that App by identity: a dispatch created with an installation
token carries the App's bot user as the event sender, so `deploy.yml` requires
`github.event.sender.login` to be `k3-docs-dispatcher[bot]` (both constants live in
`scripts/lib/dispatch.mjs`). A renamed App, or a dispatch from any other principal — a
collaborator's token, another App, an unexpected bot — fails the gate even when its
payload names a real source repository. Until the App exists and its secrets are set, the
notify workflows fail visibly at the token step and send nothing.

Manual rebuilds stay available: `workflow_dispatch` on this workflow rebuilds the whole
site, and `workflow_dispatch` on a source repository's notify workflow re-sends its
dispatch.

## Local verification

```bash
multica repo checkout https://github.com/K3-Capital/k3-vault-docs   # or git clone
multica repo checkout https://github.com/K3-Capital/sBOLT-docs
mkdir -p vendor
ln -s /path/to/k3-vault-docs vendor/k3-vault-docs
ln -s /path/to/sBOLT-docs    vendor/sBOLT-docs

npm test                    # unit tests for the assembly, verification and workflow gates
scripts/build-site.sh       # full build (HonKit + Mermaid) and assembly into _site/
scripts/verify-site.mjs     # re-check an already assembled _site/
python3 -m http.server 8080 --directory _site   # http://localhost:8080/ -> /vault-infra/
```

The documentation builds need Node 22 and a headless Chromium for the Mermaid plugin
(`npx puppeteer browsers install chrome-headless-shell` in a source repo if its build
logs a missing-browser error).

## Deployment

GitHub Pages is configured for this repository with **Source: GitHub Actions**, so the
workflow's `deploy` job publishes `_site/` on every push to `main`. Custom domain and DNS
records for `docs.k3.capital` are handled outside this repository; until the domain is
live the site is reachable at `https://k3-capital.github.io/docs/`.
