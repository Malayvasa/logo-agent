import type { LogoRequest } from "@/types";
import { fetchFavicon } from "./fetch-favicon";
import { vectorize, ImageFetchError } from "./vectorize";
import { normalizeSvg } from "./normalize-svg";
import { commitAndCreatePR, mergePRForSlug } from "./github";
import { executeLinearTool } from "./composio";
const IN_REVIEW_STATE_ID = "db21e0d5-b9b1-4861-ace9-7f2d2ebd85bb";

async function createComment(issueId: string, body: string): Promise<string | null> {
  try {
    const result = await executeLinearTool("LINEAR_CREATE_LINEAR_COMMENT", {
      issue_id: issueId,
      body,
    });
    return result.data?.comment?.id || result.data?.id || null;
  } catch (err) {
    console.error(`[process-logo] Failed to create comment:`, err);
    return null;
  }
}

async function updateComment(commentId: string, body: string): Promise<void> {
  try {
    await executeLinearTool("LINEAR_UPDATE_LINEAR_COMMENT", {
      comment_id: commentId,
      body,
    });
  } catch (err) {
    console.error(`[process-logo] Failed to update comment:`, err);
  }
}

async function deleteOldAgentComments(issueId: string): Promise<void> {
  try {
    const result = await executeLinearTool("LINEAR_GET_LINEAR_ISSUE", {
      issue_id: issueId,
    });

    const comments = result.data?.issue?.comments?.nodes
      || result.data?.comments?.nodes
      || [];

    const agentComments = comments.filter(
      (c: { body?: string }) => c.body?.startsWith("**Logo Agent**")
    );

    console.log(`[process-logo] Found ${agentComments.length} old agent comments to delete`);

    await Promise.all(agentComments.map(async (comment: { id: string }) => {
      try {
        await executeLinearTool("LINEAR_RUN_QUERY_OR_MUTATION", {
          query_or_mutation: `mutation { commentDelete(id: "${comment.id}") { success } }`,
        });
        console.log(`[process-logo] Deleted old comment: ${comment.id}`);
      } catch (err) {
        console.error(`[process-logo] Failed to delete comment ${comment.id}:`, err);
      }
    }));
  } catch (err) {
    console.error(`[process-logo] Failed to fetch old comments:`, err);
  }
}

export async function processLogo(request: LogoRequest): Promise<string> {
  const { slug, websiteUrl, issueIdentifier } = request;

  console.log(
    `[process-logo] Starting: slug=${slug}, url=${websiteUrl}, issue=${issueIdentifier}`
  );

  // Clean up old agent comments before creating new ones
  await deleteOldAgentComments(request.issueId);

  // Create initial status comment
  const commentId = await createComment(
    request.issueId,
    `**Logo Agent** processing **${slug}**\n\n⏳ Fetching favicon from ${websiteUrl}...`
  );

  try {
    // Step 1: Fetch favicon candidates
    let candidates: string[];
    if (request.imageUrl) {
      console.log(`[process-logo] Step 1: Using provided image URL: ${request.imageUrl}`);
      candidates = [request.imageUrl];
    } else {
      console.log(`[process-logo] Step 1: Fetching favicon from ${websiteUrl}`);
      const result = await fetchFavicon(websiteUrl);
      candidates = result.candidates;
    }
    console.log(`[process-logo] Got ${candidates.length} favicon candidates`);

    if (commentId) {
      await updateComment(commentId, `**Logo Agent** processing **${slug}**\n\n✅ Favicon candidates found (${candidates.length})\n⏳ Vectorizing image...`);
    }

    // Step 2: Try each candidate until one vectorizes successfully
    console.log(`[process-logo] Step 2: Vectorizing`);
    let rawSvg: string | null = null;
    let lastError: Error | null = null;

    for (const candidate of candidates) {
      try {
        console.log(`[process-logo] Trying candidate: ${candidate}`);

        // If the candidate URL points to an SVG, fetch it directly instead of vectorizing
        if (candidate.toLowerCase().endsWith(".svg")) {
          console.log(`[process-logo] Candidate is SVG, fetching directly (skipping vectorizer)`);
          const response = await fetch(candidate);
          if (!response.ok) {
            throw new ImageFetchError(`Failed to fetch SVG: ${response.status}`);
          }
          const svgContent = await response.text();
          if (svgContent.includes("<svg") && svgContent.includes("</svg>")) {
            rawSvg = svgContent;
            console.log(`[process-logo] Direct SVG fetched (${rawSvg.length} chars)`);
            break;
          } else {
            console.log(`[process-logo] URL ended in .svg but content is not valid SVG, falling back to vectorizer`);
          }
        }

        const result = await vectorize(candidate);
        rawSvg = result.svgContent;
        console.log(`[process-logo] Vectorized SVG received (${rawSvg.length} chars)`);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.log(`[process-logo] Candidate failed: ${candidate} — ${lastError.message}`);
        // Only retry on image fetch/format errors, not on vectorizer API errors
        if (!(err instanceof ImageFetchError)) {
          throw lastError;
        }
      }
    }

    if (!rawSvg) {
      throw lastError || new Error("No favicon candidates available");
    }

    if (commentId) {
      await updateComment(commentId, `**Logo Agent** processing **${slug}**\n\n✅ Favicon fetched\n✅ Vectorized to SVG\n⏳ Creating PR...`);
    }

    // Step 3: Normalize SVG to 128x128
    console.log(`[process-logo] Step 3: Normalizing SVG`);
    const normalizedSvg = normalizeSvg(rawSvg);

    // Step 4: Commit and create PR
    console.log(`[process-logo] Step 4: Creating PR on GitHub`);
    const { prUrl } = await commitAndCreatePR(
      slug,
      normalizedSvg,
      issueIdentifier
    );

    // Step 5: Merge the PR
    console.log(`[process-logo] Step 5: Merging PR`);
    await mergePRForSlug(slug);
    console.log(`[process-logo] PR merged`);

    // Step 6: Update comment with success + preview
    console.log(`[process-logo] Step 6: Updating Linear issue`);
    // Linear doesn't render data: URIs (they show as literal text), so use a
    // master-branch raw URL with a cache-bust to keep previews fresh.
    const svgPreviewUrl = `https://raw.githubusercontent.com/ComposioHQ/logo-cdn/master/src/assets/${slug}.svg?v=${Date.now()}`;
    if (commentId) {
      await updateComment(
        commentId,
        `**Logo Agent** — done ✅\n\n**Merged:** ${prUrl}\n\n![${slug} logo](${svgPreviewUrl})`
      );
    }

    // Step 6: Move issue to "In Review"
    try {
      await executeLinearTool("LINEAR_UPDATE_ISSUE", {
        issueId: request.issueId,
        stateId: IN_REVIEW_STATE_ID,
      });
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
