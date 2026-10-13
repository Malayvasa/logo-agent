import "dotenv/config";
import { executeTool } from "../src/lib/composio";
import {
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
// Runs daily as a Railway cron service. Clean runs post nothing.

const CONCURRENCY = 6;
const SLACK_LINES_PER_MESSAGE = 40;

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

  const slugs = args.slugs.length
    ? args.slugs
    : args.all
      ? await listAllSlugs()
      : await listChangedSlugs(args.hours);

  const scope = args.slugs.length
    ? `${slugs.length} requested logo(s)`
    : args.all
      ? `all ${slugs.length} logos`
      : `${slugs.length} logo(s) added or changed in the last ${args.hours}h`;
  console.log(`[wordmarks] Checking ${scope}`);

  if (slugs.length === 0) return;

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

  if (flagged.length === 0 && failures.length === 0) return;
  if (args.dryRun) {
    console.log("[wordmarks] --dry-run: not posting to Slack");
    return;
  }
  await postToSlack(scope, flagged, failures);
}

async function classifyAll(slugs: string[]) {
  const results: WordmarkResult[] = [];
  const failures: { slug: string; error: string }[] = [];
  let next = 0;

  async function worker() {
    while (next < slugs.length) {
      const slug = slugs[next++];
      try {
        const svg = await fetchSvg(slug);
        results.push(await detectWordmark(slug, svg));
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
  return tree.tree
    .filter((item) => item.type === "blob")
    .map((item) => slugFromPath(item.path))
    .filter((slug): slug is string => slug !== null)
    .sort();
}

async function listChangedSlugs(hours: number): Promise<string[]> {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const commits = await githubJson<{ sha: string }[]>(
    `/commits?sha=${repoBranch()}&path=src/assets&since=${since}&per_page=100`
  );

  const slugs = new Set<string>();
  for (const { sha } of commits) {
    const commit = await githubJson<{ files?: { filename: string; status: string }[] }>(
      `/commits/${sha}`
    );
    for (const file of commit.files || []) {
      const slug = slugFromPath(file.filename);
      if (slug && file.status !== "removed") slugs.add(slug);
    }
  }
  return [...slugs].sort();
}

function slugFromPath(path: string): string | null {
  return path.match(/^src\/assets\/([^/]+)\.svg$/)?.[1] ?? null;
}

async function fetchSvg(slug: string): Promise<Buffer> {
  const res = await fetch(rawUrl(slug));
  if (!res.ok) throw new Error(`Fetching SVG returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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

async function postToSlack(
  scope: string,
  flagged: WordmarkResult[],
  failures: { slug: string; error: string }[]
) {
  const lines = flagged.map((r) => {
    const text = r.textSeen ? ` “${r.textSeen}”` : "";
    return `• [${r.slug}](${blobUrl(r.slug)}): ${KIND_LABEL[r.kind]}${text} (${r.confidence} confidence)`;
  });
  if (failures.length) {
    lines.push(`Couldn't check: ${failures.map((f) => f.slug).join(", ")}`);
  }

  const header = flagged.length
    ? `**Logo wordmark check:** ${flagged.length} logo(s) contain a wordmark (checked ${scope}).`
    : `**Logo wordmark check:** no wordmarks found, but some logos couldn't be checked (${scope}).`;

  for (let i = 0; i < lines.length; i += SLACK_LINES_PER_MESSAGE) {
    const chunk = lines.slice(i, i + SLACK_LINES_PER_MESSAGE).join("\n");
    await executeTool(
      "SLACK_SEND_MESSAGE",
      {
        channel: slackAlertChannel(),
        markdown_text: i === 0 ? `${header}\n\n${chunk}` : chunk,
        unfurl_links: false,
      },
      slackConnectedAccount(),
      slackUserId()
    );
  }
  console.log(`[wordmarks] Posted to Slack (${slackAlertChannel()})`);
}

main().catch((err) => {
  console.error("[wordmarks] Failed:", err);
  process.exit(1);
});
