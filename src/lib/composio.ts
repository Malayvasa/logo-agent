import { Composio } from "@composio/core";

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
  connectedAccountId?: string
): Promise<{ data: any }> {
  const composio = getComposio();
  const result = await composio.tools.execute(slug, {
    userId: connectedAccountId
      ? "pg-test-ac8a98fe-69d3-42c3-aa8d-866e52e6ab0d"
      : "default",
    ...(connectedAccountId ? { connectedAccountId } : {}),
    arguments: args,
    dangerouslySkipVersionCheck: true,
  });
  return result as { data: any };
}
