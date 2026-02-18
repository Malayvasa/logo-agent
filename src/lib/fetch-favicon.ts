import { executeTool } from "./composio";

const FAVICON_DOWNLOADER_URL =
  "https://onlineminitools.com/website-favicon-downloader";

interface FaviconResult {
  sessionId: string;
  taskId: string;
  imageUrl: string;
}

export async function fetchFavicon(websiteUrl: string): Promise<FaviconResult> {
  // Step 1: Create a browser task to fetch the favicon
  const createResult = await executeTool("BROWSER_TOOL_CREATE_TASK", {
    task: [
      `Go to ${FAVICON_DOWNLOADER_URL}`,
      `Find the input field for the website URL and type: ${websiteUrl}`,
      `Click the download/submit button to fetch the favicon`,
      `Wait for the results to load`,
      `Find the largest favicon image available (prefer 128x128 or larger)`,
      `Download that favicon image`,
    ].join(". "),
    startUrl: FAVICON_DOWNLOADER_URL,
  });

  const sessionId = createResult.data?.browser_session_id;
  const taskId = createResult.data?.watch_task_id;

  if (!sessionId || !taskId) {
    throw new Error(
      `Failed to create browser task: ${JSON.stringify(createResult)}`
    );
  }

  console.log(`[fetch-favicon] Browser task created: ${taskId}`);

  // Step 2: Poll until the task is complete
  const imageUrl = await pollBrowserTask(taskId);

  return { sessionId, taskId, imageUrl };
}

async function pollBrowserTask(taskId: string): Promise<string> {
  const maxAttempts = 30;
  const pollInterval = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(pollInterval);

    const watchResult = await executeTool("BROWSER_TOOL_WATCH_TASK", {
      taskId,
    });

    const status = watchResult.data?.status;
    console.log(
      `[fetch-favicon] Task ${taskId} status: ${status} (attempt ${i + 1})`
    );

    if (status === "finished") {
      // Log the full response so we can see what came back
      console.log(
        `[fetch-favicon] Finished response:`,
        JSON.stringify(watchResult.data, null, 2)
      );

      // Check for output files (downloaded favicon)
      const outputFiles =
        watchResult.data?.outputFiles || watchResult.data?.output_files;
      if (outputFiles && outputFiles.length > 0) {
        const fileId = outputFiles[0].id || outputFiles[0].fileId;
        const fileResult = await executeTool("BROWSER_TOOL_GET_OUTPUT_FILE", {
          taskId,
          fileId,
        });
        console.log(
          `[fetch-favicon] File result:`,
          JSON.stringify(fileResult.data, null, 2)
        );
        return (
          fileResult.data?.url ||
          fileResult.data?.download_url ||
          fileResult.data?.downloadUrl
        );
      }

      // Check the result output — might be text containing a URL
      const output = watchResult.data?.output;
      if (output) {
        // Try to extract a URL from the output text
        const urlMatch = output.match(/https?:\/\/[^\s"'<>]+/);
        if (urlMatch) return urlMatch[0];
        return output;
      }

      // Check other possible fields
      const result = watchResult.data?.result;
      if (result) {
        const urlMatch = String(result).match(/https?:\/\/[^\s"'<>]+/);
        if (urlMatch) return urlMatch[0];
        return String(result);
      }

      throw new Error("Browser task finished but no favicon found in output");
    }

    if (status === "stopped" || status === "failed") {
      throw new Error(`Browser task ${status}: ${watchResult.data?.output}`);
    }
  }

  throw new Error(`Browser task timed out after ${maxAttempts} attempts`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
