import { Composio } from "@composio/core";

async function main() {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    console.error("COMPOSIO_API_KEY is required. Set it in your .env file.");
    process.exit(1);
  }

  const webhookUrl = process.argv[2];
  if (!webhookUrl) {
    console.error(
      "Usage: npx tsx scripts/setup-trigger.ts <webhook-url>\n" +
        "Example: npx tsx scripts/setup-trigger.ts https://logo-agent.vercel.app/api/webhook"
    );
    process.exit(1);
  }

  const composio = new Composio({ apiKey });

  // Step 1: List available trigger types for Linear
  console.log("Fetching Linear trigger types...");
  const triggerTypes = await composio.triggers.listTypes({
    toolkit: "linear",
  });
  console.log(
    "Available triggers:",
    triggerTypes.items?.map((t: { slug: string }) => t.slug)
  );

  // Step 2: Get the issue created trigger type
  const triggerType = await composio.triggers.getType(
    "LINEAR_ISSUE_UPDATED_TRIGGER"
  );
  console.log("Trigger type:", triggerType.slug);
  console.log("Config schema:", JSON.stringify(triggerType.config, null, 2));

  // Step 3: List connected accounts to find the Linear one
  const accounts = await composio.connectedAccounts.list({
    toolkit: "linear",
  });
  const linearAccount = accounts.items?.[0];
  if (!linearAccount) {
    console.error(
      "No Linear connected account found. Connect Linear first at https://app.composio.dev"
    );
    process.exit(1);
  }
  console.log("Linear connected account:", linearAccount.id);

  // Step 4: Create the trigger
  // You'll need to find your team_id from Linear.
  // You can get it from the Linear UI or by running a query.
  const teamId = process.env.LINEAR_TEAM_ID;
  if (!teamId) {
    console.error(
      "LINEAR_TEAM_ID is required. Find it in Linear settings or via the API."
    );

    // Help the user find it — list issues to see team IDs
    console.log("\nTrying to fetch teams from Linear...");
    try {
      const result = await composio.tools.execute(
        "LINEAR_LIST_LINEAR_PROJECTS",
        {
          userId: "default",
          arguments: {},
          dangerouslySkipVersionCheck: true,
        }
      );
      console.log("Projects:", JSON.stringify(result.data, null, 2));
    } catch (err) {
      console.log("Could not fetch projects:", err);
    }
    process.exit(1);
  }

  console.log(`Creating trigger for team ${teamId}...`);
  const trigger = await composio.triggers.create({
    triggerSlug: "LINEAR_ISSUE_UPDATED_TRIGGER",
    connectedAccountId: linearAccount.id,
    triggerConfig: {
      team_id: teamId,
    },
  });

  console.log("Trigger created:", JSON.stringify(trigger, null, 2));
  console.log(
    `\nWebhook will be delivered to: ${webhookUrl}\n` +
      `Configure this URL in your Composio dashboard at https://app.composio.dev`
  );
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
