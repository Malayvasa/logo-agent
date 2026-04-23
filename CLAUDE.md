# logo-agent

An automated pipeline: designer files a Linear issue with a website URL → agent fetches a favicon → vectorizes it to SVG → opens a PR on `ComposioHQ/logo-cdn` → auto-merges → updates the Linear issue with preview + PR link → moves the issue to "In Review".

Production: https://logo-agent-production.up.railway.app

## Architecture at a glance

**Entry points:**
- `src/app/api/webhook/route.ts` — Linear webhook handler. Receives `LINEAR_ISSUE_UPDATED_TRIGGER` events from Composio, deduplicates, parses slug + website URL, kicks off `processLogo`. Also handles the `Done` state transition (merges the PR via `handleDone`) and comment-triggered reruns (`@logo-agent rerun <imageUrl>`).
- `src/app/api/batch/route.ts` — one-shot endpoint that pulls all Triage-state issues from the Logos project and processes them in sequence.
- `src/app/api/backfill/route.ts` — batch endpoint that takes an explicit list of slugs and runs the full pipeline over them (for seeding logos without going through Linear). Uses Composio's v2 REST API directly for Linear issue creation (see "Two ways to call Composio" below).

**Pipeline:**
- `src/lib/process-logo.ts` — main agent flow. Creates a status comment, fetches favicon, vectorizes, normalizes SVG, opens PR, merges, updates comment with preview, moves issue to "In Review".
- `src/lib/handle-done.ts` — called when an issue moves to Done. Merges the open PR for that slug.
- `src/lib/fetch-favicon.ts` — discovers favicon candidates from a site (favicon.ico, apple-touch-icon, meta tags).
- `src/lib/vectorize.ts` — raster → SVG via vectorizer.ai. SVG candidates skip this step (see `process-logo.ts`).
- `src/lib/normalize-svg.ts` — resizes/centers the SVG to a 128×128 viewBox.
- `src/lib/github.ts` — GitHub ops (create branch, commit, PR, merge, delete branch).
- `src/lib/composio.ts` — Composio client + two tool-exec wrappers (`executeTool` for GitHub, `executeLinearTool` for Linear).

**Target repo:** `ComposioHQ/logo-cdn`, `master` branch. Logos go to `src/assets/<slug>.svg`.

## Composio setup — two entities, use the right wrapper

**IMPORTANT:** This project's Composio connected accounts are split across two entities. Using the wrong userId fails every tool call with `ActionExecute_ConnectedAccountEntityIdMismatch`.

- **Linear** (`ca_32jlkHR7XaS-`, from `LINEAR_CONNECTED_ACCOUNT` env) → entity `pg-test-ac8a98fe-69d3-42c3-aa8d-866e52e6ab0d`
- **GitHub** (`ca_WTKgBWdCdU0P`, hardcoded in `github.ts`) → entity `agent-sso-update`

The wrappers in `src/lib/composio.ts` bundle the right userId:
- **Any Linear call:** `executeLinearTool(slug, args)` — pre-binds the Linear entity
- **Any GitHub call:** `executeTool(slug, args, connectedAccountId)` — defaults to `agent-sso-update`

Do NOT call `composio.tools.execute(...)` directly. Do NOT call `executeTool` for Linear slugs. Always use `executeLinearTool` for `LINEAR_*` slugs — the wrapper is the enforcement mechanism.

### Two ways to call Composio in this repo

1. **SDK** (`@composio/core`) via `executeTool` / `executeLinearTool` — used everywhere except backfill. Requires `userId`.
2. **Raw v2 REST API** via `fetch("https://backend.composio.dev/api/v2/actions/.../execute", ...)` — used only in `backfill/route.ts` for `LINEAR_CREATE_LINEAR_ISSUE`. Does not require `userId`; resolves entity from `connectedAccountId` alone.

If you're adding a new Linear call, use `executeLinearTool`. Don't reach for the REST API.

## Linear-specific rules

- **Webhook trigger:** `LINEAR_ISSUE_UPDATED_TRIGGER`, scoped to the Logos project. Configured via `scripts/setup-trigger.ts`.
- **"In Review" state ID:** `db21e0d5-b9b1-4861-ace9-7f2d2ebd85bb` (hardcoded in `process-logo.ts` and `handle-done.ts`).
- **Team ID:** `48c4ab35-8398-408d-967b-881b13d7ca57` (from `LINEAR_TEAM_ID` env).
- **Logos project ID:** hardcoded in `batch/route.ts` and `backfill/route.ts` as `LOGOS_PROJECT_ID`.
- **Triage state name:** `Triage`.
- **Image previews in Linear comments:** Linear does NOT render `data:image/*;base64,...` URIs — they show up as literal base64 text. Always use a `raw.githubusercontent.com` URL. Prefer a merge-commit-SHA-pinned URL (`.../logo-cdn/<sha>/src/assets/<slug>.svg`) if you want the preview frozen in time; `master` URL is fine for live previews.
- **Issue title normalization:** the webhook renames `"[Logo Request] submission"` titles to `"[<slug>] Add logo"` so downstream tooling has a consistent title.
- **Agent comment marker:** every comment the agent posts starts with `**Logo Agent**`. Use this to detect / clean up prior comments before writing new ones.

