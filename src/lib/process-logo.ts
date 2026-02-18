import type { LogoRequest } from "@/types";
import { fetchFavicon } from "./fetch-favicon";
import { vectorize } from "./vectorize";
import { normalizeSvg } from "./normalize-svg";
import { commitAndCreatePR } from "./github";
import { executeTool } from "./composio";

const LINEAR_CONNECTED_ACCOUNT = "ca_32jlkHR7XaS-";
const IN_REVIEW_STATE_ID = "db21e0d5-b9b1-4861-ace9-7f2d2ebd85bb";

async function createComment(issueId: string, body: string): Promise<string | null> {
  try {
    const result = await executeTool("LINEAR_CREATE_LINEAR_COMMENT", {
      issue_id: issueId,
      body,
    }, LINEAR_CONNECTED_ACCOUNT);
    return result.data?.comment?.id || result.data?.id || null;
  } catch (err) {
    console.error(`[process-logo] Failed to create comment:`, err);
    return null;
  }
}

async function updateComment(commentId: string, body: string): Promise<void> {
  try {
    await executeTool("LINEAR_UPDATE_LINEAR_COMMENT", {
      comment_id: commentId,
      body,
    }, LINEAR_CONNECTED_ACCOUNT);
  } catch (err) {
    console.error(`[process-logo] Failed to update comment:`, err);
  }
}

export async function processLogo(request: LogoRequest): Promise<string> {
  const { slug, websiteUrl, issueIdentifier } = request;

  console.log(
    `[process-logo] Starting: slug=${slug}, url=${websiteUrl}, issue=${issueIdentifier}`
  );

  // Create initial status comment
  const commentId = await createComment(
    request.issueId,
    `**Logo Agent** processing **${slug}**\n\n⏳ Fetching favicon from ${websiteUrl}...`
  );

  try {
    // Step 1: Fetch favicon via HTTP
    console.log(`[process-logo] Step 1: Fetching favicon from ${websiteUrl}`);
    const { imageUrl } = await fetchFavicon(websiteUrl);
    console.log(`[process-logo] Favicon fetched: ${imageUrl}`);

    if (commentId) {
      await updateComment(commentId, `**Logo Agent** processing **${slug}**\n\n✅ Favicon fetched\n⏳ Vectorizing image...`);
    }

    // Step 2: Vectorize using vectorizer.ai API
    console.log(`[process-logo] Step 2: Vectorizing`);
    const { svgContent: rawSvg } = await vectorize(imageUrl);
    console.log(
      `[process-logo] Vectorized SVG received (${rawSvg.length} chars)`
    );

    if (commentId) {
      await updateComment(commentId, `**Logo Agent** processing **${slug}**\n\n✅ Favicon fetched\n✅ Vectorized to SVG\n⏳ Creating PR...`);
    }

    // Step 3: Normalize SVG to 128x128
    console.log(`[process-logo] Step 3: Normalizing SVG`);
    const normalizedSvg = normalizeSvg(rawSvg);

    // Step 4: Commit and create PR
    console.log(`[process-logo] Step 4: Creating PR on GitHub`);
    const { prUrl, branchName } = await commitAndCreatePR(
      slug,
      normalizedSvg,
      issueIdentifier
    );

    // Step 5: Update comment with success + preview
    console.log(`[process-logo] Step 5: Updating Linear issue`);
    const svgPreviewUrl = `https://raw.githubusercontent.com/ComposioHQ/logo-cdn/${branchName}/src/assets/${slug}.svg`;
    if (commentId) {
      await updateComment(
        commentId,
        `**Logo Agent** — done ✅\n\n**PR:** ${prUrl}\n\n![${slug} logo](${svgPreviewUrl})`
      );
    }

    // Step 6: Move issue to "In Review"
    try {
      await executeTool("LINEAR_UPDATE_ISSUE", {
        issueId: request.issueId,
        stateId: IN_REVIEW_STATE_ID,
      }, LINEAR_CONNECTED_ACCOUNT);
      console.log(`[process-logo] Moved issue to In Review`);
    } catch (err) {
      console.error(`[process-logo] Failed to update issue state:`, err);
    }

    console.log(`[process-logo] Done: ${prUrl}`);
    return prUrl;
  } catch (err) {
    // Update comment with error
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[process-logo] Failed for ${slug}:`, err);

    if (commentId) {
      await updateComment(
        commentId,
        `**Logo Agent** — failed ❌\n\n**Error:** ${errorMessage}`
      );
    }

    throw err;
  }
}
