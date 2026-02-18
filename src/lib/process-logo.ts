import type { LogoRequest } from "@/types";
import { fetchFavicon } from "./fetch-favicon";
import { vectorize } from "./vectorize";
import { normalizeSvg } from "./normalize-svg";
import { commitAndCreatePR } from "./github";
import { executeTool } from "./composio";

const LINEAR_CONNECTED_ACCOUNT = "ca_32jlkHR7XaS-";

export async function processLogo(request: LogoRequest): Promise<string> {
  const { slug, websiteUrl, issueIdentifier } = request;

  console.log(
    `[process-logo] Starting: slug=${slug}, url=${websiteUrl}, issue=${issueIdentifier}`
  );

  // Step 1: Fetch favicon using Browser Tool
  console.log(`[process-logo] Step 1: Fetching favicon from ${websiteUrl}`);
  const { imageUrl, sessionId } = await fetchFavicon(websiteUrl);
  console.log(`[process-logo] Favicon fetched: ${imageUrl}`);

  // Step 2: Vectorize using vectorizer.io via Browser Tool
  console.log(`[process-logo] Step 2: Vectorizing`);
  const { svgContent: rawSvg } = await vectorize(imageUrl, sessionId);
  console.log(
    `[process-logo] Vectorized SVG received (${rawSvg.length} chars)`
  );

  // Step 3: Normalize SVG to 128x128
  console.log(`[process-logo] Step 3: Normalizing SVG`);
  const normalizedSvg = normalizeSvg(rawSvg);

  // Step 4: Commit and create PR
  console.log(`[process-logo] Step 4: Creating PR on GitHub`);
  const { prUrl, branchName } = await commitAndCreatePR(
    slug,
    normalizedSvg,
    issueIdentifier
  );

  // Step 5: Comment on the Linear issue with the PR link and SVG preview
  console.log(`[process-logo] Step 5: Updating Linear issue`);
  const svgPreviewUrl = `https://raw.githubusercontent.com/ComposioHQ/logo-cdn/${branchName}/src/assets/${slug}.svg`;
  try {
    await executeTool("LINEAR_CREATE_LINEAR_COMMENT", {
      issue_id: request.issueId,
      body: `Logo PR created: ${prUrl}\n\n![${slug} logo](${svgPreviewUrl})`,
    }, LINEAR_CONNECTED_ACCOUNT);
  } catch (err) {
    console.error(`[process-logo] Failed to comment on Linear issue:`, err);
  }

  console.log(`[process-logo] Done: ${prUrl}`);
  return prUrl;
}
