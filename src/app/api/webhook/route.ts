import { NextRequest, NextResponse } from "next/server";
import { getComposio } from "@/lib/composio";
import { processLogo } from "@/lib/process-logo";
import { handleDone } from "@/lib/handle-done";
import type { LinearIssuePayload, LogoRequest } from "@/types";

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
    const issueData = (rawData?.data || rawData) as LinearIssuePayload;

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

    // Handle "Todo" — start the logo pipeline
    if (currentState !== "todo") {
      console.log(
        `[webhook] Issue state is "${issueData?.state?.name}", not "Todo" or "Done" — skipping`
      );
      return NextResponse.json({
        status: "skipped",
        reason: `state is "${issueData?.state?.name}"`,
      });
    }

    if (!issueData?.description) {
      console.log("[webhook] No description in issue, skipping");
      return NextResponse.json({ status: "skipped", reason: "no description" });
    }

    // Extract website URL from the issue description
    const websiteUrl = extractUrl(issueData.description);
    if (!websiteUrl) {
      console.log("[webhook] No URL found in issue description, skipping");
      return NextResponse.json({
        status: "skipped",
        reason: "no URL in description",
      });
    }

    // Derive a slug from the issue title (or description)
    const slug = deriveSlug(issueData.title, issueData.description);

    const logoRequest: LogoRequest = {
      issueId: issueData.id,
      issueIdentifier: issueData.identifier,
      slug,
      websiteUrl,
    };

    // Process asynchronously — respond immediately to avoid webhook timeout
    processLogo(logoRequest).catch((err) => {
      console.error(`[webhook] processLogo failed for ${slug}:`, err);
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
    const slugMatch = description.match(/Slug:\s*(\S+)/i);
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
