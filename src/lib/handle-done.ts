import { mergePRForSlug } from "./github";
import { executeTool } from "./composio";

const LINEAR_CONNECTED_ACCOUNT = "ca_32jlkHR7XaS-";

export async function handleDone(issueId: string, slug: string): Promise<void> {
  try {
    const prUrl = await mergePRForSlug(slug);
    console.log(`[handle-done] Merged PR for ${slug}: ${prUrl}`);

    await executeTool("LINEAR_CREATE_LINEAR_COMMENT", {
      issue_id: issueId,
      body: `**Logo Agent** — merged ✅\n\nPR merged: ${prUrl}\n\nThe \`${slug}\` logo is now live in the CDN.`,
    }, LINEAR_CONNECTED_ACCOUNT);
    console.log(`[handle-done] Comment added to issue`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[handle-done] Failed for ${slug}:`, err);

    await executeTool("LINEAR_CREATE_LINEAR_COMMENT", {
      issue_id: issueId,
      body: `**Logo Agent** — merge failed ❌\n\n**Error:** ${errorMessage}`,
    }, LINEAR_CONNECTED_ACCOUNT).catch(() => {});
  }
}
