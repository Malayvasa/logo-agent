import "dotenv/config";
import { Composio } from "@composio/core";

async function main() {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY required");

  const composio = new Composio({ apiKey });

  const triggerTypes = await composio.triggers.listTypes({ toolkit: "linear" });
  console.log("Available Linear triggers:");
  for (const t of triggerTypes.items || []) {
    console.log(`  - ${t.slug}: ${t.description || "(no description)"}`);
  }

  const accounts = await composio.connectedAccounts.list({ toolkit: "linear" });
  for (const a of accounts.items || []) {
    console.log(`\nLinear connected account: ${a.id} (status: ${a.status})`);
  }
}

main().catch(console.error);
