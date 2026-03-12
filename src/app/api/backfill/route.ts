import { NextRequest, NextResponse } from "next/server";
import { fetchFavicon } from "@/lib/fetch-favicon";
import { vectorize, ImageFetchError } from "@/lib/vectorize";
import { normalizeSvg } from "@/lib/normalize-svg";
import { commitAndCreatePR, mergePRForSlug } from "@/lib/github";

const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;
const LINEAR_CONNECTED_ACCOUNT = process.env.LINEAR_CONNECTED_ACCOUNT_ID || "1063cb72-2963-4af8-adf1-1cdfde2637b2";
const DESIGN_TEAM_ID = "48c4ab35-8398-408d-967b-881b13d7ca57";
const LOGOS_PROJECT_ID = "ceb6c22a-2b56-477e-b705-92c7a2ae8f2e";
const IN_REVIEW_STATE_ID = "db21e0d5-b9b1-4861-ace9-7f2d2ebd85bb";

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

  const lookupSlug = slug.replace(/^_+/, "");

  // Strategy 1: Toolkit API (meta.app_url)
  try {
    const res = await fetch(`https://backend.composio.dev/api/v3/toolkits/${lookupSlug}`, {
      headers: { "x-api-key": COMPOSIO_API_KEY },
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.meta?.app_url) {
        console.log(`[backfill] Toolkit API URL for ${slug}: ${data.meta.app_url}`);
        return data.meta.app_url;
      }
    }
  } catch {
    console.log(`[backfill] Toolkit API failed for ${slug}`);
  }

  // Strategy 2: Search using app description via Composio Search
  console.log(`[backfill] No toolkit URL for ${slug}, trying search fallback`);
  return searchForWebsite(slug);
}

async function getAppDescription(slug: string): Promise<string> {
  if (!COMPOSIO_API_KEY) return "";
  try {
    const lookupSlug = slug.replace(/^_+/, "");
    const res = await fetch(`https://backend.composio.dev/api/v1/apps?limit=1000`, {
      headers: { "x-api-key": COMPOSIO_API_KEY },
    });
    if (!res.ok) return "";
    const data = await res.json();
    const app = (data.items || []).find((a: { key: string }) => a.key === lookupSlug);
    return app?.description || "";
  } catch {
    return "";
  }
}

async function searchForWebsite(slug: string): Promise<string | null> {
  if (!COMPOSIO_API_KEY) return null;
  try {
    const description = await getAppDescription(slug);
    const query = description
      ? `${slug} ${description.substring(0, 60)} official website`
      : `${slug} software official website`;

    console.log(`[backfill] Searching for: ${query}`);

    const res = await fetch(
      "https://backend.composio.dev/api/v2/actions/COMPOSIO_SEARCH_SEARCH/execute",
      {
        method: "POST",
        headers: {
          "x-api-key": COMPOSIO_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          appName: "composio_search",
          entityId: "default",
          input: { query },
        }),
      }
    );

    if (!res.ok) {
      console.log(`[backfill] Search API returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    const results = data?.data?.results?.organic_results || [];

    if (results.length > 0) {
      const link = results[0].link;
      const url = new URL(link);
      const domain = url.hostname.replace(/^www\./, "");
      const websiteUrl = `https://${domain}`;
      console.log(`[backfill] Search found domain for ${slug}: ${websiteUrl}`);
      return websiteUrl;
    }

    console.log(`[backfill] Search returned no results for ${slug}`);
    return null;
  } catch (err) {
    console.log(`[backfill] Search failed for ${slug}:`, err);
    return null;
  }
}

async function createLinearIssueForReview(slug: string, prUrl: string, websiteUrl: string): Promise<void> {
  if (!COMPOSIO_API_KEY) return;

  const svgPreviewUrl = `https://raw.githubusercontent.com/ComposioHQ/logo-cdn/refs/heads/logo/${slug}/src/assets/${slug}.svg`;

  const description = [
    `#### Slug :`,
    `${slug}`,
    ``,
    `#### Website :`,
    `[${websiteUrl}](<${websiteUrl}>)`,
    ``,
    `#### Preview :`,
    `![${slug} logo](${svgPreviewUrl})`,
    ``,
    `#### PR :`,
    `[${prUrl}](<${prUrl}>)`,
    ``,
    `---`,
    `*Created by @devos-malay ⚡ via backfill*`,
  ].join("\n");

  const res = await fetch(
    "https://backend.composio.dev/api/v2/actions/LINEAR_CREATE_LINEAR_ISSUE/execute",
    {
      method: "POST",
      headers: {
        "x-api-key": COMPOSIO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        connectedAccountId: LINEAR_CONNECTED_ACCOUNT,
        input: {
          title: `[${slug}] Add logo`,
          description,
          team_id: DESIGN_TEAM_ID,
          project_id: LOGOS_PROJECT_ID,
          state_id: IN_REVIEW_STATE_ID,
        },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linear API returned ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (!data.successful && !data.successfull) {
    throw new Error(data.error || "Unknown error creating Linear issue");
  }
}

let createLinearIssues = false;

async function processOne(slug: string, autoMerge: boolean, websiteUrlOverride?: string): Promise<BackfillResult> {
  console.log(`[backfill] Processing: ${slug}`);

  try {
    // Step 1: Get website URL (use override if provided)
    const websiteUrl = websiteUrlOverride || await getWebsiteUrl(slug);
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

    // Step 7: Create Linear issue in "In Review" state with preview
    if (!autoMerge && createLinearIssues) {
      try {
        await createLinearIssueForReview(slug, prUrl, websiteUrl);
        console.log(`[backfill] Linear issue created for ${slug}`);
      } catch (err) {
        console.error(`[backfill] Failed to create Linear issue for ${slug}:`, err);
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
//   urlOverrides?: Record<string, string> — slug→websiteUrl overrides
//   autoMerge?: boolean      — auto-merge PRs after creation (default: false)
//   createIssues?: boolean   — create Linear issues in "In Review" (default: false)
//   batchSize?: number       — how many to process per batch (default: 5)
//
export async function POST(request: NextRequest) {
  try {
    const { slugs, urlOverrides = {}, autoMerge = false, createIssues = false, batchSize = 5 } = await request.json();
    createLinearIssues = createIssues;

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
          const result = await processOne(slug, autoMerge, urlOverrides[slug]);
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
