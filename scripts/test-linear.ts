import "dotenv/config";
import { Composio } from "@composio/core";

async function main() {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY required");

  const composio = new Composio({ apiKey });

  // Try to get Linear-specific triggers
  const triggerTypes = await composio.triggers.listTypes({ toolkit: "linear" });
  const linearTriggers = (triggerTypes.items || []).filter(
    (t: { slug: string }) => t.slug.toLowerCase().includes("linear")
  );

  console.log("Linear triggers:");
  for (const t of linearTriggers) {
    console.log(`  - ${t.slug}`);
    if (t.config) {
      console.log(`    config: ${JSON.stringify(t.config)}`);
    }
  }

  if (linearTriggers.length === 0) {
    console.log("  (none found with 'linear' in name)");
    console.log("\nAll available trigger slugs:");
    for (const t of triggerTypes.items || []) {
      console.log(`  - ${t.slug}`);
    }
  }

  // Also try to get the issue updated trigger directly
  console.log("\nTrying to get LINEAR_ISSUE_UPDATED_TRIGGER...");
  try {
    const updated = await composio.triggers.getType("LINEAR_ISSUE_UPDATED_TRIGGER");
    console.log("Found:", updated.slug);
    console.log("Config:", JSON.stringify(updated.config, null, 2));
  } catch (err) {
    console.log("Not found");
  }

  // Try LINEAR_ISSUE_STATE_CHANGED_TRIGGER
  console.log("\nTrying LINEAR_ISSUE_STATE_CHANGED_TRIGGER...");
  try {
    const stateChanged = await composio.triggers.getType("LINEAR_ISSUE_STATE_CHANGED_TRIGGER");
    console.log("Found:", stateChanged.slug);
    console.log("Config:", JSON.stringify(stateChanged.config, null, 2));
  } catch (err) {
    console.log("Not found");
  }

  // List existing active triggers
  console.log("\nActive triggers:");
  const active = await composio.triggers.list({});
  for (const t of active.items || []) {
    console.log(`  - ${t.id}: ${t.triggerSlug} (${t.status})`);
  }
}

main().catch(console.error);
