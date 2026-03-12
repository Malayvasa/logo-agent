import { NextRequest, NextResponse } from "next/server";
import { fetchFavicon } from "@/lib/fetch-favicon";
import { vectorize, ImageFetchError } from "@/lib/vectorize";
import { normalizeSvg } from "@/lib/normalize-svg";
import { commitAndCreatePR } from "@/lib/github";

const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;

// Track active backfill to prevent duplicates
let activeBackfill: { total: number; processed: number; results: BackfillResult[] } | null = null;

interface BackfillResult {
  slug: string;
  status: "success" | "failed" | "skipped";
  prUrl?: string;
  error?: string;
}

async function getWebsiteUrl(slug: string): Promise<string | null> {
  if (!COMPOSIO_API_KEY) return null;
  try {
    const lookupSlug = slug.replace(/^_+/, "");
    const res = await fetch(`https://backend.composio.dev/api/v3/toolkits/${lookupSlug}`, {
      headers: { "x-api-key": COMPOSIO_API_KEY },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.meta?.app_url || null;
  } catch {
    return null;
  }
}

async function processOne(slug: string): Promise<BackfillResult> {
  console.log(`[backfill] Processing: ${slug}`);

  try {
    // Step 1: Get website URL
    const websiteUrl = await getWebsiteUrl(slug);
    if (!websiteUrl) {
      console.log(`[backfill] No website URL for ${slug}, skipping`);
      return { slug, status: "skipped", error: "No website URL found" };
    }

    // Step 2: Fetch favicon candidates
    let candidates: string[];
    console.log(`[backfill] Fetching favicon from ${websiteUrl}`);
    const result = await fetchFavicon(websiteUrl);
    candidates = result.candidates;

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

    // Step 5: Create PR (no auto-merge)
    const { prUrl } = await commitAndCreatePR(slug, normalizedSvg, "backfill");
    console.log(`[backfill] PR created for ${slug}: ${prUrl}`);

    return { slug, status: "success", prUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[backfill] Failed for ${slug}: ${msg}`);
    return { slug, status: "failed", error: msg };
  }
}

// POST /api/backfill — start processing
export async function POST(request: NextRequest) {
  try {
    const { slugs, batchSize = 5 } = await request.json();

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
    activeBackfill = { total: slugs.length, processed: 0, results: [] };

    // Process in batches (don't await — respond immediately)
    const processBatches = async () => {
      for (let i = 0; i < slugs.length; i += batchSize) {
        const batch = slugs.slice(i, i + batchSize);

        // Process batch sequentially to be kind to APIs
        for (const slug of batch) {
          const result = await processOne(slug);
          activeBackfill!.results.push(result);
          activeBackfill!.processed++;
        }

        console.log(`[backfill] Progress: ${activeBackfill!.processed}/${activeBackfill!.total}`);

        // Small delay between batches to avoid rate limits
        if (i + batchSize < slugs.length) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      console.log(`[backfill] Complete! ${activeBackfill!.results.filter(r => r.status === 'success').length} succeeded`);
    };

    processBatches().catch((err) => {
      console.error(`[backfill] Fatal error:`, err);
    });

    return NextResponse.json({
      status: "started",
      total: slugs.length,
      message: `Processing ${slugs.length} logos. Check GET /api/backfill for progress.`,
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
  const done = activeBackfill.processed >= activeBackfill.total;

  return NextResponse.json({
    status: done ? "complete" : "processing",
    total: activeBackfill.total,
    processed: activeBackfill.processed,
    success,
    failed,
    skipped,
    results: activeBackfill.results,
  });
}
