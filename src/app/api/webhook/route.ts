import { after, NextRequest, NextResponse } from "next/server";
import { getComposio, executeLinearTool } from "@/lib/composio";
import { processLogo } from "@/lib/process-logo";
import { handleDone } from "@/lib/handle-done";
import { isPublicHttpUrl } from "@/lib/auth";
import { linearProjectName, repoUrlFragment } from "@/lib/config";
import type { LinearIssuePayload, LogoRequest } from "@/types";

// Dedup: track slugs currently being processed to avoid duplicate runs from rapid webhook fires
const processing = new Set<string>();

// Background work runs in after() so serverless hosts keep the function alive
// past the response. One logo run (fetch, vectorize, PR, merge) fits well inside this.
export const maxDuration = 300;

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

    // Only handle issues in the configured project
    const expectedProject = linearProjectName();
    if (issueData?.project?.name !== expectedProject) {
      console.log(`[webhook] Project is "${issueData?.project?.name}", not "${expectedProject}" — skipping`);
      return NextResponse.json({
        status: "skipped",
        reason: `project is "${issueData?.project?.name}"`,
      });
    }

    const currentState = issueData?.state?.name?.toLowerCase();

    // Handle "Done" — backstop only. The pipeline auto-merges its own PR and
    // moves the issue here itself, so there's normally nothing left to merge;
    // this catches a PR whose auto-merge failed and was fixed up by hand.
    if (currentState === "done") {
      const slug = deriveSlug(issueData.title, issueData.description);

      if (processing.has(slug)) {
        console.log(`[webhook] "${slug}" is mid-run, skipping Done backstop`);
        return NextResponse.json({ status: "skipped", reason: "already processing" });
      }

      console.log(`[webhook] Issue moved to Done, checking for an unmerged PR for ${slug}`);

      after(() =>
        handleDone(issueData.id, slug).catch((err) => {
          console.error(`[webhook] handleDone failed for ${slug}:`, err);
        })
      );

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

    // The issue must name the website to pull the logo from. Guessing one (the
    // old toolkit/search fallback) could land a different company's logo on
    // the CDN, and every run auto-merges, so reject and ask instead.
    const websiteUrl = extractUrl(issueData.description || "");
    if (!websiteUrl) {
      console.log(`[webhook] No website in issue ${issueData.identifier}, rejecting`);
      after(() =>
        askForWebsite(issueData.id, slug).catch((err) => {
          console.error(`[webhook] Failed to ask for a website on ${issueData.identifier}:`, err);
        })
      );
      return NextResponse.json({ status: "rejected", reason: "no website in issue description" });
    }

    // Rename generic form submissions like "[Logo Request] submission" to "[slug] Add logo"
    if (issueData.title === "[Logo Request] submission") {
      const newTitle = `[${slug}] Add logo`;
      console.log(`[webhook] Renaming issue from "${issueData.title}" to "${newTitle}"`);
      after(() =>
        executeLinearTool("LINEAR_UPDATE_ISSUE", {
          issueId: issueData.id,
          title: newTitle,
        }).catch((err) => {
          console.error(`[webhook] Failed to rename issue:`, err);
        })
      );
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
    after(() =>
      processLogo(logoRequest)
        .catch((err) => {
          console.error(`[webhook] processLogo failed for ${slug}:`, err);
        })
        .finally(() => {
          processing.delete(slug);
        })
    );

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

  const expectedProject = linearProjectName();
  if (projectName && projectName !== expectedProject) {
    console.log(`[webhook] Comment on non-${expectedProject} project "${projectName}", skipping`);
    return NextResponse.json({ status: "skipped", reason: `not ${expectedProject} project` });
  }

  const slug = deriveSlug(issueTitle, issueDescription);
  const websiteUrl = extractUrl(issueDescription || "") || "https://unknown";

  // Dedup matters more now that every run auto-merges: a duplicate webhook
  // would otherwise land the same logo twice via two PRs.
  if (processing.has(slug)) {
    console.log(`[webhook] Slug "${slug}" already processing, skipping duplicate comment run`);
    return NextResponse.json({ status: "skipped", reason: "already processing" });
  }

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

  processing.add(slug);
  after(() =>
    processLogo(logoRequest)
      .catch((err) => {
        console.error(`[webhook] processLogo (comment) failed for ${slug}:`, err);
      })
      .finally(() => {
        processing.delete(slug);
      })
  );

  return NextResponse.json({
    status: "processing",
    slug,
    source: inlineSvg ? "inline-svg" : extracted!.source,
  });
}

function isRepoUrl(url: string): boolean {
  return url.includes(repoUrlFragment());
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

const NO_WEBSITE_COMMENT = "**Logo Agent** — needs a website ❌";

// Posts the rejection once: the webhook fires on every update (Triage, then
// Todo, ...), so skip if the issue already carries it.
async function askForWebsite(issueId: string, slug: string): Promise<void> {
  const result = await executeLinearTool("LINEAR_GET_LINEAR_ISSUE", { issue_id: issueId });
  const comments: { body?: string }[] =
    result.data?.issue?.comments?.nodes || result.data?.comments?.nodes || [];
  if (comments.some((c) => c.body?.startsWith(NO_WEBSITE_COMMENT))) return;

  await executeLinearTool("LINEAR_CREATE_LINEAR_COMMENT", {
    issue_id: issueId,
    body: `${NO_WEBSITE_COMMENT}\n\nI can't find a website in this issue, so I haven't fetched a logo for \`${slug}\`. Add the company's website to the description (e.g. \`Website: https://example.com\`) and I'll pick it up, or comment the logo image directly.`,
  });
}
