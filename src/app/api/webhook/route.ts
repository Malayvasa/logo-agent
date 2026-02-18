import { NextRequest, NextResponse } from "next/server";
import { getComposio } from "@/lib/composio";
import { processLogo } from "@/lib/process-logo";
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
      JSON.stringify(payload.data, null, 2).substring(0, 500)
    );

    // Extract the Linear issue data from the trigger payload
    const issueData = payload.data as LinearIssuePayload;

    // Only process when issue is moved to "Todo" status
    const currentState = issueData?.state?.name;
    if (!currentState || currentState.toLowerCase() !== "todo") {
      console.log(
        `[webhook] Issue state is "${currentState}", not "Todo" — skipping`
      );
      return NextResponse.json({
        status: "skipped",
        reason: `state is "${currentState}", waiting for "Todo"`,
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

    // Derive a slug from the issue title
    const slug = deriveSlug(issueData.title);

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

function extractUrl(text: string): string | null {
  // Match URLs in the text
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  const matches = text.match(urlRegex);
  if (matches && matches.length > 0) {
    return matches[0];
  }

  // Also try matching bare domains like "example.com"
  const domainRegex = /(?:^|\s)((?:[a-z0-9-]+\.)+[a-z]{2,})/gi;
  const domainMatches = text.match(domainRegex);
  if (domainMatches && domainMatches.length > 0) {
    return `https://${domainMatches[0].trim()}`;
  }

  return null;
}

function deriveSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "_");
}
