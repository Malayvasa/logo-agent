#!/usr/bin/env npx tsx
//
// scripts/setup.ts — interactive first-time setup for a logo-agent fork.
//
// Walks through:
//   1. Composio CLI auth + project binding + API key paste
//   2. OAuth-link GitHub via REST (open browser, poll until ACTIVE)
//   3. Same for Linear
//   4. Linear workspace pickers (team / project / "In Review" state)
//   5. GitHub target repo, then write .env
//
// Run with: npm run setup
//
// What you still have to do after this:
//   - Sign up for vectorizer.ai and paste the API ID/secret into .env
//   - Deploy somewhere (Vercel, Railway, Fly, …)
//   - Once deployed, register the Linear webhook:
//       npx tsx scripts/setup-trigger.ts https://your-deploy-url/api/webhook

import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { randomBytes } from "crypto";

const COMPOSIO_API = "https://backend.composio.dev";

function hasComposioCli(): boolean {
  return spawnSync("composio", ["--version"], { stdio: "ignore" }).status === 0;
}

function whoamiData(): Record<string, unknown> | null {
  const r = spawnSync("composio", ["whoami"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout || "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
}

function whoamiOrg(): string | null {
  const data = whoamiData();
  if (!data) return null;
  return String(data.default_org_name || "").trim() || null;
}

function whoamiTestUserId(): string | null {
  const data = whoamiData();
  if (!data) return null;
  return String(data.test_user_id || "").trim() || null;
}

// `composio dev init` writes a directory-local config at .composio/project.json
// with the selected project's id + name. That's the canonical record of the
// dir->project binding now that global project switching is deprecated.
function readDevProject(): { name: string; id: string } | null {
  try {
    if (!existsSync(".composio/project.json")) return null;
    const data = JSON.parse(readFileSync(".composio/project.json", "utf8"));
    const name = String(data.project_name || "");
    const id = String(data.project_id || "");
    if (!name || !id) return null;
    return { name, id };
  } catch {
    return null;
  }
}

// Run `composio dev init` to bind this directory to a Composio project.
// Linking, listing, and our API key all need to point at the same project for
// setup to work end-to-end, and dev init's directory binding is now the only
// supported way to set that context.
async function devInitAndGetProject(): Promise<string | null> {
  // Fast path: dev init already ran in this directory.
  const before = readDevProject();
  if (before) {
    console.log(`  ✓ Already bound to project: ${before.name}`);
    return before.name;
  }
  console.log("\n  Running `composio dev init` to bind this directory to a project...\n");
  if (!run("composio", ["dev", "init"])) return null;
  const after = readDevProject();
  return after?.name || null;
}

function openInBrowser(url: string): boolean {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  return spawnSync(cmd, [url], { stdio: "ignore" }).status === 0;
}

const rl = createInterface({ input, output });
const ask = (q: string) => rl.question(q);

function run(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: "inherit" }).status === 0;
}

function bail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  rl.close();
  process.exit(1);
}

async function confirm(q: string, fallback = true): Promise<boolean> {
  const yn = fallback ? "Y/n" : "y/N";
  const ans = (await ask(`${q} (${yn}) `)).trim().toLowerCase();
  if (!ans) return fallback;
  return ans.startsWith("y");
}

interface ConnectedAccount {
  id: string;       // public `ca_…` id, used by the runtime SDK
  uuid: string;     // internal UUID, required by /api/v2 action endpoints
  entityId: string; // user_id / entity that owns this connection
  status: string;
  appName: string;
}

// Create a Composio-managed auth config for a toolkit via the CLI. Used as a
// fallback when REST listAuthConfigsREST returns empty — the CLI's create
// command is the easiest way to spin one up without a dashboard trip.
function createManagedAuthConfig(toolkit: string): string | null {
  const r = spawnSync(
    "composio",
    ["dev", "auth-configs", "create", "--toolkit", toolkit],
    { encoding: "utf8" }
  );
  if (r.status !== 0) return null;
  try {
    const data = JSON.parse(r.stdout || "{}");
    return String(data.auth_config?.id || "") || null;
  } catch {
    return null;
  }
}

interface RestAuthConfig { id: string; uuid: string; is_composio_managed: boolean }

