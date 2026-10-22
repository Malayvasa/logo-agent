import { executeLinearTool } from "./composio";
import { linearTeamId } from "./config";
import { detectWordmark, type WordmarkResult } from "./detect-wordmark";

// Logos render as square icons in the CDN, so one that spells out the brand
// name shrinks to an unreadable strip. After each merge the agent checks the
// logo that landed and tags the issue "Wordmark" so a designer can swap in the
// bare symbol. A clean rerun removes the label again.

const LABEL_NAME = "Wordmark";

// Resolved once per instance; the label is created on first use.
let labelIdPromise: Promise<string> | null = null;

async function linearGraphql(query: string, variables: Record<string, unknown>) {
  const result = await executeLinearTool("LINEAR_RUN_QUERY_OR_MUTATION", {
    query_or_mutation: query,
    variables,
  });
  return result.data?.data ?? result.data;
}

async function findOrCreateLabel(): Promise<string> {
  const teamId = linearTeamId();
  const found = await linearGraphql(
    `query FindLabel($teamId: ID!, $name: String!) {
      issueLabels(filter: { name: { eqIgnoreCase: $name }, team: { id: { eq: $teamId } } }) { nodes { id } }
    }`,
    { teamId, name: LABEL_NAME }
  );
  const existing = found?.issueLabels?.nodes?.[0]?.id;
  if (existing) return existing;

  const created = await linearGraphql(
    `mutation CreateLabel($teamId: String!, $name: String!) {
      issueLabelCreate(input: { teamId: $teamId, name: $name }) { success issueLabel { id } }
    }`,
    { teamId, name: LABEL_NAME }
  );
  const id = created?.issueLabelCreate?.issueLabel?.id;
  if (!id) throw new Error(`Couldn't create "${LABEL_NAME}" label: ${JSON.stringify(created).slice(0, 300)}`);
  console.log(`[wordmark-label] Created "${LABEL_NAME}" label ${id}`);
  return id;
}

function wordmarkLabelId(): Promise<string> {
  labelIdPromise ??= findOrCreateLabel().catch((err) => {
    labelIdPromise = null;
    throw err;
  });
  return labelIdPromise;
}

// Classifies the merged SVG and adds or removes the label to match.
export async function labelIfWordmark(
  issueId: string,
  slug: string,
  svg: string
): Promise<WordmarkResult> {
  const result = await detectWordmark(slug, Buffer.from(svg));
  console.log(
    `[wordmark-label] ${slug}: ${result.kind} (${result.confidence}) "${result.textSeen}" — ${result.flagged ? "flagged" : "clean"}`
  );

  const labelId = await wordmarkLabelId();
  const mutation = result.flagged ? "issueAddLabel" : "issueRemoveLabel";
  await linearGraphql(
    `mutation SetLabel($id: String!, $labelId: String!) { ${mutation}(id: $id, labelId: $labelId) { success } }`,
    { id: issueId, labelId }
  );
  return result;
}
