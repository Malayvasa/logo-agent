import { executeTool } from "./composio";
import { repoOwner, repoName, repoBranch, githubConnectedAccount } from "./config";

interface PrResult {
  prUrl: string;
  prNumber: number;
  branchName: string;
}

export interface MergeResult {
  prUrl: string;
  /** Squash-merge commit SHA on the base branch. Use it to pin preview URLs. */
  mergeCommitSha: string;
}

// How many `logo/<slug>-N` variants to try before giving up on finding a free
// branch name.
const MAX_BRANCH_ATTEMPTS = 20;
// GitHub computes mergeability asynchronously; a PR created a second ago can
// briefly report as not mergeable. In a burst (dozens of tickets filed at
// once) the squash merges also collide with each other and GitHub answers
// "Base branch was modified" until the others land; on Nov 27 eight logos
// were left unmerged after 4 tries 3s apart. Retry longer, with jitter so
// colliding runs spread out instead of retrying in lockstep.
const MERGE_ATTEMPTS = 8;
const MERGE_RETRY_MIN_MS = 2000;
const MERGE_RETRY_MAX_MS = 6000;
const mergeRetryDelay = () =>
  MERGE_RETRY_MIN_MS + Math.floor(Math.random() * (MERGE_RETRY_MAX_MS - MERGE_RETRY_MIN_MS));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Composio's tools.execute() doesn't throw when GitHub refuses a call; it
// returns { successful: false, error }. Unchecked, a refused "create branch"
// or "open PR" looked like success, which is how two runs of the same slug
// ended up sharing one branch on Nov 27 and one of them deleted the branch
// under the other's open PR (zotero, google_pay_wallet_mcp, zoho_social,
// expensify_mcp). Every write below goes through this and throws instead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function github(slug: string, args: Record<string, unknown>): Promise<{ data: any }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await executeTool(slug, args, githubConnectedAccount());
  if (result?.successful === false || result?.error) {
    const raw = result?.error || result?.data?.message || `${slug} failed`;
    throw new Error(typeof raw === "string" ? raw : JSON.stringify(raw));
  }
  return result;
}

const isAlreadyExists = (err: unknown) =>
  /already exists/i.test(err instanceof Error ? err.message : String(err));

async function branchExists(branch: string): Promise<boolean> {
  try {
    const result = await github("GITHUB_GET_A_BRANCH", {
      owner: repoOwner(),
      repo: repoName(),
      branch,
    });
    return !!result.data?.commit?.sha;
  } catch {
    return false;
  }
}

// Every run gets its own branch, so every run opens its own PR — that's what
// makes a follow-up comment on an already-merged issue produce a *new* PR
// rather than silently reusing the old one. In the normal flow the previous
// branch is deleted at merge time, so we land back on `logo/<slug>`; the
// numbered suffixes only come into play when an earlier merge failed and left
// its branch behind, or another run for the same slug is in flight.
//
// The branch is claimed by creating it: GitHub refuses to create a ref that
// already exists, so two runs racing for `logo/<slug>` can't both get it (a
// check-then-create could, and did). The loser moves on to the next suffix.
async function createRunBranch(slug: string, baseSha: string): Promise<string> {
  const base = `logo/${slug}`;
  for (let i = 1; i <= MAX_BRANCH_ATTEMPTS; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    try {
      await github("GITHUB_CREATE_A_REFERENCE", {
        owner: repoOwner(),
        repo: repoName(),
        ref: `refs/heads/${candidate}`,
        sha: baseSha,
      });
      if (i > 1) {
        console.log(`[github] ${base} is taken, using ${candidate} instead`);
      }
      return candidate;
    } catch (err) {
      // Taken by an earlier run's leftover branch or a run in flight. Don't
      // rely on the error's wording alone; check the branch is really there.
      if (isAlreadyExists(err) || (await branchExists(candidate))) continue;
      throw err;
    }
  }
  throw new Error(
    `No free branch name for ${slug} (tried ${base} through ${base}-${MAX_BRANCH_ATTEMPTS})`
  );
}