async function listAuthConfigsREST(apiKey: string, toolkit: string): Promise<RestAuthConfig[]> {
  const res = await fetch(
    `${COMPOSIO_API}/api/v3/auth_configs?toolkit_slugs=${toolkit}&limit=50`,
    { headers: { "x-api-key": apiKey } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return ((data.items || []) as unknown[]).map((raw) => {
    const a = raw as Record<string, unknown>;
    return {
      id: String(a.id || ""),
      uuid: String(a.uuid || ""),
      is_composio_managed: !!a.is_composio_managed,
    };
  });
}

async function initiateConnection(
  apiKey: string,
  authConfigId: string,
  userId: string
): Promise<{ caId: string; redirectUrl: string }> {
  const res = await fetch(`${COMPOSIO_API}/api/v3/connected_accounts`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_config: { id: authConfigId },
      connection: { user_id: userId },
    }),
  });
  if (!res.ok) bail(`Failed to initiate connection: ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const caId = String(data.id || "");
  const redirectUrl = String(data.redirect_url || data.redirect_uri || "");
  if (!caId || !redirectUrl) bail(`Initiate response missing fields: ${JSON.stringify(data).slice(0, 200)}`);
  return { caId, redirectUrl };
}

// Full link flow via REST — sidesteps `composio dev connected-accounts link`,
// which has bugs around Composio-managed auth configs ("Auth config not
// found" even when the config exists and is ENABLED).
async function linkToolkitREST(
  apiKey: string,
  toolkit: string,
  userId: string
): Promise<ConnectedAccount | null> {
  // 1. Ensure an auth config exists. Try REST list first; fall back to the
  //    CLI's `auth-configs create` (which works reliably) if none.
  let configs = await listAuthConfigsREST(apiKey, toolkit);
  if (configs.length === 0) {
    console.log(`  No ${toolkit} auth config in this project — creating a Composio-managed one...`);
    const newId = createManagedAuthConfig(toolkit);
    if (!newId) {
      console.log(`  ⚠️  Couldn't create ${toolkit} auth config.`);
      return null;
    }
    configs = await listAuthConfigsREST(apiKey, toolkit);
    if (configs.length === 0) {
      console.log(`  ⚠️  ${toolkit} auth config created but not visible to API key — project mismatch?`);
      return null;
    }
  }
  const authConfig = configs[0];

  // 2. Initiate the connection — get a `ca_…` and an OAuth URL.
  const { caId, redirectUrl } = await initiateConnection(apiKey, authConfig.id, userId);
  console.log(`  Opening ${toolkit} login in your browser...`);
  openInBrowser(redirectUrl);

  // 3. Poll until ACTIVE — spinner so the wait doesn't look frozen.
  const account = await pollWithSpinner(apiKey, caId, `Waiting for ${toolkit} OAuth`);
  if (!account) {
    console.log(`  ⚠️  ${toolkit} OAuth didn't complete in time. Re-run setup once it's done.`);
    return null;
  }
  console.log(`  ✓ ${toolkit} connected`);
  return account;
}

