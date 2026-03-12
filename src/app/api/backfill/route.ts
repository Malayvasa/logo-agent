import { NextRequest, NextResponse } from "next/server";
import { fetchFavicon } from "@/lib/fetch-favicon";
import { vectorize, ImageFetchError } from "@/lib/vectorize";
import { normalizeSvg } from "@/lib/normalize-svg";
import { commitAndCreatePR, mergePRForSlug } from "@/lib/github";

const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;

// Track active backfill to prevent duplicates
let activeBackfill: {
  total: number;
  processed: number;
  autoMerge: boolean;
  results: BackfillResult[];
} | null = null;

interface BackfillResult {
  slug: string;
  status: "success" | "failed" | "skipped";
  prUrl?: string;
  merged?: boolean;
  error?: string;
}

async function getWebsiteUrl(slug: string): Promise<string | null> {
  if (!COMPOSIO_API_KEY) return null;
  try {
    const lookupSlug = slug.replace(/^_+/, "");
    const res = await fetch(`https://backend.composio.dev/api/v3/toolkits/${lookupSlug}`, {
      headers: { "x-api-key": COMPOSIO_API_KEY },
    });
    if (!res.ok) return guessWebsiteUrl(slug);
    const data = await res.json();
    return data?.meta?.app_url || guessWebsiteUrl(slug);
  } catch {
    return guessWebsiteUrl(slug);
  }
}

function guessWebsiteUrl(slug: string): string {
  // Strip common suffixes and clean up the slug to guess a domain
  const clean = slug
    .replace(/_mcp$/, "")
    .replace(/_oauth$/, "")
    .replace(/_api$/, "")
    .replace(/_/g, "");
  return `https://${clean}.com`;
}

async function processOne(slug: string, autoMerge: boolean): Promise<BackfillResult> {
  console.log(`[backfill] Processing: ${slug}`);

  try {
    // Step 1: Get website URL
    const websiteUrl = await getWebsiteUrl(slug);
    if (!websiteUrl) {
      console.log(`[backfill] No website URL for ${slug}, skipping`);
      return { slug, status: "skipped", error: "No website URL found" };
    }

    // Step 2: Fetch favicon candidates
    console.log(`[backfill] Fetching favicon from ${websiteUrl}`);
    const result = await fetchFavicon(websiteUrl);
    const candidates = result.candidates;

    if (candidates.length === 0) {
      return { slug, status: "skipped", error: "No favicon candidates found" };
    }

    // Step 3: Vectorize — try each candidate
    let rawSvg: string | null = null;
    let lastError: Error | null = null;

    for (const candidate of candidates) {
      try {
        console.log(`[backfill] Trying candidate: ${candidate}`);
        const vResult = await vectorize(candidate);
        rawSvg = vResult.svgContent;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!(err instanceof ImageFetchError)) throw lastError;
      }
    }

    if (!rawSvg) {
      throw lastError || new Error("All favicon candidates failed");
    }

    // Step 4: Normalize to 128x128
    const normalizedSvg = normalizeSvg(rawSvg);

    // Step 5: Create PR
    const { prUrl } = await commitAndCreatePR(slug, normalizedSvg, "backfill");
    console.log(`[backfill] PR created for ${slug}: ${prUrl}`);

    // Step 6: Auto-merge if enabled
    let merged = false;
    if (autoMerge) {
      try {
        await mergePRForSlug(slug);
        merged = true;
        console.log(`[backfill] Auto-merged PR for ${slug}`);
      } catch (err) {
        console.error(`[backfill] Auto-merge failed for ${slug}:`, err);
      }
    }

    return { slug, status: "success", prUrl, merged };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[backfill] Failed for ${slug}: ${msg}`);
    return { slug, status: "failed", error: msg };
  }
}

// POST /api/backfill — start processing
//
// Body:
//   slugs: string[]          — list of slugs to process (required)
//   autoMerge?: boolean      — auto-merge PRs after creation (default: false)
//   batchSize?: number       — how many to process per batch (default: 5)
//
export async function POST(request: NextRequest) {
  try {
    const { slugs, autoMerge = false, batchSize = 5 } = await request.json();

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return NextResponse.json({ error: "slugs must be a non-empty array" }, { status: 400 });
    }

    if (activeBackfill && activeBackfill.processed < activeBackfill.total) {
      return NextResponse.json({
        error: "Backfill already in progress",
        progress: {
          total: activeBackfill.total,
          processed: activeBackfill.processed,
        },
      }, { status: 409 });
    }

    // Initialize tracking
    activeBackfill = { total: slugs.length, processed: 0, autoMerge, results: [] };

    // Process in batches (don't await — respond immediately)
    const processBatches = async () => {
      for (let i = 0; i < slugs.length; i += batchSize) {
        const batch = slugs.slice(i, i + batchSize);

        // Process batch sequentially to be kind to APIs
        for (const slug of batch) {
          const result = await processOne(slug, autoMerge);
          activeBackfill!.results.push(result);
          activeBackfill!.processed++;
        }

        console.log(`[backfill] Progress: ${activeBackfill!.processed}/${activeBackfill!.total}`);

        // Small delay between batches to avoid rate limits
        if (i + batchSize < slugs.length) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      const succeeded = activeBackfill!.results.filter(r => r.status === 'success').length;
      const mergedCount = activeBackfill!.results.filter(r => r.merged).length;
      console.log(`[backfill] Complete! ${succeeded} succeeded, ${mergedCount} merged`);
    };

    processBatches().catch((err) => {
      console.error(`[backfill] Fatal error:`, err);
    });

    return NextResponse.json({
      status: "started",
      total: slugs.length,
      autoMerge,
      message: `Processing ${slugs.length} logos${autoMerge ? ' (auto-merge ON)' : ' (PRs only)'}. Check GET /api/backfill for progress.`,
    });
  } catch (err) {
    console.error("[backfill] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET /api/backfill — check progress
export async function GET() {
  if (!activeBackfill) {
    return NextResponse.json({ status: "idle", message: "No backfill in progress" });
  }

  const success = activeBackfill.results.filter((r) => r.status === "success").length;
  const failed = activeBackfill.results.filter((r) => r.status === "failed").length;
  const skipped = activeBackfill.results.filter((r) => r.status === "skipped").length;
  const merged = activeBackfill.results.filter((r) => r.merged).length;
  const done = activeBackfill.processed >= activeBackfill.total;

  return NextResponse.json({
    status: done ? "complete" : "processing",
    total: activeBackfill.total,
    processed: activeBackfill.processed,
    autoMerge: activeBackfill.autoMerge,
    success,
    failed,
    skipped,
    merged,
    results: activeBackfill.results,
  });
}
