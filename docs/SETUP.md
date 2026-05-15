# Setup

The fast path is `npm run setup` — interactive, opens the right Composio pages in your browser, walks you through OAuth, and writes a complete `.env`. This doc is the manual fallback (and explains what each environment variable actually does).

## Prereqs

You'll need accounts for four services. None have free fallbacks in this codebase.

| Service | Why | Cost |
| --- | --- | --- |
| [Composio](https://composio.dev) | Linear webhook + Linear + GitHub auth | Free tier |
| Linear workspace | Where logo requests live | Free for small teams |
| A GitHub repo you can write to | The target your PRs land on | Free |
| [Vectorizer.ai](https://vectorizer.ai/api) | Raster → SVG | Pay-as-you-go (cheap) |

## Quick path (`npm run setup`)

```bash
curl -fsSL https://composio.dev/install | bash   # one-time

git clone https://github.com/Malayvasa/logo-agent && cd logo-agent
npm install
npm run setup
```

The setup script:

1. Checks the Composio CLI is installed (offers to install if not)
2. Binds the directory to a Composio project via `composio dev init`
3. Opens the project's API key page in your browser
4. OAuths GitHub + Linear via Composio's REST flow (polls until ACTIVE)
5. Lets you pick a Linear team, project, and "In Review" state from your real workspace
6. Asks for the GitHub target repo
7. Generates webhook + admin secrets
8. Writes `.env`

After that, register the webhook against your deploy:

```bash
npx tsx scripts/setup-trigger.ts https://your-deploy-url/api/webhook
```

## Manual path

If `npm run setup` doesn't fit your environment, do it by hand:

1. **Composio API key.** At `https://connect.composio.dev/<your-org>/<your-project>/settings/api-keys`, generate a project-scoped key (starts with `ak_`). Set `COMPOSIO_API_KEY`.

2. **Connect Linear in Composio.** Add a Linear connection in the Composio dashboard. After it's ACTIVE, grab the `ca_…` id and the entity (userId) it was created under. Set `LINEAR_CONNECTED_ACCOUNT` and `LINEAR_USER_ID`.

3. **Connect GitHub in Composio.** Same flow. Set `GITHUB_CONNECTED_ACCOUNT` (and `GITHUB_USER_ID` if your entity isn't `default`).

4. **Target repo.** Set `LOGO_REPO_OWNER`, `LOGO_REPO_NAME`, and `LOGO_REPO_BRANCH` (defaults to `main`). PRs land at `src/assets/<slug>.svg`; adjust [`commitAndCreatePR`](../src/lib/github.ts) if your repo uses a different layout.

5. **Linear workspace IDs.** Three of them:
   - `LINEAR_TEAM_ID` — the team that owns the logo project
   - `LINEAR_LOGOS_PROJECT_ID` — the project the agent watches
   - `LINEAR_IN_REVIEW_STATE_ID` — the workflow state issues move to once the PR is open

   Easiest way to fetch these: Linear's GraphQL API at <https://linear.app/developers/graphql>. Run `query { teams { nodes { id name } } }`, then `team(id: …) { projects { nodes { id name } } states { nodes { id name } } }`.

   Optional: `LINEAR_PROJECT_NAME` (default `Logos`) and `LINEAR_TRIAGE_STATE_NAME` (default `Triage`).

6. **Vectorizer.ai.** Get an API token at <https://vectorizer.ai/api>. Set `VECTORIZER_API_ID` and `VECTORIZER_API_SECRET`.

7. **Local secrets.**
   - `COMPOSIO_WEBHOOK_SECRET` — random string. Webhook fails closed if unset.
   - `ADMIN_API_KEY` — random string. Gates `/api/batch` and `/api/backfill`.
   - `LINEAR_API_KEY` *(optional)* — a personal Linear key (`lin_api_…`), only needed if you want designers to drop image files into Linear comments. Linear gates `uploads.linear.app` behind the same auth as its GraphQL API. Generate at `https://linear.app/<workspace>/settings/account/security`.

8. **Register the webhook.** From a deployed URL (or `ngrok` tunnel for local dev):

   ```bash
   npx tsx scripts/setup-trigger.ts https://your-deploy-url/api/webhook
   ```

   Registers Composio's `LINEAR_ISSUE_UPDATED_TRIGGER` with HMAC signing.

## Admin endpoints

`/api/batch` and `/api/backfill` are gated by `Authorization: Bearer $ADMIN_API_KEY`.

**Sweep every `Triage`-state issue in the configured Linear project:**

```bash
curl -X POST http://localhost:3000/api/batch \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

**Seed logos for a known list of slugs without going through Linear:**

```bash
curl -X POST http://localhost:3000/api/backfill \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"slugs":["stripe","linear","github"],"autoMerge":true}'
```

`autoMerge: true` skips the human-review step for backfill — intended for seeding a fresh CDN.

## Deploying

Any Node-hosting platform that runs Next.js works (Vercel, Railway, Fly, Render). Beyond the env vars above, the only runtime requirement is `sharp`, which ships native binaries for Linux x64 / arm64.

The reference deploy runs on Railway with `railway up --service logo-agent --ci` from a clean `main` checkout. See [CLAUDE.md](../CLAUDE.md) for the maintainer's full runbook — your story will be different.

## Troubleshooting

- **"ConnectedAccountEntityIdMismatch" on Linear calls.** You're calling `executeTool` on a `LINEAR_*` slug instead of `executeLinearTool`. The wrappers in [`src/lib/composio.ts`](../src/lib/composio.ts) pre-bind the right userId per toolkit.
- **Linear comment renders as `data:image/svg+xml;base64,…` text.** Linear doesn't render data URIs in comments. Use a `raw.githubusercontent.com` URL.
- **PR preview image 404s after merge.** The PR body should point at the base branch, not the feature branch (which gets deleted on merge). Should already be the case via `repoBranch()` in [`github.ts`](../src/lib/github.ts).
- **Webhook fires twice for the same slug.** [`webhook/route.ts`](../src/app/api/webhook/route.ts) has a `processing` Set for dedup. Reuse it rather than adding a new one.
- **Vectorizer fails with "Image format not supported".** The source is probably an ICO or WebP that `sharp` can't convert. Handled — `vectorize.ts` catches this and tries the next candidate.
