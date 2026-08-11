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
│   5. commitAndCreatePR on <your-repo>/logo-cdn (fresh branch)   │
│   6. mergePR() squash-merges + deletes the branch               │
│   7. update ticket: PR link + preview pinned to the merge SHA   │
│   8. transition ticket → "Done" (→ "In Review" if merge failed) │
└────────────────┬────────────────────────────────────────────────┘
                 │
        🔁 wrong logo? designer comments a replacement image
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ POST /api/webhook (comment created)                             │
│   → processLogo() again with the comment's image/SVG            │
│   → a NEW branch → a NEW PR → merged the same way               │
└─────────────────────────────────────────────────────────────────┘
```

Reviewing happens after the merge, not before it. There's no human gate on the
way in; the correction loop is the comment path, and it's cheap because each
run gets its own branch and PR.

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
- **`handle-done.ts`** — backstop on the "Done" state transition. `processLogo` already merges and moves the issue to Done itself, so this normally finds no open PR; it's there to catch a PR whose auto-merge failed and that a human then approved.
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
    handle-done.ts          ← Done-transition backstop for failed auto-merges
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

- **No merge gate; a correction loop instead.** PRs are auto-merged the moment they're opened. The bet is that for a logo library, a wrong logo shipped for ten minutes costs less than a review queue nobody drains — and the fix is one Linear comment, which opens and merges a fresh PR. Reintroduce the gate (branch protection, or restore `handleDone` as the only merge path) if your CDN can't take that.
- **One branch per run, never reused.** `commitAndCreatePR` resolves `logo/<slug>`, then `logo/<slug>-2`, `-3`… to the first name that's free. That's what makes a follow-up comment open a *new* PR instead of amending a merged one; in the normal flow the previous branch was deleted at merge time, so runs land back on `logo/<slug>`.
- **Previews are pinned to the merge commit.** Post-merge the feature branch is gone and the base branch keeps moving, so the Linear comment links `raw.githubusercontent.com/<owner>/<repo>/<merge-sha>/…` — the preview stays exactly what was approved.
- **The agent uses an LLM minimally.** Only the favicon-candidate ranking has heuristics; everything else is a deterministic pipeline. Most "agent" demos overuse LLMs — this one doesn't.
- **Composio dispatches per-toolkit user IDs.** Linear and GitHub connections can live under different Composio entities (different SSO scopes). The wrappers in `src/lib/composio.ts` pre-bind the right userId per toolkit; calling the bare SDK fails with `ActionExecute_ConnectedAccountEntityIdMismatch`.
- **All workspace/repo IDs are env-driven.** A fork brings its own Linear team / project / state IDs and target GitHub repo. See [docs/SETUP.md](SETUP.md).
