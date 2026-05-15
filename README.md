<!-- TODO(logo): drop a centered banner / logo here once it's designed -->

# Logo Agent

> Your third-party logo library, auto-maintained from Linear.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Built with Composio](https://img.shields.io/badge/built%20with-Composio-7c3aed)](https://composio.dev)
[![Next.js 15](https://img.shields.io/badge/Next.js-15-black)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org)

<!-- TODO(demo): drop a GIF/screencast of the full flow here.
     Linear ticket → preview comment → PR → Done → merge.
     Aider's screencast and Claude Code's demo.gif are good references. -->

Many products maintain a library of third-party logos — for integrations they support, partners they list, tools they reference in docs. Keeping that library current is a recurring chore: find a favicon, vectorize it, normalize the dimensions, open a PR, review, merge. Logo Agent automates the chore. A designer files a Linear ticket with a website URL; the agent fetches the favicon, vectorizes it, opens a PR with a preview, and merges only when a human moves the ticket to **Done**.

It's a real, in-production agent running on [Composio](https://composio.dev) — ~600 lines of TypeScript wiring Linear webhooks to GitHub PRs to [vectorizer.ai](https://vectorizer.ai), with the right escape hatches for when the favicon picker gets it wrong.

## Features

- **Linear-driven.** Issues create work, state transitions gate everything. No new dashboard for designers to learn.
- **Designer-approved merges.** Nothing lands on the CDN's `main`/`master` until a human moves the issue to **Done**. The agent is the work; the human is the trust gate.
- **Smart favicon discovery.** Scrapes `<link rel="icon">`, probes common paths (`/favicon-192x192.png`, `/apple-touch-icon.png`), falls back to the Google Favicon API.
- **Anything → SVG.** Rasters (PNG/JPG/ICO/WebP) go through vectorizer.ai. Native SVGs short-circuit straight to the commit step. Everything gets rewritten to a uniform 128×128 viewBox.
- **Comment-driven retries.** Drop a replacement image, public URL, or raw `<svg>` markup into a Linear comment and the agent re-runs against it. Four input shapes are supported in priority order — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#comment-input-contract) for the contract.
- **Webhook-native.** No polling, no cron. HMAC-verified Linear webhooks via Composio.

## Quick start

```bash
# Install the Composio CLI (one-time)
curl -fsSL https://composio.dev/install | bash

git clone https://github.com/Malayvasa/logo-agent && cd logo-agent
npm install
npm run setup    # interactive — links Composio accounts, writes .env
npm run dev      # next dev on :3000
```

`npm run setup` opens browser flows for GitHub + Linear OAuth, asks you to pick the right Linear team / project / state from menus, and writes a complete `.env`. Once it's running locally, deploy somewhere with a public URL and register the Linear webhook:

```bash
npx tsx scripts/setup-trigger.ts https://your-deploy.com/api/webhook
```

**Detailed setup, env-var reference, admin endpoints, and troubleshooting →** [docs/SETUP.md](docs/SETUP.md)

## How it works

```
Linear ticket           Logo Agent              <your-repo>/logo-cdn
─────────────           ──────────              ────────────────────
"Add Stripe logo"  →    fetch favicon
                   →    vectorize → SVG
                   →    normalize 128×128
                   →    open PR ──────────────→ PR opened
"In Review"  ←─────     comment + preview
                                                       ⏳ human reviews
"Done ✅"    ────→      merge ─────────────────→ PR merged, branch deleted
```

1. Designer files a Linear issue. The body has a website URL (the agent also falls back to Composio's toolkit catalog if no URL is provided).
2. Composio's webhook fires. [`/api/webhook`](src/app/api/webhook/route.ts) verifies the HMAC signature and kicks off the pipeline.
3. The agent discovers favicon candidates and tries each one. SVGs go straight through; rasters route through vectorizer.ai.
4. The SVG gets rewritten to a 128×128 viewBox and committed on a `logo/<slug>` branch. A PR is opened against your CDN repo.
5. The agent comments the preview onto the Linear issue and moves it to **In Review**.
6. A human reviews. Moving the issue to **Done** is the merge trigger — the agent squash-merges, deletes the branch, and confirms back on the issue.

The agent also handles comment-driven retries: if the favicon pick was wrong, the designer drops a replacement into a comment and the pipeline re-runs against that input.

## Stack

| | |
| --- | --- |
| Integration plumbing | [Composio](https://composio.dev) — Linear webhook, Linear + GitHub tools, Composio Search |
| Raster → SVG | [vectorizer.ai](https://vectorizer.ai) |
| HTTP + webhook | Next.js 15 |
| Image pre-processing | `sharp` |

## Limitations & known sharp edges

- **Favicon quality is the floor for logo quality.** If a company ships only a 16×16 ICO, vectorizer.ai's output will look like a 16×16 ICO traced into vectors. The comment-rerun path exists for exactly this case.
- **Anyone with comment access in the Linear project can trigger reruns.** URLs go through public-IP-only SSRF filtering ([`src/lib/auth.ts`](src/lib/auth.ts)), but the agent will still happily fetch arbitrary public URLs and commit arbitrary SVG content into the CDN on their behalf. Acceptable for a trusted internal Linear audience; revisit before widening project access.
- **One Linear project, one GitHub repo per deploy.** State IDs, project IDs, repo name, team ID all come from env vars. Fork and run a second instance for a second workflow.
- **The default branch defaults to `main`.** Set `LOGO_REPO_BRANCH=master` in `.env` if your CDN uses master.

## Why this exists

[Composio](https://composio.dev) maintains [logo-cdn](https://github.com/ComposioHQ/logo-cdn), a public SVG library used to render app logos across the product. New integrations ship constantly, each one needs a logo committed before it can render, and the manual flow is tedious — find a favicon, vectorize it, normalize the viewBox, open a PR, review, merge, delete the branch, close the ticket. Multiply by ~50 logos a month and you've got a recurring chore that's structured enough for an agent to handle: every step has a clean API and the failure modes are bounded.

This is the kind of work [Composio](https://composio.dev) is built for. Logo Agent is the simplest end-to-end demo of that pattern that's also a real production tool — one webhook, one squash merge, one Linear state transition. Fork it for any "ticket-driven asset pipeline" workflow.

## More docs

- **[docs/SETUP.md](docs/SETUP.md)** — installation, env-var reference, admin endpoints, troubleshooting
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — entry points, pipeline modules, comment-input contract, design choices
- **[CLAUDE.md](CLAUDE.md)** — maintainer-internal notes (Composio gotchas, Linear quirks, deploy runbook)

## License

MIT — see [LICENSE](LICENSE).
