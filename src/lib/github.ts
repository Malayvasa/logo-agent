import { executeTool } from "./composio";
import { repoOwner, repoName, repoBranch, githubConnectedAccount } from "./config";

interface PrResult {
  prUrl: string;
  branchName: string;
}

export async function commitAndCreatePR(
  slug: string,
  svgContent: string,
  issueIdentifier: string
): Promise<PrResult> {
  const owner = repoOwner();
  const repo = repoName();
  const baseBranch = repoBranch();
  const githubAccount = githubConnectedAccount();
  const branchName = `logo/${slug}`;
  const filePath = `src/assets/${slug}.svg`;
  const commitMessage = `feat: add ${slug} logo`;
  const prTitle = `Add ${slug} logo`;
  // Use base-branch URL so the preview keeps working post-merge (the feature
  // branch gets deleted by mergePRForSlug). Cache-bust so force-pushes refresh.
  const rawSvgUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${baseBranch}/${filePath}?v=${Date.now()}`;
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

  // Step 1: Check if branch already exists
  let branchExists = false;
  try {
    const existing = await executeTool("GITHUB_GET_A_BRANCH", {
      owner,
      repo,
      branch: branchName,
    }, githubAccount);
    branchExists = !!existing.data?.commit?.sha;
  } catch {
    branchExists = false;
  }

  if (branchExists) {
    console.log(`[github] Branch ${branchName} already exists, reusing`);
  } else {
    // Create new branch from base
    const branchResult = await executeTool("GITHUB_GET_A_BRANCH", {
      owner,
      repo,
      branch: baseBranch,
    }, githubAccount);
    const baseSha = branchResult.data?.commit?.sha;
    if (!baseSha) {
      throw new Error(`Failed to get base branch SHA`);
    }

    await executeTool("GITHUB_CREATE_A_REFERENCE", {
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    }, githubAccount);
    console.log(`[github] Created branch: ${branchName}`);
  }

  // Step 2: Get existing file SHA if it exists (needed for updates)
  let existingFileSha: string | undefined;
  try {
    const fileResult = await executeTool("GITHUB_GET_REPOSITORY_CONTENT", {
      owner,
      repo,
      path: filePath,
      ref: branchName,
    }, githubAccount);
    existingFileSha = fileResult.data?.sha;
  } catch {
    // File doesn't exist yet, that's fine
  }

  // Step 3: Commit the SVG file
  const contentBase64 = Buffer.from(svgContent).toString("base64");

  await executeTool("GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", {
    owner,
    repo,
    path: filePath,
    message: existingFileSha ? `fix: update ${slug} logo` : commitMessage,
    content: contentBase64,
    branch: branchName,
    ...(existingFileSha ? { sha: existingFileSha } : {}),
  }, githubAccount);
  console.log(`[github] ${existingFileSha ? "Updated" : "Committed"} ${filePath} to ${branchName}`);

  // Step 4: Find existing open PR or create new one
  let prUrl: string;
  const existingPrs = await findOpenPRs(branchName);

  if (existingPrs.length > 0) {
    prUrl = existingPrs[0].html_url || existingPrs[0].url;
    console.log(`[github] Existing PR found: ${prUrl}`);
  } else {
    const prResult = await executeTool("GITHUB_CREATE_A_PULL_REQUEST", {
      owner,
      repo,
      title: prTitle,
      body: prBody,
      head: branchName,
      base: baseBranch,
    }, githubAccount);

    prUrl = prResult.data?.html_url || prResult.data?.url || "PR created (URL unknown)";
    console.log(`[github] PR created: ${prUrl}`);
  }

  return { prUrl, branchName };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findOpenPRs(branchName: string): Promise<any[]> {
  try {
    const prsResult = await executeTool("GITHUB_LIST_PULL_REQUESTS", {
      owner: repoOwner(),
      repo: repoName(),
      head: `${repoOwner()}:${branchName}`,
      state: "open",
    }, githubConnectedAccount());
    return Array.isArray(prsResult.data)
      ? prsResult.data
      : prsResult.data?.pull_requests || prsResult.data?.data || [];
  } catch {
    return [];
  }
}

export async function mergePRForSlug(slug: string): Promise<string> {
  const owner = repoOwner();
  const repo = repoName();
  const githubAccount = githubConnectedAccount();
  const branchName = `logo/${slug}`;

  const prs = await findOpenPRs(branchName);
  if (prs.length === 0) {
    console.log(`[github] No open PR for ${branchName}, skipping merge`);
    return "";
  }

  const prNumber = prs[0].number;
  const prUrl = prs[0].html_url || prs[0].url;
  console.log(`[github] Found PR #${prNumber} for ${branchName}`);

  // Merge the PR
  await executeTool("GITHUB_MERGE_A_PULL_REQUEST", {
    owner,
    repo,
    pull_number: prNumber,
    merge_method: "squash",
  }, githubAccount);
  console.log(`[github] Merged PR #${prNumber}`);

  // Delete the branch
  try {
    await executeTool("GITHUB_DELETE_A_REFERENCE", {
      owner,
      repo,
      ref: `heads/${branchName}`,
    }, githubAccount);
    console.log(`[github] Deleted branch ${branchName}`);
  } catch (err) {
    console.warn(`[github] Failed to delete branch ${branchName}:`, err);
  }

  return prUrl;
}
