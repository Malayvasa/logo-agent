import type { LogoRequest } from "@/types";
import { fetchFavicon } from "./fetch-favicon";
import { vectorize, ImageFetchError } from "./vectorize";
import { normalizeSvg } from "./normalize-svg";
import { commitAndCreatePR, mergePR } from "./github";
import { executeLinearTool } from "./composio";
import { fetchWithLinearAuth } from "./linear-fetch";
import {
  linearInReviewStateId,
  linearDoneStateId,
  repoOwner,
  repoName,
  repoBranch,
} from "./config";

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
          query_or_mutation: `mutation DeleteComment($id: String!) { commentDelete(id: $id) { success } }`,
          variables: { id: comment.id },
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
  const initialStatus = request.svgContent
    ? `**Logo Agent** processing **${slug}**\n\n✅ Using SVG you provided (${request.svgContent.length} chars)\n⏳ Creating PR...`
    : `**Logo Agent** processing **${slug}**\n\n⏳ Fetching favicon from ${websiteUrl}...`;
  const commentId = await createComment(request.issueId, initialStatus);

  try {
    let rawSvg: string | null = null;

    // Fast path: user pasted SVG markup in a Linear comment. Trust it as-is —
    // skip favicon discovery and the vectorizer, and go straight to normalize.
    if (request.svgContent) {
      console.log(`[process-logo] Using inline SVG from comment (${request.svgContent.length} chars)`);
      if (!request.svgContent.includes("<svg") || !request.svgContent.includes("</svg>")) {
        throw new Error("Provided content does not look like SVG markup");
      }
      rawSvg = request.svgContent;
    } else {
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
    let lastError: Error | null = null;

    for (const candidate of candidates) {
      try {
        console.log(`[process-logo] Trying candidate: ${candidate}`);

        // If the candidate is known/inferred to be an SVG, fetch it directly
        // and skip the vectorizer. Three signals:
        //   - pathname ends in .svg (handles ".svg?query=string" too)
        //   - explicit hint from the caller (Linear file-drop attachments
        //     don't have the extension on the URL — only in the alt text)
        let isSvgUrl = request.imageUrlIsSvg === true && candidate === request.imageUrl;
        if (!isSvgUrl) {
          try {
            isSvgUrl = new URL(candidate).pathname.toLowerCase().endsWith(".svg");
          } catch {
            isSvgUrl = candidate.toLowerCase().endsWith(".svg");
          }
        }
        if (isSvgUrl) {
          console.log(`[process-logo] Candidate is SVG, fetching directly (skipping vectorizer)`);
          const response = await fetchWithLinearAuth(candidate);
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
    } // end favicon-discovery branch

    // Step 3: Normalize SVG to 128x128
    console.log(`[process-logo] Step 3: Normalizing SVG`);
    const normalizedSvg = normalizeSvg(rawSvg);

    // Step 4: Commit and create PR — always a fresh branch, so a re-run
    // triggered by a follow-up comment opens its own PR rather than amending
    // the previous one.
    console.log(`[process-logo] Step 4: Creating PR on GitHub`);
    const { prUrl, prNumber, branchName } = await commitAndCreatePR(
      slug,
      normalizedSvg,
      issueIdentifier
    );

    if (commentId) {
      await updateComment(commentId, `**Logo Agent** processing **${slug}**\n\n✅ Vectorized to SVG\n✅ PR opened: ${prUrl}\n⏳ Merging...`);
    }

    // Step 5: Auto-merge. The PR isn't a review gate anymore — corrections
    // come in as follow-up comments, each of which opens (and merges) a new PR.
    console.log(`[process-logo] Step 5: Merging PR #${prNumber}`);
    let mergeCommitSha = "";
    let mergeError: string | null = null;
    try {
      mergeCommitSha = await mergePR(prNumber, branchName);
    } catch (err) {
      mergeError = err instanceof Error ? err.message : String(err);
      console.error(`[process-logo] Auto-merge failed for ${slug}:`, err);
    }

    // Step 6: Comment the result. Post-merge the branch is gone, so pin the
    // preview to the merge commit (falls back to the base branch when GitHub
    // didn't hand back a SHA).
    console.log(`[process-logo] Step 6: Updating Linear issue`);
    const previewRef = mergeCommitSha || repoBranch();
    const cacheBust = mergeCommitSha ? "" : `?v=${Date.now()}`;
    const svgPreviewUrl = `https://raw.githubusercontent.com/${repoOwner()}/${repoName()}/${previewRef}/src/assets/${slug}.svg${cacheBust}`;

    if (commentId) {
      await updateComment(
        commentId,
        mergeError
          ? `**Logo Agent** — PR open, merge failed ❌\n\n**PR:** ${prUrl}\n\n**Error:** ${mergeError}\n\nMerge the PR manually, or comment a replacement image here to open a new one.`
          : `**Logo Agent** — merged ✅\n\n**PR:** ${prUrl}\n\n![${slug} logo](${svgPreviewUrl})\n\nThe \`${slug}\` logo is live in the CDN. Not right? Comment a replacement image on this issue and the agent will open a new PR.`
      );
    }

    // Step 7: Move the issue on — Done once merged (if a Done state is
    // configured), otherwise leave it in In Review for a human to pick up.
    // Kept inside its own try: a missing state ID must not fail the run — the
    // logo has already landed by this point.
    try {
      const doneStateId = linearDoneStateId();
      const merged = !mergeError && !!doneStateId;
      await executeLinearTool("LINEAR_UPDATE_ISSUE", {
        issueId: request.issueId,
        stateId: merged ? doneStateId : linearInReviewStateId(),
      });
      console.log(`[process-logo] Moved issue to ${merged ? "Done" : "In Review"}`);
    } catch (err) {
      console.error(`[process-logo] Failed to update issue state:`, err);
    }

    console.log(
      mergeError
        ? `[process-logo] PR left open (merge failed): ${prUrl}`
        : `[process-logo] PR merged: ${prUrl}`
    );
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
