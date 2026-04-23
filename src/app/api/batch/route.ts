import { NextResponse } from "next/server";
import { executeLinearTool } from "@/lib/composio";
import { processLogo } from "@/lib/process-logo";
import type { LogoRequest } from "@/types";
const LOGOS_PROJECT_ID = "ceb6c22a-2b56-477e-b705-92c7a2ae8f2e";
const TRIAGE_STATE_NAME = "Triage";

function deriveSlug(title: string, description?: string): string {
  // First, check for explicit "Slug:" in the description
  if (description) {
    const slugMatch = description.match(/Slug:\s*(\S+)/i);
    if (slugMatch) {
      return slugMatch[1]
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "")
        .trim();
    }
  }

  const bracketMatch = title.match(/^\[([^\]]+)\]/);
  if (bracketMatch) {
    return bracketMatch[1]
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .trim();
  }
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "_");
}

function isRepoUrl(url: string): boolean {
  return url.includes("github.com/ComposioHQ/logo-cdn");
}

function extractUrl(text: string): string | null {
  const cleaned = text.replace(/\[([^\]]*)\]\(<([^>]*)>\)/g, "$1 $2");
  const websiteMatch = cleaned.match(/Website:?\s*(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/i);
  if (websiteMatch && !isRepoUrl(websiteMatch[1])) return websiteMatch[1];
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  const matches = cleaned.match(urlRegex);
  if (matches) {
    const valid = matches.find((u) => !isRepoUrl(u));
    if (valid) return valid;
  }
  return null;
}

// Track running batch to prevent concurrent runs
let batchRunning = false;

export async function POST() {
  if (batchRunning) {
    return NextResponse.json({ error: "Batch already running" }, { status: 409 });
  }

  batchRunning = true;

  try {
    // Fetch all issues in Logos project
    console.log("[batch] Fetching Logos project issues...");
    const result = await executeLinearTool("LINEAR_LIST_LINEAR_ISSUES", {
      project_id: LOGOS_PROJECT_ID,
      first: 250,
    });

    const issues = result.data?.issues || [];
    const triageIssues = issues.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (issue: any) => issue.state?.name === TRIAGE_STATE_NAME
    );

    console.log(`[batch] Found ${triageIssues.length} Triage issues out of ${issues.length} total`);

    if (triageIssues.length === 0) {
      batchRunning = false;
      return NextResponse.json({ status: "done", message: "No Triage issues found" });
    }

    // Respond immediately, process in background
    const total = triageIssues.length;

    // Process sequentially in background
    (async () => {
      let succeeded = 0;
      let failed = 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const issue of triageIssues) {
        const slug = deriveSlug(issue.title, issue.description);
        const websiteUrl = extractUrl(issue.description || "");

        if (!websiteUrl) {
          console.log(`[batch] Skipping ${issue.identifier} (${slug}): no URL in description`);
          failed++;
          continue;
        }

        const logoRequest: LogoRequest = {
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          slug,
          websiteUrl,
        };

        try {
          console.log(`[batch] Processing ${succeeded + failed + 1}/${total}: ${issue.identifier} (${slug})`);
          await processLogo(logoRequest);
          succeeded++;
          console.log(`[batch] Done ${issue.identifier} (${succeeded} succeeded, ${failed} failed)`);
        } catch (err) {
          failed++;
          console.error(`[batch] Failed ${issue.identifier} (${slug}):`, err);
        }
      }

      console.log(`[batch] Complete: ${succeeded} succeeded, ${failed} failed out of ${total}`);
      batchRunning = false;
    })();

    return NextResponse.json({
      status: "started",
      total,
      message: `Processing ${total} Triage issues sequentially. Check Railway logs for progress.`,
    });
  } catch (err) {
    batchRunning = false;
    console.error("[batch] Error:", err);
    return NextResponse.json({ error: "Failed to start batch" }, { status: 500 });
  }
}
