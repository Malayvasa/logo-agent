import "dotenv/config";
import { processLogo } from "../src/lib/process-logo";

const testRequest = {
  slug: "notion",
  websiteUrl: "https://notion.so",
  issueIdentifier: "LOG-TEST",
  issueId: "test-issue-id",
};

async function main() {
  console.log("Starting test flow...");
  console.log("Request:", JSON.stringify(testRequest, null, 2));

  try {
    const prUrl = await processLogo(testRequest);
    console.log(`\n✅ Success! PR URL: ${prUrl}`);
  } catch (err) {
    console.error(`\n❌ Failed:`, err);
    process.exit(1);
  }
}

main();
