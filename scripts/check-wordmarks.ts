import "dotenv/config";
import { runWordmarkCheck, type WordmarkCheckArgs } from "../src/lib/wordmark-check";

// Flags logos in the CDN that contain a wordmark and posts them to Slack.
//
//   npx tsx scripts/check-wordmarks.ts                 # logos added/changed in the last 24h
//   npx tsx scripts/check-wordmarks.ts --hours 72      # ...in the last 72h
//   npx tsx scripts/check-wordmarks.ts --all           # every logo in the CDN
//   npx tsx scripts/check-wordmarks.ts --slugs a,b     # specific logos
//   add --dry-run to print results without posting to Slack
//
// The daily run happens on Vercel Cron (/api/cron/wordmarks); this is for manual runs.

function parseArgs(argv: string[]): WordmarkCheckArgs {
  const args: WordmarkCheckArgs = { hours: 24, all: false, slugs: [], dryRun: false };
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

runWordmarkCheck(parseArgs(process.argv.slice(2))).catch((err) => {
  console.error("[wordmarks] Failed:", err);
  process.exit(1);
});
