import { executeLinearTool } from "./composio";
import { linearTriageStateName } from "./config";

// One run per request, decided from what's on the Linear issue itself.
//
// Why not the webhook payload or the in-memory `processing` Set:
// - A single Linear event can reach us more than once, at the same second
//   (bulk-created tickets on Nov 27 got two runs that posted their status
//   comments within the same second, before anything else touched the issue).
// - Follow-up updates (the PR attachment Linear's GitHub integration adds, the
//   assignee it sets, our own Wordmark label) still started runs after #28, so
//   the payload's change list can't be relied on to tell them apart.
// - Each delivery can land on a different serverless instance, so the Set
//   doesn't see the others.
//
// The issue's comments are the one place every instance sees. Every run posts
// a "**Logo Agent** processing" comment first, so the rule is: a run goes
// ahead only if its own status comment is the earliest live agent comment for
// the current request. Later runs see an earlier comment and step aside.

const AGENT_PREFIX = "**Logo Agent**";
const PROCESSING_PREFIX = "**Logo Agent** processing";
const NO_WEBSITE_PREFIX = "**Logo Agent** — needs a website";

// A run edits its status comment at every step and the route's maxDuration is
// 300s, so a processing comment untouched for longer than this is a dead run
// (timed out or crashed), not one still in flight.
const STALE_MS = 6 * 60 * 1000;

export type RunTrigger =
  // Linear issue update/create webhook: one run per move into Todo/Triage.
  | { kind: "issue" }
  // A replacement image/SVG commented on the issue: one run per comment.
  | { kind: "comment"; at?: string }
  // Admin batch sweep: only steps aside for a run already in flight.
  | { kind: "manual" };

interface AgentComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

interface IssueRunState {
  createdAt: string;
  stateName: string;
  history: {
    createdAt: string;
    toState?: { name?: string } | null;
    updatedDescription?: boolean | null;
  }[];
  comments: AgentComment[];
}

const ISSUE_RUN_STATE_QUERY = `query LogoAgentRunState($id: String!) {
  issue(id: $id) {
    createdAt
    state { name }
    history(first: 100) { nodes { createdAt toState { name } updatedDescription } }
    comments(first: 100) { nodes { id body createdAt updatedAt } }
  }
}`;

export async function fetchIssueRunState(issueId: string): Promise<IssueRunState> {
  const result = await executeLinearTool("LINEAR_RUN_QUERY_OR_MUTATION", {
    query_or_mutation: ISSUE_RUN_STATE_QUERY,
    variables: { id: issueId },
  });
  const issue = result.data?.data?.issue ?? result.data?.issue;
  if (!issue?.createdAt) {
    throw new Error(`Linear returned no issue for ${issueId}`);
  }
  return {
    createdAt: issue.createdAt,
    stateName: issue.state?.name || "",
    history: issue.history?.nodes || [],
    comments: (issue.comments?.nodes || []).filter(
      (c: AgentComment) => typeof c.body === "string" && c.body.startsWith(AGENT_PREFIX)
    ),
  };
}

const ms = (iso: string) => new Date(iso).getTime();

// When the current request started: the issue's creation, its latest move
// into Todo/Triage, or its latest description edit (adding a missing website
// is how a rejected issue gets picked up again).
export function requestStartedAt(state: IssueRunState): number {
  const queued = new Set(["todo", linearTriageStateName().toLowerCase()]);
  let start = ms(state.createdAt);
  for (const h of state.history) {
    const into = h.toState?.name?.toLowerCase();
    if ((into && queued.has(into)) || h.updatedDescription) {
      start = Math.max(start, ms(h.createdAt));
    }
  }
  return start;
}

function isInFlight(c: AgentComment, now: number): boolean {
  return c.body.startsWith(PROCESSING_PREFIX) && now - ms(c.updatedAt) < STALE_MS;
}

// Agent comments that stand for a run of the current request: any run still
// in flight, plus (for issue/comment triggers) any run started after the
// request did. "Needs a website" isn't a run.
function runsForRequest(
  state: IssueRunState,
  trigger: RunTrigger,
  now: number
): AgentComment[] {
  let since: number | null = null;
  if (trigger.kind === "issue") since = requestStartedAt(state);
  if (trigger.kind === "comment" && trigger.at && !Number.isNaN(ms(trigger.at))) {
    since = ms(trigger.at);
  }
  return state.comments.filter(
    (c) =>
      !c.body.startsWith(NO_WEBSITE_PREFIX) &&
      (isInFlight(c, now) || (since !== null && ms(c.createdAt) >= since))
  );
}

/**
 * Cheap pre-check for the webhook, before anything is posted: has a run
 * already started (or finished) for this request? Returns a reason to skip,
 * or null to go ahead. Lookup failures return null so a Linear hiccup never
 * drops a real request; claimRun() still guards the run itself.
 */
export async function existingRunReason(
  issueId: string,
  trigger: RunTrigger
): Promise<string | null> {
  try {
    const state = await fetchIssueRunState(issueId);
    const runs = runsForRequest(state, trigger, Date.now());
    if (runs.length === 0) return null;
    const live = runs.some((c) => isInFlight(c, Date.now()));
    return live ? "a run is already in progress" : "this request already ran";
  } catch (err) {
    console.warn(`[run-claim] Pre-check failed for ${issueId}, letting the run decide:`, err);
    return null;
  }
}

/**
 * Called by a run right after it posts its own status comment. The earliest
 * comment for the request wins (ties broken by id, so two runs that posted in
 * the same millisecond still agree on one winner); everyone else steps aside.
 *
 * On a win it also returns the older agent comments the run should clear
 * (the previous run's result), never a later run's comment.
 */
export async function claimRun(
  issueId: string,
  ownCommentId: string,
  trigger: RunTrigger
): Promise<{ won: true; olderAgentCommentIds: string[] } | { won: false; winnerId: string }> {
  let state = await fetchIssueRunState(issueId);
  let own = state.comments.find((c) => c.id === ownCommentId);
  if (!own) {
    // Just posted, so it should be there; give Linear a moment and look again.
    // No other run deletes a fresh processing comment, so if it's still
    // missing, run rather than drop the request.
    await new Promise((r) => setTimeout(r, 1500));
    state = await fetchIssueRunState(issueId);
    own = state.comments.find((c) => c.id === ownCommentId);
    if (!own) {
      console.warn(`[run-claim] Own status comment not visible on ${issueId}; running without a claim`);
      return { won: true, olderAgentCommentIds: [] };
    }
  }
  const mine = own;

  const contenders = runsForRequest(state, trigger, Date.now());
  if (!contenders.some((c) => c.id === mine.id)) contenders.push(mine);
  contenders.sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.id.localeCompare(b.id));
  const winner = contenders[0];
  if (winner.id !== mine.id) return { won: false, winnerId: winner.id };

  const olderAgentCommentIds = state.comments
    .filter(
      (c) =>
        c.id !== mine.id &&
        !isInFlight(c, Date.now()) &&
        (ms(c.createdAt) < ms(mine.createdAt) ||
          (ms(c.createdAt) === ms(mine.createdAt) && c.id.localeCompare(mine.id) < 0))
    )
    .map((c) => c.id);
  return { won: true, olderAgentCommentIds };
}