## GitHub-specific rules

- **PR branch naming:** `logo/<slug>`. Branches are deleted after merge (see `mergePRForSlug`).
- **PR preview image URL:** use the `master` branch URL, NOT the `logo/<slug>` branch URL. Branches are deleted post-merge, so a branch-scoped URL 404s once the PR is merged. `github.ts` already does this correctly — keep it that way.
- **Merge strategy:** squash merges.
- **Auto-merge:** happy-path auto-merges. The window between open and merge is seconds in practice.

## Environment variables

Required (see `.env.example`):
- `COMPOSIO_API_KEY` — Composio API key
- `COMPOSIO_WEBHOOK_SECRET` — shared secret for webhook HMAC verification
- `LINEAR_CONNECTED_ACCOUNT` — Linear connected account ID (`ca_32jlkHR7XaS-`)
- `LINEAR_TEAM_ID` — Linear team ID
- `VECTORIZER_API_ID` (or `VECTORIZER_API_KEY`) + `VECTORIZER_API_SECRET` — vectorizer.ai credentials

## Local dev

```bash
npm install
npm run dev          # next dev --turbopack on :3000
```

To simulate a webhook locally, POST a Composio-wrapped Linear issue payload to `http://localhost:3000/api/webhook`. Real webhooks are HMAC-signed — set `COMPOSIO_WEBHOOK_SECRET` and include `x-composio-signature` header.

Utility scripts (all via `npx tsx scripts/<name>.ts`):
- `setup-trigger.ts` — register the Linear webhook trigger with Composio
- `list-triggers.ts` — list available Linear triggers + current connected accounts
- `test-linear.ts` — smoke-test Linear tool access

## Deploying

**Production runs on Railway. The service is NOT connected to GitHub**, so merging a PR does NOT auto-deploy. You must manually push a deploy after every merge.

### After a PR you opened is merged to main, deploy it

From the main repo checkout (not a worktree):

```bash
cd /Users/malayvasa/Developer/GitHub/logo-agent
git checkout main
git pull --ff-only origin main
railway up --service logo-agent --ci
```

Verify: `curl -sI https://logo-agent-production.up.railway.app/` should return `HTTP/2 200`.

Rules:
- Only deploy **after** the user has merged the PR. Don't deploy from a feature branch. Don't deploy before merge.
- If `git pull` complains about uncommitted local changes in the main repo, stash them (`git stash push -m "..."`), pull + deploy, then `git stash pop`. Do not discard the user's in-progress work.
- After deploy, check logs briefly in case the build succeeded but the runtime crashes (`railway logs --service logo-agent`).

### Railway project details

- Project: `logo-agent` (under "Malay Vasa's Projects")
- Service: `logo-agent`
- Environment: `production`
- Domain: `logo-agent-production.up.railway.app`
- No GitHub source wired up — Railway's GitHub app is installed on the ComposioHQ org, not the Malayvasa personal account. Deploys are `railway up` only.

## Common gotchas

- **Linear call fails with "ConnectedAccountEntityIdMismatch":** you're calling `executeTool` on a `LINEAR_*` slug instead of `executeLinearTool`. Switch to the wrapper.
- **Linear comment renders as `data:image/svg+xml;base64,...` text:** don't use data URIs in Linear comments — use a `raw.githubusercontent.com` URL.
- **PR preview image 404s on a merged PR:** the PR body points at the deleted `logo/<slug>` branch. `github.ts` should be using the `master` URL now; double-check.
- **Webhook fires twice for the same slug:** `webhook/route.ts` has a `processing` Set for dedup. Reuse it rather than adding your own.
- **Vectorizer fails with "Image format not supported":** the source is probably an ICO or WebP that sharp can't convert. Covered — `vectorize.ts` catches and wraps as `ImageFetchError` so the next candidate is tried.
- **SVG source still hits vectorizer:** should not — `process-logo.ts` short-circuits `.svg` candidates. If a logo ends in `.svg` but isn't valid SVG content, it falls back to vectorizer.
- **Next.js build fails on Railway with `sharp` errors:** shouldn't, Railway's Linux runtime handles native deps. If this pops up, check the nixpacks output — a Node version mismatch is the usual cause.
