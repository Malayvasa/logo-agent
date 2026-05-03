import { NextRequest, NextResponse } from "next/server";
import { getComposio, executeLinearTool } from "@/lib/composio";
import { processLogo } from "@/lib/process-logo";
import { handleDone } from "@/lib/handle-done";
import { isPublicHttpUrl } from "@/lib/auth";
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

    // Verify webhook signature — fail closed if the secret is missing so the
    // endpoint can never be used unauthenticated.
    const secret = process.env.COMPOSIO_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[webhook] COMPOSIO_WEBHOOK_SECRET is not set; rejecting request");
      return NextResponse.json(
        { error: "Webhook not configured" },
        { status: 503 }
      );
    }

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
      executeLinearTool("LINEAR_UPDATE_ISSUE", {
        issueId: issueData.id,
        title: newTitle,
      }).catch((err) => {
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
const INLINE_SVG_REGEX = /<svg\b[\s\S]*?<\/svg>/i;
// Linear inserts file-drop attachments as ![filename.ext](url). The URL
// (uploads.linear.app/<id>/<id>/<id>) has NO extension — the file type is
// only knowable from the alt text.
const LINEAR_ATTACHMENT_REGEX = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/;
// Plain markdown link: [text](<url>) or [text](url). Used to strip the
// "<...>)" wrapping that Linear adds around bare URLs in comments.
const MARKDOWN_LINK_REGEX = /\[[^\]]*\]\(<?([^>)\s]+)>?\)/g;

interface ExtractedImage {
  url: string;
  isSvg: boolean;
  source: "linear-attachment" | "markdown-link" | "bare-url";
}

// Pull an image reference out of a Linear comment body, handling Linear's
// three observed shapes: file-drop attachments, plain markdown links, and
// bare URLs. Returns isSvg when we can prove it from alt text or pathname.
function extractCommentImage(body: string): ExtractedImage | null {
  // Form 1: Linear file-drop attachment — ![filename.ext](https://uploads.linear.app/...)
  const attachmentMatch = body.match(LINEAR_ATTACHMENT_REGEX);
  if (attachmentMatch) {
    // Linear escapes underscores in alt text (\_), strip those before checking
    const alt = attachmentMatch[1].replace(/\\_/g, "_");
    const url = attachmentMatch[2];
    if (/\.svg(\b|$)/i.test(alt)) {
      return { url, isSvg: true, source: "linear-attachment" };
    }
    if (/\.(png|jpe?g|webp|ico)(\b|$)/i.test(alt)) {
      return { url, isSvg: false, source: "linear-attachment" };
    }
    // Attachment with unknown extension — let it through as a raster, the
    // vectorizer's sharp pass will reject it cleanly if it isn't an image.
    return { url, isSvg: false, source: "linear-attachment" };
  }

  // Form 2: bare URL in the body (possibly wrapped as [url](<url>) by Linear)
  // — strip wrappers first so trailing ">)" doesn't leak into the captured URL.
  const cleaned = body.replace(MARKDOWN_LINK_REGEX, "$1 ");
  const urlMatch = cleaned.match(IMAGE_URL_REGEX);
  if (urlMatch) {
    const url = urlMatch[0];
    let isSvg = false;
    try {
      isSvg = new URL(url).pathname.toLowerCase().endsWith(".svg");
    } catch {
      isSvg = url.toLowerCase().includes(".svg");
    }
    return {
      url,
      isSvg,
      source: cleaned === body ? "bare-url" : "markdown-link",
    };
  }

  return null;
}

// Linear renders pastes through markdown — inline HTML can come through
// either as raw <svg>...</svg> or as HTML-entity-escaped (&lt;svg&gt;...).
// Try the raw form first; fall back to a decoded copy of the body.
function extractInlineSvg(body: string): string | null {
  const direct = body.match(INLINE_SVG_REGEX);
  if (direct) return direct[0];

  if (body.includes("&lt;svg")) {
    const decoded = body
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
    const match = decoded.match(INLINE_SVG_REGEX);
    if (match) return match[0];
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleCommentEvent(commentData: any): Promise<NextResponse> {
  const body: string = commentData.body || "";
  const issue = commentData.issue;

  // Skip agent's own comments
  if (body.startsWith("**Logo Agent**")) {
    return NextResponse.json({ status: "skipped", reason: "agent comment" });
  }

  // Inline SVG takes precedence over image URLs — if the user pasted SVG
  // markup directly, we trust it and skip discovery + vectorization.
  const inlineSvg = extractInlineSvg(body);
  let extracted: ExtractedImage | null = null;

  if (!inlineSvg) {
    extracted = extractCommentImage(body);
    if (!extracted) {
      console.log("[webhook] Comment has no inline SVG, attachment, or image URL, skipping");
      return NextResponse.json({ status: "skipped", reason: "no SVG or image URL in comment" });
    }

    console.log(
      `[webhook] Comment contains image (${extracted.source}, isSvg=${extracted.isSvg}): ${extracted.url}`
    );

    // SSRF guard — the comment body is attacker-controllable (anyone with comment
    // access in Linear). Refuse private/loopback/link-local destinations.
    if (!isPublicHttpUrl(extracted.url)) {
      console.warn(`[webhook] Refusing non-public image URL: ${extracted.url}`);
      return NextResponse.json(
        { status: "skipped", reason: "image URL is not a public http(s) target" }
      );
    }
  } else {
    console.log(`[webhook] Comment contains inline SVG (${inlineSvg.length} chars)`);
  }

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

  console.log(
    `[webhook] Comment-triggered rerun for ${slug} (${
      inlineSvg ? "inline SVG" : `${extracted!.source}, isSvg=${extracted!.isSvg}`
    })`
  );

  const logoRequest: LogoRequest = {
    issueId,
    issueIdentifier: issueIdentifier || slug,
    slug,
    websiteUrl,
    ...(inlineSvg
      ? { svgContent: inlineSvg }
      : { imageUrl: extracted!.url, imageUrlIsSvg: extracted!.isSvg }),
  };

  processLogo(logoRequest).catch((err) => {
    console.error(`[webhook] processLogo (comment) failed for ${slug}:`, err);
  });

  return NextResponse.json({
    status: "processing",
    slug,
    source: inlineSvg ? "inline-svg" : extracted!.source,
  });
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
