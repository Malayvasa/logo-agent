import { mergePRForSlug } from "./github";
import { executeTool, getLinearConnectedAccount } from "./composio";

export async function handleDone(issueId: string, slug: string): Promise<void> {
  try {
    const prUrl = await mergePRForSlug(slug);

    if (!prUrl) {
      console.log(`[handle-done] No open PR for ${slug}, nothing to merge`);
      return;
    }

    console.log(`[handle-done] Merged PR for ${slug}: ${prUrl}`);

    await executeTool("LINEAR_CREATE_LINEAR_COMMENT", {
      issue_id: issueId,
      body: `**Logo Agent** — merged ✅\n\nPR merged: ${prUrl}\n\nThe \`${slug}\` logo is now live in the CDN.`,
    }, getLinearConnectedAccount());
    console.log(`[handle-done] Comment added to issue`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[handle-done] Failed for ${slug}:`, err);

    await executeTool("LINEAR_CREATE_LINEAR_COMMENT", {
      issue_id: issueId,
      body: `**Logo Agent** — merge failed ❌\n\n**Error:** ${errorMessage}`,
    }, getLinearConnectedAccount()).catch(() => {});
  }
}
