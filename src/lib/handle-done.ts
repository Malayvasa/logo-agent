import { mergePRForSlug } from "./github";
import { executeLinearTool } from "./composio";

/**
 * Backstop for the Done transition. The pipeline auto-merges its own PR and
 * moves the issue to Done itself, so this normally finds nothing. It exists to
 * catch a PR whose auto-merge failed and that a human then approved by moving
 * the issue to Done.
 */
export async function handleDone(issueId: string, slug: string): Promise<void> {
  try {
    const prUrl = await mergePRForSlug(slug);

    if (!prUrl) {
      console.log(`[handle-done] No open PR for ${slug}, nothing to merge`);
      return;
    }

    console.log(`[handle-done] Merged PR for ${slug}: ${prUrl}`);

    await executeLinearTool("LINEAR_CREATE_LINEAR_COMMENT", {
      issue_id: issueId,
      body: `**Logo Agent** — merged ✅\n\nPR merged: ${prUrl}\n\nThe \`${slug}\` logo is now live in the CDN.`,
    });
    console.log(`[handle-done] Comment added to issue`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[handle-done] Failed for ${slug}:`, err);

    await executeLinearTool("LINEAR_CREATE_LINEAR_COMMENT", {
      issue_id: issueId,
      body: `**Logo Agent** — merge failed ❌\n\n**Error:** ${errorMessage}`,
    }).catch(() => {});
  }
}
