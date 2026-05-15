import { Composio } from "@composio/core";
import { githubUserId, linearUserId } from "./config";

let _client: InstanceType<typeof Composio> | null = null;

export function getComposio() {
  if (!_client) {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set");
    _client = new Composio({ apiKey });
  }
  return _client;
}

export function getLinearConnectedAccount(): string {
  const id = process.env.LINEAR_CONNECTED_ACCOUNT;
  if (!id) throw new Error("LINEAR_CONNECTED_ACCOUNT is not set");
  return id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeTool(
  slug: string,
  args: Record<string, unknown>,
  connectedAccountId?: string,
  userId: string = githubUserId()
): Promise<{ data: any }> {
  const composio = getComposio();
  const result = await composio.tools.execute(slug, {
    userId,
    ...(connectedAccountId ? { connectedAccountId } : {}),
    arguments: args,
    dangerouslySkipVersionCheck: true,
  });
  return result as { data: any };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeLinearTool(
  slug: string,
  args: Record<string, unknown>
): Promise<{ data: any }> {
  return executeTool(slug, args, getLinearConnectedAccount(), linearUserId());
}
