# logo-agent

A small autonomous agent that turns a Linear ticket into a merged logo PR.

A designer files a ticket with a website URL — the agent fetches a favicon, vectorizes it, opens a PR on the logo CDN repo, merges it, and updates the ticket with a preview. End-to-end in seconds, no human in the loop.

Live: <https://logo-agent-production.up.railway.app>

## The problem

Composio maintains [logo-cdn](https://github.com/ComposioHQ/logo-cdn) — a public SVG library used to render app logos across the product (every integration card, every toolkit listing). New integrations ship constantly, and each one needs a logo committed to the CDN before it can render properly.

The manual flow looked like this:

1. Designer notices a missing logo
2. Files a ticket
3. Someone finds a favicon on the company's site
4. Vectorizes it (raster → SVG) in a tool like vectorizer.ai
5. Normalizes it to a 128×128 viewBox so it lines up with the rest of the library
6. Opens a PR on `ComposioHQ/logo-cdn` against `master`
7. Reviews, merges, deletes the branch
8. Goes back to Linear and closes the ticket

Multiply by ~50 logos a month, with every step prone to "I'll get to it tomorrow." This is the kind of work agents are made for: the inputs are structured (URL → image → SVG → PR), every step has a clean API, and the failure modes are bounded.

## The solution

The agent lives at the seam between Linear and GitHub. It listens for ticket events, runs a deterministic pipeline, and reports back into the ticket so the designer never has to context-switch.

```
Linear ticket            logo-agent              ComposioHQ/logo-cdn
─────────────            ──────────              ───────────────────
"Add Stripe logo"   →    fetch favicon
                    →    vectorize → SVG
                    →    normalize 128×128
                    →    open PR ─────────────→  PR #1234 opened
                    ←    auto-merge ───────────  PR merged, branch deleted
"Done ✅" + preview ←    update ticket
```

Concretely, the agent:

- **Discovers favicons** by scraping `<link rel="icon">` tags, probing common paths (`/favicon-192x192.png`, `/apple-touch-icon.png`), and falling back to the Google Favicon API. SVGs short-circuit straight to the PR step; rasters go through vectorizer.ai.
- **Normalizes every logo** to a 128×128 viewBox so the entire CDN is uniform.
- **Opens a PR with a live preview** — the description includes a `raw.githubusercontent.com` image URL pinned to `master` so it keeps working after the branch is deleted.
- **Auto-merges** via squash merge, deletes the branch, and posts the merged URL back into the Linear ticket.
- **Handles reruns from a comment.** If the agent picked the wrong asset, the designer drops a replacement into a comment and the agent re-runs against that. Four input shapes are supported, in priority order:
  1. **Raw `<svg>...</svg>` markup pasted into the comment body.** Used as-is. No fetch, no vectorizer.
  2. **Linear file-drop attachment** (drag-and-drop a `.svg` / `.png` / `.jpg` / `.webp` / `.ico` into the comment box). The agent reads the filename from the markdown alt text, fetches the upload from `uploads.linear.app` with the Linear API key, and routes SVGs straight to PR / rasters to the vectorizer.
  3. **Public image URL** ending in a supported extension. Same routing: SVG → direct fetch, raster → vectorizer. Query strings are tolerated.
  4. **Markdown-wrapped URL** (`[label](<url>)`). The wrapper is stripped before extraction.
- **Cleans up after itself** — every status comment the agent writes starts with `**Logo Agent**` so it can find and delete its own old comments on retries.

## Why this is interesting as a demo

This is a real, in-production use of [Composio](https://composio.dev) — it's the integration plumbing connecting Linear webhooks, the Linear API (comments, state transitions, issue queries), GitHub (branches, files, PRs, merges), and Composio's own search API (used to find a website URL when the ticket doesn't include one). One agent process, ~600 lines of TypeScript, four external services, all behind a single API key.

Things worth pointing out during a demo:

- **The trigger is a Linear webhook** delivered through Composio with HMAC verification. No polling, no cron.
- **The agent is "smart" only where it needs to be** — domain discovery uses a search fallback when the toolkit catalog lacks a URL; everything else is a deterministic pipeline. Most "agent" demos overuse LLMs; this one barely uses one (the LLM-y part is the candidate-ranking heuristics).
- **It has a comment-driven escape hatch.** When the favicon discovery picks the wrong asset, the designer drops a replacement into a Linear comment — by file, URL, or raw `<svg>` markup — and the agent reruns. The drop-a-file path needs a separate `LINEAR_API_KEY` because Linear's CDN gates uploads behind the same auth as the GraphQL API and Composio's toolkit doesn't expose a passthrough fetcher (worth a feedback note to Composio).
- **Two Composio entities, one process.** Linear and GitHub are connected under different Composio entities (a real-world wrinkle — different SSO scopes for different orgs). The agent dispatches the right `userId` per toolkit via thin wrappers in `src/lib/composio.ts`.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Linear (Logos project)                                          │
│   issue "Add stripe logo" with body "Website: https://stripe.com" │
└────────────────┬────────────────────────────────────────────────┘
                 │ LINEAR_ISSUE_UPDATED_TRIGGER (webhook via Composio)
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ POST /api/webhook   (HMAC verified)                             │
│   → derive slug, extract URL                                    │
│   → kick off processLogo() async, return 200 immediately        │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ processLogo                                                     │
│   1. comment in ticket: "⏳ fetching favicon"                   │
│   2. fetchFavicon(websiteUrl) → list of candidate image URLs    │
│   3. for each candidate: vectorize via vectorizer.ai → SVG      │
│   4. normalizeSvg → 128×128 viewBox                             │
│   5. commitAndCreatePR on ComposioHQ/logo-cdn                   │
│   6. mergePRForSlug (squash) + delete branch                    │
│   7. update ticket comment with merged PR + preview image       │
│   8. transition ticket → "In Review"                            │
└─────────────────────────────────────────────────────────────────┘
```

**Entry points** (all in `src/app/api/`):

| Route | Trigger | Auth |
| --- | --- | --- |
| `POST /api/webhook` | Linear issue updated / comment created | Composio HMAC signature |
| `POST /api/batch` | Manual sweep across all Triage tickets | `Authorization: Bearer $ADMIN_API_KEY` |
| `POST /api/backfill` | Seed N logos from a slug list, no Linear ticket required | `Authorization: Bearer $ADMIN_API_KEY` |

**Pipeline modules** (all in `src/lib/`): `process-logo.ts` orchestrates, `fetch-favicon.ts` discovers candidates, `vectorize.ts` calls vectorizer.ai (with sharp pre-processing for ICO/WebP edge cases), `normalize-svg.ts` rewrites the viewBox, `github.ts` does the GitHub ops, `composio.ts` is the Composio client and per-toolkit dispatch wrappers, `linear-fetch.ts` adds the Linear API-key Authorization header for `uploads.linear.app` URLs, `auth.ts` gates the admin endpoints.

## Running it locally

```bash
npm install
cp .env.example .env       # then fill in the keys
npm run dev                # next dev on :3000
```

You'll need accounts/keys for:

- **Composio** — `COMPOSIO_API_KEY`, plus a Linear and a GitHub connected account (set up in the Composio dashboard). The Linear connected account ID goes in `LINEAR_CONNECTED_ACCOUNT`. The GitHub connected account ID is currently hardcoded in `src/lib/github.ts` for the ComposioHQ org.
- **Linear** — your team ID in `LINEAR_TEAM_ID`. Find it in Linear's settings or via the API.
- **Linear personal API key** — `LINEAR_API_KEY` (`lin_api_…`). Only needed if you want designers to be able to drag-and-drop files into Linear comments — Linear gates `uploads.linear.app` behind the same auth as its GraphQL API, and Composio's toolkit doesn't proxy CDN fetches, so we hold a key directly. A read-only personal key is sufficient. Generate at `https://linear.app/<workspace>/settings/account/security`.
- **Vectorizer.ai** — `VECTORIZER_API_ID` + `VECTORIZER_API_SECRET`.
- **Webhook secret** — `COMPOSIO_WEBHOOK_SECRET`. The webhook fails closed if this isn't set, so even local dev needs a value (use anything during testing).
- **Admin token** — `ADMIN_API_KEY`. Required by `/api/batch` and `/api/backfill`. Same fail-closed behavior.

To register the Linear webhook trigger with Composio:

```bash
npx tsx scripts/setup-trigger.ts https://your-deploy-url/api/webhook
```

To kick off a batch run against every Triage ticket in the Logos project:

```bash
curl -X POST https://logo-agent-production.up.railway.app/api/batch \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

To seed logos for a known list of slugs (no Linear tickets required):

```bash
curl -X POST https://logo-agent-production.up.railway.app/api/backfill \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"slugs":["stripe","linear","github"],"autoMerge":true}'
```

## Deploying

Production runs on Railway. The Railway service is **not** wired to GitHub, so merging a PR doesn't redeploy automatically — you push deploys explicitly with `railway up --service logo-agent --ci` after pulling main. Full deploy runbook lives in [CLAUDE.md](./CLAUDE.md).

## Limitations & known sharp edges

- **Favicon quality is the floor for logo quality.** If a company ships only a 16×16 ICO, vectorizer.ai's output will look like a 16×16 ICO traced into vectors. The comment-rerun path exists for exactly this case.
- **The agent has write access to `ComposioHQ/logo-cdn` `master` and auto-merges.** Acceptable because (a) the repo is a logo asset library, not application code, and (b) all PRs are scoped to a single file under `src/assets/`. Don't repurpose this pattern for a real codebase without adding review gates.
- **Comment-triggered reruns trust whatever the commenter supplies** — URL, attachment, or raw `<svg>` markup. URLs are subject to public-IP-only SSRF filtering (`src/lib/auth.ts`); anyone with comment access in the Logos Linear project can cause the server to fetch arbitrary public URLs and to commit arbitrary SVG content into the CDN. Acceptable for an internal tool with a small trusted comment audience; revisit if the project access widens.
- **One Linear project, one GitHub repo, hardcoded.** The state IDs, project IDs, repo name, and team ID are all in code. This is intentional — it's an internal tool for one specific workflow, not a general-purpose framework.

## Repo layout

```
src/
  app/
    api/
      webhook/route.ts      ← Linear webhook + comment-rerun handler
      batch/route.ts        ← admin: process all Triage tickets
      backfill/route.ts     ← admin: seed logos from a slug list
    page.tsx                ← /  static landing page
  lib/
    process-logo.ts         ← main pipeline orchestrator
    fetch-favicon.ts        ← favicon discovery
    vectorize.ts            ← vectorizer.ai client + sharp pre-processing
    normalize-svg.ts        ← 128×128 viewBox rewrite
    github.ts               ← branch / commit / PR / merge ops
    composio.ts             ← Composio client + Linear/GitHub dispatch
    linear-fetch.ts         ← fetch wrapper that auths uploads.linear.app
    handle-done.ts          ← merge handler when an issue moves to Done
    auth.ts                 ← admin Bearer auth + SSRF guard
  types/index.ts
scripts/
  setup-trigger.ts          ← register the Linear webhook with Composio
  list-triggers.ts
  test-flow.ts
  test-linear.ts
```

See [CLAUDE.md](./CLAUDE.md) for deeper architectural notes — the Composio two-entity gotcha, Linear-specific rules (state IDs, comment markers, image preview URL rules), the GitHub merge strategy, common failure modes, and the Railway deploy runbook.