async function pollWithSpinner(
  apiKey: string,
  caId: string,
  message: string,
  timeoutMs = 5 * 60 * 1000
): Promise<ConnectedAccount | null> {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const start = Date.now();
  const isTTY = !!process.stdout.isTTY;
  const tick = setInterval(() => {
    if (!isTTY) return;
    process.stdout.write(`\r  ${frames[i % frames.length]} ${message}...`);
    i++;
  }, 100);
  try {
    while (Date.now() - start < timeoutMs) {
      const account = await fetchAccount(apiKey, caId);
      if (account?.status === "ACTIVE") {
        if (isTTY) process.stdout.write("\r" + " ".repeat(60) + "\r");
        return account;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  } finally {
    clearInterval(tick);
    if (isTTY) process.stdout.write("\r" + " ".repeat(60) + "\r");
  }
}

async function fetchAccount(apiKey: string, caId: string): Promise<ConnectedAccount | null> {
  const res = await fetch(`${COMPOSIO_API}/api/v3/connected_accounts/${caId}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) return null;
  const a = await res.json();
  const toolkit = (a.toolkit || {}) as { slug?: string };
  const deprecated = (a.deprecated || {}) as { uuid?: string };
  return {
    id: String(a.id || ""),
    uuid: String(a.uuid || deprecated.uuid || ""),
    entityId: String(a.user_id || ""),
    status: String(a.status || ""),
    appName: String(toolkit.slug || ""),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function linearGraphQL(
  apiKey: string,
  connectedAccountUuid: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<any> {
  // Note: the v2 actions endpoint expects the internal UUID, not the `ca_…` id.
  // Response shape is { data: { data: { <graphql result> } }, successful, ... }.
  const res = await fetch(
    `${COMPOSIO_API}/api/v2/actions/LINEAR_RUN_QUERY_OR_MUTATION/execute`,
    {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        connectedAccountId: connectedAccountUuid,
        input: { query_or_mutation: query, variables },
      }),
    }
  );
  if (!res.ok) bail(`Linear query failed: HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (!body.successful && !body.successfull) {
    bail(`Linear query failed: ${body.error || JSON.stringify(body).slice(0, 300)}`);
  }
  return body.data?.data || body.data || body;
}

interface NamedThing { id: string; name: string }

async function pickFrom(items: NamedThing[], label: string): Promise<NamedThing> {
  if (items.length === 0) bail(`No ${label} found in this Linear workspace.`);
  if (items.length === 1) {
    console.log(`  ✓ ${label}: ${items[0].name}`);
    return items[0];
  }
  console.log(`\n  ${label}:`);
  items.forEach((t, i) => console.log(`    [${i + 1}] ${t.name}`));
  const idx = parseInt(
    (await ask(`  Pick one (1-${items.length}): `)).trim(),
    10
  );
  if (!Number.isFinite(idx) || idx < 1 || idx > items.length) {
    bail("Invalid selection.");
  }
  return items[idx - 1];
}

async function main() {
  console.log("\n  logo-agent setup\n  ────────────────\n");

  if (existsSync(".env")) {
    const ok = await confirm(".env already exists. Overwrite?", false);
    if (!ok) {
      console.log("Aborting — your .env is untouched.");
      rl.close();
      return;
    }
  }

  // ─── Step 1: Composio CLI auth ───────────────────────────────────────────
  console.log("Step 1/5 — Composio setup\n");
  if (!hasComposioCli()) {
    console.log("  The Composio CLI isn't installed (or isn't on your PATH).");
    console.log("  Install command: curl -fsSL https://composio.dev/install | bash\n");
    if (await confirm("  Run that now?")) {
      const ok = spawnSync("bash", ["-c", "curl -fsSL https://composio.dev/install | bash"], {
        stdio: "inherit",
      }).status === 0;
      if (!ok) bail("Composio CLI install failed.");
      if (!hasComposioCli()) {
        console.log(
          "\n  Installed, but `composio` still isn't on your PATH. The installer"
        );
        console.log(
          "  probably wrote it to ~/.composio/composio — add that to your PATH"
        );
        console.log("  (or open a new shell) and re-run `npm run setup`.");
        bail("composio not on PATH after install.");
      }
      console.log("  ✓ Composio CLI installed\n");
    } else {
      console.log("  Re-run `npm run setup` once you've installed it.");
      bail("Composio CLI required.");
    }
  }
  const data = whoamiData();
  if (!data) {
    console.log("  Not logged in. Running `composio login`...\n");
    if (!run("composio", ["login"])) bail("composio login failed.");
  } else {
    console.log(`  ✓ Logged in as ${data.email || "Composio user"}`);
  }

  // The runtime + this script's REST calls need a project-scoped API key
  // (starts with `ak_`). The CLI's stashed user key (`uak_`) is for the CLI
  // session only and won't authenticate against the REST API.
  const org = whoamiOrg();
  const composioProject = org ? await devInitAndGetProject() : null;
  const keysUrl =
    org && composioProject
      ? `https://connect.composio.dev/${org}/${composioProject}/settings/api-keys`
      : "https://connect.composio.dev/<your-org>/<your-project>/settings/api-keys";
  console.log("\n  Need a Composio project API key (starts with `ak_`).");
  console.log(`  Page: ${keysUrl}`);
  if (org && composioProject) {
    openInBrowser(keysUrl);
    console.log("  (opened in browser)");
  }
  const apiKey = (await ask("\n  Paste your Composio API key: ")).trim();
  if (!apiKey.startsWith("ak_")) {
    const hint = apiKey.startsWith("ck_")
      ? "That looks like a Composio Connect consumer key (`ck_…`), which is for client-side auth flows and can't list connected accounts. You want the project/server key (`ak_…`)."
      : apiKey.startsWith("uak_")
      ? "That looks like a CLI session key (`uak_…`). You want the project/server key (`ak_…`) from the dashboard, not the one stashed by `composio login`."
      : "That doesn't look like a project API key — it should start with `ak_`.";
    bail(hint);
  }

  // Linking via REST directly. The CLI's `composio dev connected-accounts
  // link` has bugs around Composio-managed auth configs, and `composio link`
  // (consumer flow) creates accounts in an opaque "consumer default" project
  // our API key can't see. The REST initiate endpoint accepts a project-
  // scoped auth config id and gives us a redirect URL — we open it, the user
  // OAuths, we poll until ACTIVE. Same project context throughout.

  const userId = whoamiTestUserId() || "logo-agent-user";

  // ─── Step 2: Link GitHub ─────────────────────────────────────────────────
  console.log("\nStep 2/5 — Connect GitHub\n");
  const github = await linkToolkitREST(apiKey, "github", userId);
  if (!github) bail("GitHub link failed.");

  // ─── Step 3: Link Linear ─────────────────────────────────────────────────
  console.log("\nStep 3/5 — Connect Linear\n");
  const linear = await linkToolkitREST(apiKey, "linear", userId);
  if (!linear) bail("Linear link failed.");

  // linkToolkitREST already returned ACTIVE accounts — no separate discovery step.

  // ─── Step 5: Linear workspace specifics ─────────────────────────────────
  console.log("\nStep 4/5 — Linear workspace\n");

  const teamsResp = await linearGraphQL(
    apiKey,
    linear.uuid,
    `query { teams { nodes { id name } } }`
  );
  const teams: NamedThing[] = teamsResp?.teams?.nodes || [];
  const team = await pickFrom(teams, "Which Linear team owns the logo requests?");

  const projectsResp = await linearGraphQL(
    apiKey,
    linear.uuid,
    `query($teamId: String!) {
       team(id: $teamId) { projects { nodes { id name } } }
     }`,
    { teamId: team.id }
  );
  const projects: NamedThing[] = projectsResp?.team?.projects?.nodes || [];
  const project = await pickFrom(projects, "Which project holds the logo issues?");

  const statesResp = await linearGraphQL(
    apiKey,
    linear.uuid,
    `query($teamId: String!) {
       team(id: $teamId) { states { nodes { id name } } }
     }`,
    { teamId: team.id }
  );
  const states: NamedThing[] = statesResp?.team?.states?.nodes || [];
  const inReview = await pickFrom(
    states,
    "After a PR is opened, which state should the Linear issue move to?"
  );

  // ─── Step 6: GitHub target repo ─────────────────────────────────────────
  console.log("\nStep 5/5 — GitHub target repo\n");
  const repoOwner = (await ask("  Repo owner (e.g. acme): ")).trim();
  const repoName = (await ask("  Repo name (e.g. logo-cdn): ")).trim();
  const repoBranch = (await ask("  Default branch [main]: ")).trim() || "main";

  // ─── Vectorizer.ai (optional now, required to actually run) ─────────────
  console.log("\nVectorizer.ai (paid — https://vectorizer.ai/api)");
  const vId = (await ask("  VECTORIZER_API_ID (press enter to skip): ")).trim();
  const vSecret = vId ? (await ask("  VECTORIZER_API_SECRET: ")).trim() : "";

  // ─── Secrets ────────────────────────────────────────────────────────────
  const webhookSecret = randomBytes(32).toString("hex");
  const adminKey = randomBytes(32).toString("hex");

  const env = [
    "# Generated by scripts/setup.ts",
    "",
    "# ─── Composio ─────────────────────────────────────────────────────",
    `COMPOSIO_API_KEY=${apiKey}`,
    `COMPOSIO_WEBHOOK_SECRET=${webhookSecret}`,
    "",
    "# ─── Connected accounts ──────────────────────────────────────────",
    `LINEAR_CONNECTED_ACCOUNT=${linear.id}`,
    `LINEAR_USER_ID=${linear.entityId || "default"}`,
    `GITHUB_CONNECTED_ACCOUNT=${github.id}`,
    `GITHUB_USER_ID=${github.entityId || "default"}`,
    "",
    "# ─── Target GitHub repo ──────────────────────────────────────────",
    `LOGO_REPO_OWNER=${repoOwner}`,
    `LOGO_REPO_NAME=${repoName}`,
    `LOGO_REPO_BRANCH=${repoBranch}`,
    "",
    "# ─── Linear workspace ────────────────────────────────────────────",
    `LINEAR_TEAM_ID=${team.id}`,
    `LINEAR_LOGOS_PROJECT_ID=${project.id}`,
    `LINEAR_IN_REVIEW_STATE_ID=${inReview.id}`,
    "",
    "# ─── Vectorizer.ai ───────────────────────────────────────────────",
    `VECTORIZER_API_ID=${vId}`,
    `VECTORIZER_API_SECRET=${vSecret}`,
    "",
    "# ─── Admin endpoints ─────────────────────────────────────────────",
    `ADMIN_API_KEY=${adminKey}`,
    "",
    "# Optional — only needed for Linear file-drop comment uploads.",
    "LINEAR_API_KEY=",
    "",
  ].join("\n");

  writeFileSync(".env", env);

  console.log("\n✅ Wrote .env\n");
  console.log("Next steps:");
  console.log("  1. npm run dev");
  if (!vId) {
    console.log("  2. Sign up at https://vectorizer.ai/api and fill VECTORIZER_API_ID/SECRET in .env");
  }
  console.log("  3. Deploy somewhere with a public URL (Vercel, Railway, Fly, …)");
  console.log("  4. Register the webhook against your deploy:");
  console.log("       npx tsx scripts/setup-trigger.ts https://your-deploy-url/api/webhook");
  console.log("");

  rl.close();
}

main().catch((err) => {
  console.error("\nsetup failed:", err);
  rl.close();
  process.exit(1);
});
