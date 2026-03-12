import { NextRequest, NextResponse } from "next/server";
import { getComposio, executeTool, getLinearConnectedAccount } from "@/lib/composio";
import { processLogo } from "@/lib/process-logo";
import { handleDone } from "@/lib/handle-done";
import type { LinearIssuePayload, LogoRequest } from "@/types";

// Dedup: track slugs currently being processed to avoid duplicate runs from rapid webhook fires
const processing = new Set<string>();

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const headers = {
      "webhook-id": request.headers.get("webhook-id") || "",
      "webhook-timestamp": request.headers.get("webhook-timestamp") || "",
      "webhook-signature": request.headers.get("webhook-signature") || "",
    };

    // Verify webhook signature
    const secret = process.env.COMPOSIO_WEBHOOK_SECRET;
    if (secret) {
      const composio = getComposio();
      const verification = await composio.triggers.verifyWebhook({
        id: headers["webhook-id"],
        payload: body,
        timestamp: headers["webhook-timestamp"],
        signature: headers["webhook-signature"],
        secret,
      });

      if (!verification.payload) {
        console.error("[webhook] Invalid webhook signature");
        return NextResponse.json(
          { error: "Invalid signature" },
          { status: 401 }
        );
      }
    }

    const payload = JSON.parse(body);
    console.log("[webhook] Received trigger:", payload.trigger?.name);
    console.log(
      "[webhook] Payload preview:",
      JSON.stringify(payload.data, null, 2).substring(0, 1000)
    );

    // Composio wraps Linear data as: { data: { action, data: { ...issueFields } } }
    // Handle both nested and flat structures
    const rawData = payload.data;
    const innerData = rawData?.data || rawData;

    // Detect comment events: comment payloads have a `body` and `issue` field
    if (innerData?.body && innerData?.issue && !innerData?.state) {
      return handleCommentEvent(innerData);
    }

    const issueData = innerData as LinearIssuePayload;

    console.log(
      "[webhook] Issue state:",
      JSON.stringify(issueData?.state),
      "| title:",
      issueData?.title,
      "| project:",
      issueData?.project?.name
    );

    // Only handle issues in the "Logos" project
    if (issueData?.project?.name !== "Logos") {
      console.log(`[webhook] Project is "${issueData?.project?.name}", not "Logos" — skipping`);
      return NextResponse.json({
        status: "skipped",
        reason: `project is "${issueData?.project?.name}"`,
      });
    }

    const currentState = issueData?.state?.name?.toLowerCase();

    // Handle "Done" — merge the PR and comment
    if (currentState === "done") {
      const slug = deriveSlug(issueData.title, issueData.description);
      console.log(`[webhook] Issue moved to Done, merging PR for ${slug}`);

      handleDone(issueData.id, slug).catch((err) => {
        console.error(`[webhook] handleDone failed for ${slug}:`, err);
      });

      return NextResponse.json({ status: "merging", slug });
    }

    // Handle "Todo" or "Triage" — start the logo pipeline
    if (currentState !== "todo" && currentState !== "triage") {
      console.log(
        `[webhook] Issue state is "${issueData?.state?.name}", not "Todo", "Triage", or "Done" — skipping`
      );
      return NextResponse.json({
        status: "skipped",
        reason: `state is "${issueData?.state?.name}"`,
      });
    }

    // Derive a slug from the issue title (or description)
    const slug = deriveSlug(issueData.title, issueData.description);

    // Extract website URL from the issue description, fall back to Composio toolkit API
    let websiteUrl = extractUrl(issueData.description || "");
    if (!websiteUrl) {
      console.log("[webhook] No URL in description, trying Composio toolkit API for slug:", slug);
      websiteUrl = await fetchToolkitUrl(slug);
    }
    if (!websiteUrl) {
      console.log("[webhook] No URL found for issue, skipping");
      return NextResponse.json({
        status: "skipped",
        reason: "no URL in description or toolkit API",
      });
    }

    // Rename generic form submissions like "[Logo Request] submission" to "[slug] Add logo"
    if (issueData.title === "[Logo Request] submission") {
      const newTitle = `[${slug}] Add logo`;
      console.log(`[webhook] Renaming issue from "${issueData.title}" to "${newTitle}"`);
      executeTool("LINEAR_UPDATE_ISSUE", {
        issueId: issueData.id,
        title: newTitle,
      }, getLinearConnectedAccount()).catch((err) => {
        console.error(`[webhook] Failed to rename issue:`, err);
      });
    }

    // Dedup: skip if this slug is already being processed
    if (processing.has(slug)) {
      console.log(`[webhook] Slug "${slug}" already processing, skipping duplicate`);
      return NextResponse.json({ status: "skipped", reason: "already processing" });
    }

    const logoRequest: LogoRequest = {
      issueId: issueData.id,
      issueIdentifier: issueData.identifier,
      slug,
      websiteUrl,
    };

    // Process asynchronously — respond immediately to avoid webhook timeout
    processing.add(slug);
    processLogo(logoRequest)
      .catch((err) => {
        console.error(`[webhook] processLogo failed for ${slug}:`, err);
      })
      .finally(() => {
        processing.delete(slug);
      });

    return NextResponse.json({ status: "processing", slug, websiteUrl });
  } catch (err) {
    console.error("[webhook] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

const IMAGE_URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(?:png|jpg|jpeg|webp|svg|ico)(?:\?[^\s]*)?/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleCommentEvent(commentData: any): Promise<NextResponse> {
  const body: string = commentData.body || "";
  const issue = commentData.issue;

  // Skip agent's own comments
  if (body.startsWith("**Logo Agent**")) {
    return NextResponse.json({ status: "skipped", reason: "agent comment" });
  }

  // Check if the comment contains an image URL
  const imageMatch = body.match(IMAGE_URL_REGEX);
  if (!imageMatch) {
    console.log("[webhook] Comment has no image URL, skipping");
    return NextResponse.json({ status: "skipped", reason: "no image URL in comment" });
  }

  const imageUrl = imageMatch[0];
  console.log(`[webhook] Comment contains image URL: ${imageUrl}`);

  // We need issue details — the comment payload may have partial issue data
  const issueId = issue?.id;
  const issueIdentifier = issue?.identifier;
  const issueTitle = issue?.title;
  const issueDescription = issue?.description;
  const projectName = issue?.project?.name;

  if (!issueId || !issueTitle) {
    console.log("[webhook] Comment missing issue details, skipping");
    return NextResponse.json({ status: "skipped", reason: "missing issue details" });
  }

  if (projectName && projectName !== "Logos") {
    console.log(`[webhook] Comment on non-Logos project "${projectName}", skipping`);
    return NextResponse.json({ status: "skipped", reason: "not Logos project" });
  }

  const slug = deriveSlug(issueTitle, issueDescription);
  const websiteUrl = extractUrl(issueDescription || "") || "https://unknown";

  console.log(`[webhook] Comment-triggered rerun for ${slug} with image: ${imageUrl}`);

  const logoRequest: LogoRequest = {
    issueId,
    issueIdentifier: issueIdentifier || slug,
    slug,
    websiteUrl,
    imageUrl,
  };

  processLogo(logoRequest).catch((err) => {
    console.error(`[webhook] processLogo (comment) failed for ${slug}:`, err);
  });

  return NextResponse.json({ status: "processing", slug, imageUrl });
}

function isRepoUrl(url: string): boolean {
  return url.includes("github.com/ComposioHQ/logo-cdn");
}

function extractUrl(text: string): string | null {
  // Strip Linear markdown link syntax: [text](<url>) → text url
  const cleaned = text.replace(/\[([^\]]*)\]\(<([^>]*)>\)/g, "$1 $2");

  // First, look for explicit "Website" pattern (with or without colon)
  const websiteMatch = cleaned.match(/Website:?\s*(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/i);
  if (websiteMatch && !isRepoUrl(websiteMatch[1])) {
    return websiteMatch[1];
  }

  // Fall back to first URL in cleaned text that isn't our repo
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  const matches = cleaned.match(urlRegex);
  if (matches) {
    const valid = matches.find((u) => !isRepoUrl(u));
    if (valid) return valid;
  }

  // Also try matching bare domains like "example.com"
  const domainRegex = /(?:^|\s)((?:[a-z0-9-]+\.)+[a-z]{2,})/gi;
  const domainMatches = cleaned.match(domainRegex);
  if (domainMatches && domainMatches.length > 0) {
    return `https://${domainMatches[0].trim()}`;
  }

  return null;
}

function deriveSlug(title: string, description?: string): string {
  // First, check for explicit "Slug:" in the description
  if (description) {
    const slugMatch = description.match(/Slug\s*:\s*(\S+)/i);
    if (slugMatch) {
      return slugMatch[1]
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "")
        .trim();
    }
  }

  // If title matches "[slug] ...", extract just the bracketed part
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

async function fetchToolkitUrl(slug: string): Promise<string | null> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return null;

  const lookupSlug = slug.replace(/^_+/, "");

  // Strategy 1: Toolkit API (meta.app_url)
  try {
    const res = await fetch(`https://backend.composio.dev/api/v3/toolkits/${lookupSlug}`, {
      headers: { "x-api-key": apiKey },
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.meta?.app_url) {
        console.log(`[webhook] Toolkit API returned app_url: ${data.meta.app_url}`);
        return data.meta.app_url;
      }
    }
  } catch (err) {
    console.log(`[webhook] Toolkit API lookup failed for ${slug}:`, err);
  }

  // Strategy 2: Search using app description via Composio Search
  console.log(`[webhook] No toolkit URL for ${slug}, trying search fallback`);
  return searchForWebsite(slug, apiKey);
}

async function searchForWebsite(slug: string, apiKey: string): Promise<string | null> {
  try {
    // Get app description
    let description = "";
    try {
      const lookupSlug = slug.replace(/^_+/, "");
      const appsRes = await fetch(`https://backend.composio.dev/api/v1/apps?limit=1000`, {
        headers: { "x-api-key": apiKey },
      });
      if (appsRes.ok) {
        const appsData = await appsRes.json();
        const app = (appsData.items || []).find((a: { key: string }) => a.key === lookupSlug);
        description = app?.description || "";
      }
    } catch { /* continue without description */ }

    const query = description
      ? `${slug} ${description.substring(0, 60)} official website`
      : `${slug} software official website`;

    console.log(`[webhook] Searching for: ${query}`);

    const res = await fetch(
      "https://backend.composio.dev/api/v2/actions/COMPOSIO_SEARCH_SEARCH/execute",
      {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          appName: "composio_search",
          entityId: "default",
          input: { query },
        }),
      }
    );

    if (!res.ok) return null;

    const data = await res.json();
    const results = data?.data?.results?.organic_results || [];

    if (results.length > 0) {
      const link = results[0].link;
      const url = new URL(link);
      const domain = url.hostname.replace(/^www\./, "");
      const websiteUrl = `https://${domain}`;
      console.log(`[webhook] Search found domain for ${slug}: ${websiteUrl}`);
      return websiteUrl;
    }

    return null;
  } catch (err) {
    console.log(`[webhook] Search failed for ${slug}:`, err);
    return null;
  }
}
