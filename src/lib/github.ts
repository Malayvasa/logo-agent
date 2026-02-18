import { executeTool } from "./composio";

const REPO_OWNER = "ComposioHQ";
const REPO_NAME = "logo-cdn";
const BASE_BRANCH = "master";
const GITHUB_CONNECTED_ACCOUNT = "ca__R-5hPXL6NFQ";

interface PrResult {
  prUrl: string;
  branchName: string;
}

export async function commitAndCreatePR(
  slug: string,
  svgContent: string,
  issueIdentifier: string
): Promise<PrResult> {
  const branchName = `logo/${slug}`;
  const filePath = `src/assets/${slug}.svg`;
  const commitMessage = `feat: add ${slug} logo`;
  const prTitle = `Add ${slug} logo`;
  const rawSvgUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${branchName}/${filePath}`;
  const prBody = [
    `Adds the ${slug} logo SVG to the asset library.`,
    ``,
    `## Preview`,
    `![${slug} logo](${rawSvgUrl})`,
    ``,
    `Resolves ${issueIdentifier}`,
    ``,
    `Generated automatically by logo-agent.`,
  ].join("\n");

  // Step 1: Get the base branch SHA
  const branchResult = await executeTool("GITHUB_GET_A_BRANCH", {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    branch: BASE_BRANCH,
  }, GITHUB_CONNECTED_ACCOUNT);
  const baseSha = branchResult.data?.commit?.sha;
  if (!baseSha) {
    throw new Error(
      `Failed to get base branch SHA: ${JSON.stringify(branchResult)}`
    );
  }

  // Step 2: Create a new branch
  await executeTool("GITHUB_CREATE_A_REFERENCE", {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  }, GITHUB_CONNECTED_ACCOUNT);
  console.log(`[github] Created branch: ${branchName}`);

  // Step 3: Commit the SVG file to the new branch
  // Encode SVG content to base64
  const contentBase64 = Buffer.from(svgContent).toString("base64");

  await executeTool("GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: filePath,
    message: commitMessage,
    content: contentBase64,
    branch: branchName,
  }, GITHUB_CONNECTED_ACCOUNT);
  console.log(`[github] Committed ${filePath} to ${branchName}`);

  // Step 4: Create a Pull Request
  const prResult = await executeTool("GITHUB_CREATE_A_PULL_REQUEST", {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title: prTitle,
    body: prBody,
    head: branchName,
    base: BASE_BRANCH,
  }, GITHUB_CONNECTED_ACCOUNT);

  const prUrl =
    prResult.data?.html_url || prResult.data?.url || "PR created (URL unknown)";
  console.log(`[github] PR created: ${prUrl}`);

  return { prUrl, branchName };
}

export async function mergePRForSlug(slug: string): Promise<string> {
  const branchName = `logo/${slug}`;

  // Find the open PR for this branch
  const prsResult = await executeTool("GITHUB_LIST_PULL_REQUESTS", {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    head: `${REPO_OWNER}:${branchName}`,
    state: "open",
  }, GITHUB_CONNECTED_ACCOUNT);

  const prs = prsResult.data || [];
  if (!Array.isArray(prs) || prs.length === 0) {
    throw new Error(`No open PR found for branch ${branchName}`);
  }

  const prNumber = prs[0].number;
  const prUrl = prs[0].html_url || prs[0].url;
  console.log(`[github] Found PR #${prNumber} for ${branchName}`);

  // Merge the PR
  await executeTool("GITHUB_MERGE_A_PULL_REQUEST", {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    pull_number: prNumber,
    merge_method: "squash",
  }, GITHUB_CONNECTED_ACCOUNT);
  console.log(`[github] Merged PR #${prNumber}`);

  // Delete the branch
  try {
    await executeTool("GITHUB_DELETE_A_REFERENCE", {
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `heads/${branchName}`,
    }, GITHUB_CONNECTED_ACCOUNT);
    console.log(`[github] Deleted branch ${branchName}`);
  } catch (err) {
    console.warn(`[github] Failed to delete branch ${branchName}:`, err);
  }

  return prUrl;
}
