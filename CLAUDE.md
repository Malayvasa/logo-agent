# logo-agent

An automated pipeline: designer files a Linear issue with a website URL → agent fetches a favicon → vectorizes it to SVG → opens a PR on `ComposioHQ/logo-cdn` → posts preview + PR link on the issue → moves the issue to "In Review". A human reviews the preview and moves the issue to **Done**, which triggers the merge.

Production: https://logo-agent-production.up.railway.app

## Architecture at a glance

**Entry points:**
- `src/app/api/webhook/route.ts` — Linear webhook handler. Receives `LINEAR_ISSUE_UPDATED_TRIGGER` events from Composio, deduplicates, parses slug + website URL, kicks off `processLogo`. Also handles the `Done` state transition (merges the PR via `handleDone`) and comment-triggered reruns (`@logo-agent rerun <imageUrl>`).
- `src/app/api/batch/route.ts` — one-shot endpoint that pulls all Triage-state issues from the Logos project and processes them in sequence.
- `src/app/api/backfill/route.ts` — batch endpoint that takes an explicit list of slugs and runs the full pipeline over them (for seeding logos without going through Linear). Uses Composio's v2 REST API directly for Linear issue creation (see "Two ways to call Composio" below).

**Pipeline:**
- `src/lib/process-logo.ts` — main agent flow. Creates a status comment, fetches favicon, vectorizes, normalizes SVG, opens PR, posts the preview + PR link, moves issue to "In Review". Does NOT merge — that happens on the Done transition.
- `src/lib/handle-done.ts` — called when an issue moves to Done. Merges the open PR for that slug. This is the gating step: a human must approve by moving the issue to Done before anything lands on master.
- `src/lib/fetch-favicon.ts` — discovers favicon candidates from a site (favicon.ico, apple-touch-icon, meta tags).
- `src/lib/vectorize.ts` — raster → SVG via vectorizer.ai. SVG candidates skip this step (see `process-logo.ts`).
- `src/lib/normalize-svg.ts` — resizes/centers the SVG to a 128×128 viewBox.
- `src/lib/github.ts` — GitHub ops (create branch, commit, PR, merge, delete branch).
- `src/lib/composio.ts` — Composio client + two tool-exec wrappers (`executeTool` for GitHub, `executeLinearTool` for Linear).

**Target repo:** `ComposioHQ/logo-cdn`, `master` branch. Logos go to `src/assets/<slug>.svg`.

## Composio setup — two entities, use the right wrapper

**IMPORTANT:** Composio's userId (entity) is set per connected account. If your Linear and GitHub connections live under different entities (common with separate SSO scopes), using the wrong userId fails every tool call with `ActionExecute_ConnectedAccountEntityIdMismatch`.

Configured via env:
- **Linear** → `LINEAR_CONNECTED_ACCOUNT` + `LINEAR_USER_ID`
- **GitHub** → `GITHUB_CONNECTED_ACCOUNT` + `GITHUB_USER_ID` (defaults to `"default"`)

The wrappers in `src/lib/composio.ts` bundle the right userId:
- **Any Linear call:** `executeLinearTool(slug, args)` — pre-binds the Linear entity
- **Any GitHub call:** `executeTool(slug, args, connectedAccountId)` — defaults to the GitHub entity

Do NOT call `composio.tools.execute(...)` directly. Do NOT call `executeTool` for Linear slugs. Always use `executeLinearTool` for `LINEAR_*` slugs — the wrapper is the enforcement mechanism.

### Two ways to call Composio in this repo

1. **SDK** (`@composio/core`) via `executeTool` / `executeLinearTool` — used everywhere except backfill. Requires `userId`.
2. **Raw v2 REST API** via `fetch("https://backend.composio.dev/api/v2/actions/.../execute", ...)` — used only in `backfill/route.ts` for `LINEAR_CREATE_LINEAR_ISSUE`. Does not require `userId`; resolves entity from `connectedAccountId` alone.

If you're adding a new Linear call, use `executeLinearTool`. Don't reach for the REST API.

## Linear-specific rules

- **Webhook trigger:** `LINEAR_ISSUE_UPDATED_TRIGGER`, scoped to the configured project (`LINEAR_PROJECT_NAME`, default `"Logos"`). Configured via `scripts/setup-trigger.ts`.
- **"In Review" state ID:** `LINEAR_IN_REVIEW_STATE_ID` env.
- **Team ID:** `LINEAR_TEAM_ID` env.
- **Project ID:** `LINEAR_LOGOS_PROJECT_ID` env.
- **Triage state name:** `LINEAR_TRIAGE_STATE_NAME` env (default `"Triage"`).
- All of the above are read through helpers in `src/lib/config.ts` — never hardcode IDs in route files.
- **Image previews in Linear comments:** Linear does NOT render `data:image/*;base64,...` URIs — they show up as literal base64 text. Always use a `raw.githubusercontent.com` URL. Prefer a merge-commit-SHA-pinned URL (`.../logo-cdn/<sha>/src/assets/<slug>.svg`) if you want the preview frozen in time; `master` URL is fine for live previews.
- **Issue title normalization:** the webhook renames `"[Logo Request] submission"` titles to `"[<slug>] Add logo"` so downstream tooling has a consistent title.
- **Agent comment marker:** every comment the agent posts starts with `**Logo Agent**`. Use this to detect / clean up prior comments before writing new ones.

## GitHub-specific rules

- **Target repo:** `LOGO_REPO_OWNER` + `LOGO_REPO_NAME` env, base branch `LOGO_REPO_BRANCH` (default `main`). Read via `src/lib/config.ts`.
- **PR branch naming:** `logo/<slug>`. Branches are deleted after merge (see `mergePRForSlug`).
- **PR preview image URL:**
  - **In the PR body** (`github.ts`) — use the base-branch URL. Feature branches get deleted on merge, so a branch URL 404s post-merge.
  - **In the Linear "ready for review" comment** (`process-logo.ts`) — use the `logo/<slug>` branch URL. The file isn't on the base branch yet (the PR is still open), and the branch is guaranteed to exist until `handleDone` merges and deletes it.
- **Merge strategy:** squash merges.
- **Merge gating:** PRs are NOT auto-merged. They stay open until a human moves the Linear issue to **Done**, which fires the webhook → `handleDone` → merge. This is the human-approval step.

## Environment variables

See `.env.example` for the full list with comments. All workspace/repo/state IDs come from env via `src/lib/config.ts` — do not reintroduce hardcoded UUIDs in route files.

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

## Deploying (maintainer runbook)

This section is specific to the maintainer's Railway deploy. A fork is free to deploy anywhere Node + Next.js runs — Vercel, Fly, Render, self-hosted, etc.

**Production runs on Railway. The service is NOT connected to GitHub**, so merging a PR does NOT auto-deploy. The maintainer manually pushes a deploy after every merge.

### After a PR is merged to main, deploy it

From the main repo checkout (not a worktree):

```bash
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
