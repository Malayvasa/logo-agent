import "dotenv/config";
import { executeTool } from "../src/lib/composio";
import {
  logoApiUrl,
  repoBranch,
  repoName,
  repoOwner,
  slackAlertChannel,
  slackConnectedAccount,
  slackUserId,
} from "../src/lib/config";
import { detectWordmark, type WordmarkResult } from "../src/lib/detect-wordmark";

// Flags logos in the CDN that contain a wordmark and posts them to Slack.
//
//   npx tsx scripts/check-wordmarks.ts                 # logos added/changed in the last 24h
//   npx tsx scripts/check-wordmarks.ts --hours 72      # ...in the last 72h
//   npx tsx scripts/check-wordmarks.ts --all           # every logo in the CDN
//   npx tsx scripts/check-wordmarks.ts --slugs a,b     # specific logos
//   add --dry-run to print results without posting to Slack
//
// Runs daily as a Railway cron service and posts an overview of what was
// added, updated and flagged. Days with no logo changes post nothing.

const CONCURRENCY = 6;

interface Args {
  hours: number;
  all: boolean;
  slugs: string[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { hours: 24, all: false, slugs: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") args.all = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--hours") args.hours = Number(argv[++i]);
    else if (arg === "--slugs") args.slugs = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.hours) || args.hours <= 0) {
    throw new Error("--hours must be a positive number");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Daily mode knows how each logo changed, so it posts an overview; --all and
  // --slugs only post what got flagged.
  const changes = args.slugs.length || args.all ? null : await listChanges(args.hours);
  const slugs = args.slugs.length
    ? args.slugs
    : args.all
      ? await listAllSlugs()
      : [...changes!.added, ...changes!.updated].sort();

  const scope = args.slugs.length
    ? `${slugs.length} requested logo(s)`
    : args.all
      ? `all ${slugs.length} logos`
      : `${slugs.length} logo(s) added or changed in the last ${args.hours}h`;
  console.log(`[wordmarks] Checking ${scope}`);

  if (slugs.length === 0 && !changes?.removed.length) return;

  const { results, failures } = await classifyAll(slugs);
  const flagged = results.filter((r) => r.flagged);

  for (const r of flagged) {
    console.log(
      `[wordmarks] FLAGGED ${r.slug}: ${r.kind} (${r.confidence}) "${r.textSeen}" ratio=${r.aspectRatio} — ${r.reason}`
    );
  }
  for (const f of failures) {
    console.log(`[wordmarks] FAILED ${f.slug}: ${f.error}`);
  }
  console.log(
    `[wordmarks] Done: ${flagged.length} flagged, ${results.length - flagged.length} clean, ${failures.length} failed`
  );

  if (!changes && flagged.length === 0 && failures.length === 0) return;
  if (args.dryRun) {
    console.log("[wordmarks] --dry-run: not posting to Slack");
    if (changes) console.log(overviewText(changes, args.hours, flagged, failures));
    return;
  }
  const summary = changes
    ? overviewText(changes, args.hours, flagged, failures)
    : flaggedText(scope, flagged, failures);
  await postToSlack(summary, flagged);
}

