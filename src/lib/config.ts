// Centralized env reads. Lazy so missing values fail at first use, not at
// module load — keeps tests / scripts that only touch a subset of the agent
// from needing the full env.

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

// GitHub target repo (the logo CDN we're committing to).
export const repoOwner = () => required("LOGO_REPO_OWNER");
export const repoName = () => required("LOGO_REPO_NAME");
export const repoBranch = () => process.env.LOGO_REPO_BRANCH || "main";

// Composio: which entity owns which connected account. Linear and GitHub can
// live under different Composio entities; the wrappers in composio.ts pick the
// right userId per toolkit.
export const linearUserId = () => required("LINEAR_USER_ID");
export const githubUserId = () => process.env.GITHUB_USER_ID || "default";
export const githubConnectedAccount = () => required("GITHUB_CONNECTED_ACCOUNT");

// Linear workspace specifics.
export const linearProjectId = () => required("LINEAR_LOGOS_PROJECT_ID");
export const linearProjectName = () => process.env.LINEAR_PROJECT_NAME || "Logos";
export const linearInReviewStateId = () => required("LINEAR_IN_REVIEW_STATE_ID");
export const linearTriageStateName = () => process.env.LINEAR_TRIAGE_STATE_NAME || "Triage";

// Used by URL filters to recognize "the target repo" so we don't treat a PR
// link pasted in an issue description as the source website URL.
export const repoUrlFragment = () => `github.com/${repoOwner()}/${repoName()}`;
