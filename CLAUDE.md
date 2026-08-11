# logo-agent

An automated pipeline: designer files a Linear issue with a website URL → agent fetches a favicon → vectorizes it to SVG → opens a PR on `ComposioHQ/logo-cdn` → **squash-merges it immediately** → posts the merged preview + PR link on the issue → moves the issue to "Done". There is no human merge gate. If the logo is wrong, the designer comments a replacement image on the same issue and the agent opens and merges a **new** PR.

Production: https://logo-agent-production.up.railway.app

## Architecture at a glance

**Entry points:**
- `src/app/api/webhook/route.ts` — Linear webhook handler. Receives `LINEAR_ISSUE_UPDATED_TRIGGER` events from Composio, deduplicates, parses slug + website URL, kicks off `processLogo`. Also handles comment-triggered reruns (drop an image / URL / raw `<svg>` in a comment) and the `Done` state transition, which is now only a backstop (`handleDone`) for a PR whose auto-merge failed.
- `src/app/api/batch/route.ts` — one-shot endpoint that pulls all Triage-state issues from the Logos project and processes them in sequence.
- `src/app/api/backfill/route.ts` — batch endpoint that takes an explicit list of slugs and runs the full pipeline over them (for seeding logos without going through Linear). Uses Composio's v2 REST API directly for Linear issue creation (see "Two ways to call Composio" below).

**Pipeline:**
- `src/lib/process-logo.ts` — main agent flow. Creates a status comment, fetches favicon, vectorizes, normalizes SVG, opens a PR, **merges it**, posts the merged preview + PR link, moves the issue to "Done" (or "In Review" if the merge failed).
- `src/lib/handle-done.ts` — backstop on the Done transition. `processLogo` merges its own PR and sets Done itself, so this normally finds nothing to merge; it only catches PRs whose auto-merge failed and that a human then approved.
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
- **"In Review" state ID:** `LINEAR_IN_REVIEW_STATE_ID` env — the fallback state when a PR opened but couldn't be merged.
- **"Done" state ID:** `LINEAR_DONE_STATE_ID` env (optional). Where merged issues land. Unset, merged issues stay in "In Review".
- **Team ID:** `LINEAR_TEAM_ID` env.
- **Project ID:** `LINEAR_LOGOS_PROJECT_ID` env.
- **Triage state name:** `LINEAR_TRIAGE_STATE_NAME` env (default `"Triage"`).
- All of the above are read through helpers in `src/lib/config.ts` — never hardcode IDs in route files.
- **Image previews in Linear comments:** Linear does NOT render `data:image/*;base64,...` URIs — they show up as literal base64 text. Always use a `raw.githubusercontent.com` URL. Prefer a merge-commit-SHA-pinned URL (`.../logo-cdn/<sha>/src/assets/<slug>.svg`) if you want the preview frozen in time; `master` URL is fine for live previews.
- **Issue title normalization:** the webhook renames `"[Logo Request] submission"` titles to `"[<slug>] Add logo"` so downstream tooling has a consistent title.
- **Agent comment marker:** every comment the agent posts starts with `**Logo Agent**`. Use this to detect / clean up prior comments before writing new ones.

## GitHub-specific rules

- **Target repo:** `LOGO_REPO_OWNER` + `LOGO_REPO_NAME` env, base branch `LOGO_REPO_BRANCH` (default `main`). Read via `src/lib/config.ts`.
- **PR branch naming:** `logo/<slug>`, falling back to `logo/<slug>-2`, `-3`, … when the plain name is taken. Every run resolves a *free* branch name and never reuses an existing branch — that's what makes a comment rerun open a new PR instead of amending the old one. Branches are deleted right after merge, so the common case lands back on `logo/<slug>`.
- **PR preview image URL:**
  - **In the PR body** (`github.ts`) — use the base-branch URL. Feature branches get deleted on merge, so a branch URL 404s post-merge.
  - **In the Linear "merged" comment** (`process-logo.ts`) — pin to the merge commit SHA returned by `mergePR`. The branch is already deleted by then, and a SHA-pinned URL freezes the preview at what actually landed. Falls back to the base-branch URL + cache-buster if GitHub didn't return a SHA.
- **Merge strategy:** squash merges.
- **Merge strategy details:** `mergePR(prNumber, branchName)` squash-merges and deletes the branch, retrying up to 4× with a 3s gap because GitHub computes mergeability asynchronously and a just-opened PR can briefly report as unmergeable.
- **No merge gating:** every PR the agent opens is merged in the same run. Review happens after the fact via the comment-rerun loop. Don't reintroduce a "wait for Done" gate without the user asking — it was deliberately removed.

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
- **PR creation fails right after a rerun:** the regenerated SVG is probably byte-identical to what's already on the base branch, so the commit was a no-op and GitHub refuses a PR with no diff. `github.ts` deletes the throwaway branch and raises that explicitly.
- **Issue stuck in "In Review" with a "merge failed" comment:** branch protection on the CDN repo is blocking the agent's merge (a required approving review, most likely). The PR is left open for a human.
- **Vectorizer fails with "Image format not supported":** the source is probably an ICO or WebP that sharp can't convert. Covered — `vectorize.ts` catches and wraps as `ImageFetchError` so the next candidate is tried.
- **SVG source still hits vectorizer:** should not — `process-logo.ts` short-circuits `.svg` candidates. If a logo ends in `.svg` but isn't valid SVG content, it falls back to vectorizer.
- **Next.js build fails on Railway with `sharp` errors:** shouldn't, Railway's Linux runtime handles native deps. If this pops up, check the nixpacks output — a Node version mismatch is the usual cause.
