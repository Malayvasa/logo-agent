import { Composio } from "@composio/core";

let _client: InstanceType<typeof Composio> | null = null;

// Composio entity that owns the Linear connected account. GitHub uses a
// different entity ("agent-sso-update"), so we can't share one global userId.
const LINEAR_USER_ID = "pg-test-ac8a98fe-69d3-42c3-aa8d-866e52e6ab0d";

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
  userId: string = "agent-sso-update"
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
  return executeTool(slug, args, getLinearConnectedAccount(), LINEAR_USER_ID);
}