export async function commitAndCreatePR(
  slug: string,
  svgContent: string,
  issueIdentifier: string
): Promise<PrResult> {
  const owner = repoOwner();
  const repo = repoName();
  const baseBranch = repoBranch();
  const filePath = `src/assets/${slug}.svg`;
  const prTitle = `Add ${slug} logo`;
  // Use base-branch URL so the preview keeps working post-merge (the feature
  // branch gets deleted by mergePR). Cache-bust so re-runs refresh.
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

  // Step 1: Branch off the base branch
  const branchResult = await github("GITHUB_GET_A_BRANCH", {
    owner,
    repo,
    branch: baseBranch,
  });
  const baseSha = branchResult.data?.commit?.sha;
  if (!baseSha) {
    throw new Error(`Failed to get base branch SHA`);
  }

  const branchName = await createRunBranch(slug, baseSha);
  console.log(`[github] Created branch: ${branchName}`);

  // From here on the branch is this run's alone, so on any failure bin it and
  // the next run gets a clean `logo/<slug>` instead of drifting to `-2`, `-3`…
  try {
    // Step 2: Get existing file SHA if it exists (needed for updates). The
    // branch is fresh off base, so this is really "does the base branch
    // already carry a logo for this slug" — true for every re-run after a
    // first merge.
    let existingFileSha: string | undefined;
    try {
      const fileResult = await github("GITHUB_GET_REPOSITORY_CONTENT", {
        owner,
        repo,
        path: filePath,
        ref: branchName,
      });
      existingFileSha = fileResult.data?.sha;
    } catch {
      // File doesn't exist yet, that's fine
    }

    // Step 3: Commit the SVG file
    const contentBase64 = Buffer.from(svgContent).toString("base64");

    await github("GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", {
      owner,
      repo,
      path: filePath,
      message: existingFileSha ? `fix: update ${slug} logo` : `feat: add ${slug} logo`,
      content: contentBase64,
      branch: branchName,
      ...(existingFileSha ? { sha: existingFileSha } : {}),
    });
    console.log(`[github] ${existingFileSha ? "Updated" : "Committed"} ${filePath} to ${branchName}`);

    // Step 4: Open the PR.
    let prResult;
    try {
      prResult = await github("GITHUB_CREATE_A_PULL_REQUEST", {
        owner,
        repo,
        title: prTitle,
        body: prBody,
        head: branchName,
        base: baseBranch,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // GitHub refuses a PR with no commits between the branches: the SVG we
      // just wrote is byte-identical to what's already on the base branch.
      if (/no commits between/i.test(message)) {
        throw new Error(
          `The generated SVG for ${slug} is identical to the one already on ${baseBranch}, so there was nothing to open a PR for`
        );
      }
      throw new Error(`Failed to open a PR for ${slug}: ${message}`);
    }

    const prUrl: string | undefined = prResult.data?.html_url || prResult.data?.url;
    const prNumber: number | undefined = prResult.data?.number;
    if (!prUrl || typeof prNumber !== "number") {
      throw new Error(`GitHub didn't return a PR number for ${slug}`);
    }

    console.log(`[github] PR created: ${prUrl} (#${prNumber})`);
    return { prUrl, prNumber, branchName };
  } catch (err) {
    await deleteBranch(branchName);
    throw err;
  }
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

async function deleteBranch(branchName: string): Promise<void> {
  try {
    await executeTool("GITHUB_DELETE_A_REFERENCE", {
      owner: repoOwner(),
      repo: repoName(),
      ref: `heads/${branchName}`,
    }, githubConnectedAccount());
    console.log(`[github] Deleted branch ${branchName}`);
  } catch (err) {
    console.warn(`[github] Failed to delete branch ${branchName}:`, err);
  }
}

/**
 * Squash-merge a PR and delete its branch. Retries a few times because GitHub
 * computes mergeability asynchronously and a just-opened PR can report as not
 * yet mergeable.
 *
 * Returns the merge commit SHA — pin preview URLs to it so they survive the
 * branch deletion.
 */
export async function mergePR(prNumber: number, branchName: string): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MERGE_ATTEMPTS; attempt++) {
    try {
      const result = await executeTool("GITHUB_MERGE_A_PULL_REQUEST", {
        owner: repoOwner(),
        repo: repoName(),
        pull_number: prNumber,
        merge_method: "squash",
      }, githubConnectedAccount());

      const sha: string | undefined = result.data?.sha;
      const merged = result.data?.merged === true || !!sha;

      if (merged) {
        console.log(`[github] Merged PR #${prNumber} (${sha || "sha unknown"})`);
        await deleteBranch(branchName);
        return sha || "";
      }

      lastError = new Error(
        result.data?.message || `GitHub did not confirm the merge of PR #${prNumber}`
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    console.log(
      `[github] Merge attempt ${attempt}/${MERGE_ATTEMPTS} for PR #${prNumber} failed: ${lastError.message}`
    );
    if (attempt < MERGE_ATTEMPTS) await sleep(mergeRetryDelay());
  }

  throw lastError || new Error(`Failed to merge PR #${prNumber}`);
}

/**
 * Merge whatever open PR exists for a slug's branch. Used by /api/backfill and
 * by the Done-transition backstop; the main pipeline merges by PR number.
 */
export async function mergePRForSlug(slug: string): Promise<string> {
  const branchName = `logo/${slug}`;
  const prs = await findOpenPRs(branchName);
  if (prs.length === 0) {
    console.log(`[github] No open PR for ${branchName}, skipping merge`);
    return "";
  }

  const prNumber = prs[0].number;
  const prUrl = prs[0].html_url || prs[0].url;
  console.log(`[github] Found PR #${prNumber} for ${branchName}`);

  await mergePR(prNumber, branchName);
  return prUrl;
}