async function classifyAll(slugs: string[]) {
  const results: WordmarkResult[] = [];
  const failures: { slug: string; error: string }[] = [];
  let next = 0;

  async function worker() {
    while (next < slugs.length) {
      const slug = slugs[next++];
      try {
        const [svg, darkSvg] = await Promise.all([fetchSvg(slug), fetchDarkSvg(slug)]);
        results.push(await detectWordmark(slug, svg, darkSvg ?? undefined));
      } catch (err) {
        failures.push({ slug, error: err instanceof Error ? err.message : String(err) });
      }
      const done = results.length + failures.length;
      if (done % 50 === 0) console.log(`[wordmarks] ${done}/${slugs.length}`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  results.sort((a, b) => a.slug.localeCompare(b.slug));
  return { results, failures };
}

async function listAllSlugs(): Promise<string[]> {
  const tree = await githubJson<{ tree: { path: string; type: string }[] }>(
    `/git/trees/${repoBranch()}?recursive=1`
  );
  const slugs = tree.tree
    .filter((item) => item.type === "blob")
    .map((item) => slugFromPath(item.path))
    .filter((slug): slug is string => slug !== null);
  return [...new Set(slugs)].sort();
}

interface Changes {
  added: string[];
  updated: string[];
  removed: string[];
}

async function listChanges(hours: number): Promise<Changes> {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  // Newest first, so the first status seen for a logo is its latest.
  const commits = await githubJson<{ sha: string }[]>(
    `/commits?sha=${repoBranch()}&path=src/assets&since=${since}&per_page=100`
  );

  const latest = new Map<string, string>();
  const addedInWindow = new Set<string>();
  for (const { sha } of commits) {
    const commit = await githubJson<{ files?: { filename: string; status: string }[] }>(
      `/commits/${sha}`
    );
    for (const file of commit.files || []) {
      const slug = slugFromPath(file.filename);
      if (!slug) continue;
      const isMainAsset = !file.filename.endsWith("-dark.svg");
      if (!latest.has(slug)) latest.set(slug, isMainAsset ? file.status : "modified");
      if (isMainAsset && file.status === "added") addedInWindow.add(slug);
    }
  }

  const changes: Changes = { added: [], updated: [], removed: [] };
  for (const [slug, status] of [...latest].sort(([a], [b]) => a.localeCompare(b))) {
    if (status === "removed") changes.removed.push(slug);
    else if (addedInWindow.has(slug)) changes.added.push(slug);
    else changes.updated.push(slug);
  }
  return changes;
}

// `<slug>-dark.svg` is the dark-theme variant of `<slug>.svg`, so it maps to
// the base slug: a change to either re-checks the logo with both renders.
function slugFromPath(path: string): string | null {
  return path.match(/^src\/assets\/([^/]+?)(?:-dark)?\.svg$/)?.[1] ?? null;
}

async function fetchSvg(slug: string): Promise<Buffer> {
  const res = await fetch(rawUrl(slug));
  if (!res.ok) throw new Error(`Fetching ${slug}.svg returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// The live CDN API owns the dark-theme rules (a `-dark` variant if one exists,
// else single-colour dark logos recoloured to white), so ask it rather than
// re-implementing them. On failure the preview falls back to the main asset.
async function fetchDarkSvg(slug: string): Promise<Buffer | null> {
  try {
    const res = await fetch(`${logoApiUrl()}/api/${encodeURIComponent(slug)}?theme=dark`);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

function rawUrl(slug: string): string {
  return `https://raw.githubusercontent.com/${repoOwner()}/${repoName()}/${repoBranch()}/src/assets/${slug}.svg`;
}

function blobUrl(slug: string): string {
  return `https://github.com/${repoOwner()}/${repoName()}/blob/${repoBranch()}/src/assets/${slug}.svg`;
}

async function githubJson<T>(path: string): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(`https://api.github.com/repos/${repoOwner()}/${repoName()}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "logo-agent-wordmarks",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} returned ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

const KIND_LABEL: Record<WordmarkResult["kind"], string> = {
  symbol: "symbol",
  monogram: "monogram",
  wordmark: "wordmark only",
  symbol_with_wordmark: "symbol + wordmark",
};

function logoLinks(slugs: string[]): string {
  return slugs.map((slug) => `[${slug}](${blobUrl(slug)})`).join(", ");
}

function flaggedSection(flagged: WordmarkResult[], failures: { slug: string; error: string }[]): string {
  const lines = [
    flagged.length
      ? `**Flagged for wordmarks (${flagged.length}):** ${logoLinks(flagged.map((r) => r.slug))}. Previews in thread.`
      : "**Flagged for wordmarks:** none.",
  ];
  if (failures.length) {
    lines.push(`**Couldn't check (${failures.length}):** ${failures.map((f) => f.slug).join(", ")}`);
  }
  return lines.join("\n");
}

function overviewText(
  changes: Changes,
  hours: number,
  flagged: WordmarkResult[],
  failures: { slug: string; error: string }[]
): string {
  const counts = [
    `${changes.added.length} added`,
    `${changes.updated.length} updated`,
    ...(changes.removed.length ? [`${changes.removed.length} removed`] : []),
  ].join(", ");
  const lines = [`**Logo CDN update:** ${counts} in the last ${hours}h.`, ""];
  if (changes.added.length) lines.push(`**Added (${changes.added.length}):** ${logoLinks(changes.added)}`);
  if (changes.updated.length) lines.push(`**Updated (${changes.updated.length}):** ${logoLinks(changes.updated)}`);
  if (changes.removed.length) lines.push(`**Removed (${changes.removed.length}):** ${changes.removed.join(", ")}`);
  lines.push("", flaggedSection(flagged, failures));
  return lines.join("\n");
}

function flaggedText(
  scope: string,
  flagged: WordmarkResult[],
  failures: { slug: string; error: string }[]
): string {
  return `**Logo wordmark check** (checked ${scope})\n\n${flaggedSection(flagged, failures)}`;
}

// The main message carries the summary; the thread under it carries one reply
// per flagged logo with its render, so the channel stays scannable.
async function postToSlack(summary: string, flagged: WordmarkResult[]) {
  const parent = await executeTool(
    "SLACK_SEND_MESSAGE",
    {
      channel: slackAlertChannel(),
      markdown_text: summary,
      unfurl_links: false,
    },
    slackConnectedAccount(),
    slackUserId()
  );
  const threadTs: string | undefined = parent.data?.ts ?? parent.data?.message?.ts;
  if (!threadTs) {
    throw new Error(`Slack message posted but no ts returned: ${JSON.stringify(parent.data).slice(0, 300)}`);
  }

  // Sequential so the thread reads in the same order as the flagged list.
  for (const r of flagged) {
    const text = r.textSeen ? ` “${r.textSeen}”` : "";
    await executeTool(
      "SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK",
      {
        channels: slackAlertChannel(),
        thread_ts: threadTs,
        file: new File([new Uint8Array(r.preview)], `${r.slug}.png`, { type: "image/png" }),
        title: r.slug,
        initial_comment: `*${r.slug}*: ${KIND_LABEL[r.kind]}${text} (${r.confidence} confidence)`,
      },
      slackConnectedAccount(),
      slackUserId()
    );
  }
  console.log(`[wordmarks] Posted to Slack (${slackAlertChannel()}) with ${flagged.length} thread image(s)`);
}

main().catch((err) => {
  console.error("[wordmarks] Failed:", err);
  process.exit(1);
});
