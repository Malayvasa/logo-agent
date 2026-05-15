# Architecture

A guide for forkers and contributors — what the code is, where the seams are, what gets called when.

## End-to-end flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Linear (your configured project)                                │
│   issue "Add stripe logo" with body "Website: https://stripe.com"│
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
│   5. commitAndCreatePR on <your-repo>/logo-cdn                  │
│   6. update ticket with PR link + preview image                 │
│   7. transition ticket → "In Review"                            │
└────────────────┬────────────────────────────────────────────────┘
                 │
        ⏳ designer reviews and moves ticket to "Done"
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ POST /api/webhook (Done state transition)                       │
│   → handleDone() squash-merges + deletes branch                 │
│   → comments back on ticket: "merged ✅"                        │
└─────────────────────────────────────────────────────────────────┘
```

## Entry points

All in `src/app/api/`:

| Route | Trigger | Auth |
| --- | --- | --- |
| `POST /api/webhook` | Linear issue updated / comment created | Composio HMAC signature |
| `POST /api/batch` | Manual sweep across all Triage-state tickets | `Authorization: Bearer $ADMIN_API_KEY` |
| `POST /api/backfill` | Seed N logos from a slug list, no Linear ticket required | `Authorization: Bearer $ADMIN_API_KEY` |

## Pipeline modules

All in `src/lib/`:

- **`process-logo.ts`** — orchestrates the full pipeline (favicon discovery → vectorize → normalize → PR → status update → state transition).
- **`fetch-favicon.ts`** — discovers favicon candidates from a website (meta tags, common paths, Google Favicon API fallback).
- **`vectorize.ts`** — vectorizer.ai client. Pre-processes ICO/WebP through `sharp` to a PNG before sending up. Wraps fetch errors as `ImageFetchError` so the orchestrator can try the next candidate.
- **`normalize-svg.ts`** — rewrites the viewBox so every logo fits the same 128×128 box.
- **`github.ts`** — GitHub ops via Composio (create branch, commit, open PR, merge, delete branch).
- **`composio.ts`** — Composio client + per-toolkit dispatch wrappers (`executeLinearTool` for Linear, `executeTool` for GitHub).
- **`linear-fetch.ts`** — fetch wrapper that adds the Linear API-key Authorization header for `uploads.linear.app` URLs (Linear's CDN is auth-gated and Composio doesn't proxy it).
- **`handle-done.ts`** — runs on the "Done" state transition. Merges the open PR for the slug, deletes the branch, comments back.
- **`auth.ts`** — admin Bearer-token auth + public-IP-only SSRF guard for comment-supplied URLs.
- **`config.ts`** — centralized env reads, lazy so missing vars fail at first use.

## Comment-input contract

If the agent picks the wrong favicon, a designer drops a replacement into a Linear comment. The pipeline supports four input shapes, checked in priority order:

1. **Raw `<svg>…</svg>` markup** pasted directly into the comment body. Used as-is — no fetch, no vectorizer.
2. **Linear file-drop attachment** (drag-drop a `.svg` / `.png` / `.jpg` / `.webp` / `.ico` into the comment box). The agent reads the filename from the markdown alt text, fetches the upload from `uploads.linear.app` with the Linear API key, and routes SVGs straight to PR / rasters to vectorizer.
3. **Public image URL** ending in a supported extension. SVG → direct fetch, raster → vectorizer. Query strings are tolerated.
4. **Markdown-wrapped URL** (`[label](<url>)`). The wrapper is stripped before extraction.

Status comments the agent writes always start with `**Logo Agent**` so it can find and delete its own old comments on retries.

## Repo layout

```
src/
  app/
    api/
      webhook/route.ts      ← Linear webhook + comment-rerun handler
      batch/route.ts        ← admin: process all Triage tickets
      backfill/route.ts     ← admin: seed logos from a slug list
    page.tsx                ← static landing page at /
  lib/
    process-logo.ts         ← main pipeline orchestrator
    fetch-favicon.ts        ← favicon discovery
    vectorize.ts            ← vectorizer.ai + sharp pre-processing
    normalize-svg.ts        ← 128×128 viewBox rewrite
    github.ts               ← branch / commit / PR / merge ops
    composio.ts             ← Composio client + dispatch wrappers
    linear-fetch.ts         ← fetch wrapper that auths uploads.linear.app
    handle-done.ts          ← merge handler on the Done transition
    auth.ts                 ← admin Bearer auth + SSRF guard
    config.ts               ← env-var reads
  types/index.ts
scripts/
  setup.ts                  ← interactive first-time setup (`npm run setup`)
  setup-trigger.ts          ← register the Linear webhook with Composio
  list-triggers.ts
  test-flow.ts
  test-linear.ts
```

## Design choices worth knowing about

- **The merge gate is a Linear state transition, not a button.** Moving the issue to **Done** is what fires the merge. This makes the "approve" action live in the same surface the designer is already in.
- **The agent uses an LLM minimally.** Only the favicon-candidate ranking has heuristics; everything else is a deterministic pipeline. Most "agent" demos overuse LLMs — this one doesn't.
- **Composio dispatches per-toolkit user IDs.** Linear and GitHub connections can live under different Composio entities (different SSO scopes). The wrappers in `src/lib/composio.ts` pre-bind the right userId per toolkit; calling the bare SDK fails with `ActionExecute_ConnectedAccountEntityIdMismatch`.
- **All workspace/repo IDs are env-driven.** A fork brings its own Linear team / project / state IDs and target GitHub repo. See [docs/SETUP.md](SETUP.md).
