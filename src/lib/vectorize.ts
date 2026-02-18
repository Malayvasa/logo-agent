import { executeTool } from "./composio";

const GMAIL_CONNECTED_ACCOUNT = "ca_TssZYkFAW_L5";

// Cache browser session ID across calls — Browser Use preserves login state
let lastSessionId: string | null = null;

interface VectorizeResult {
  svgContent: string;
}

export async function vectorize(
  faviconImageUrl: string
): Promise<VectorizeResult> {
  // Step 1: Ensure logged in (reuses session if still active)
  console.log(`[vectorize] Step 1: Ensuring logged into vectorizer.io`);
  const browserSessionId = await ensureLoggedIn();

  // Step 2: Vectorize the image (same browser session, now logged in)
  console.log(`[vectorize] Step 2: Vectorizing image`);
  const createResult = await executeTool("BROWSER_TOOL_CREATE_TASK", {
    task: [
      `You are already logged into vectorizer.io as a pro user.`,
      `Go to https://www.vectorizer.io/`,
      `Upload the image from this URL: ${faviconImageUrl}`,
      `Wait for the vectorization to complete`,
      `Download the result as an SVG file`,
      `IMPORTANT: The downloaded file MUST be an SVG file (not PNG). If vectorization fails, try again.`,
      `After downloading, read the SVG file content using JavaScript: var content = require('fs').readFileSync('<downloaded_file_path>', 'utf8'); and include the full SVG XML in your done message between SVG_START and SVG_END markers.`,
    ].join(". "),
    startUrl: "https://www.vectorizer.io/",
    ...(browserSessionId ? { sessionId: browserSessionId } : {}),
  });

  const taskId = createResult.data?.watch_task_id;

  if (!taskId) {
    throw new Error(
      `Failed to create vectorize task: ${JSON.stringify(createResult)}`
    );
  }

  console.log(`[vectorize] Browser task created: ${taskId}`);

  const svgContent = await pollVectorizeTask(taskId);

  return { svgContent };
}

async function ensureLoggedIn(): Promise<string> {
  // Task 1: Check if already logged in, if not start the login flow
  console.log(
    `[vectorize] Checking login status${lastSessionId ? ` (cached session: ${lastSessionId})` : " (no cached session)"}`
  );
  const loginTask = await executeTool("BROWSER_TOOL_CREATE_TASK", {
    task: [
      `Go to https://www.vectorizer.io/`,
      `Check if you are already logged in as a pro user (look for account menu, user email, profile icon, or "My Account" link)`,
      `If you ARE already logged in, say exactly "ALREADY_LOGGED_IN" and STOP`,
      `If you are NOT logged in:`,
      `  - Find and click the login or sign-in button`,
      `  - Enter the email address: malay@composio.dev`,
      `  - Click the button to send the OTP or verification code`,
      `  - Wait until you see the OTP/code input field, then STOP`,
    ].join(". "),
    startUrl: "https://www.vectorizer.io/",
    ...(lastSessionId ? { sessionId: lastSessionId } : {}),
  });

  const loginTaskId = loginTask.data?.watch_task_id;
  const browserSessionId =
    loginTask.data?.browser_session_id ||
    loginTask.data?.sessionId ||
    lastSessionId;

  if (!loginTaskId) {
    throw new Error(
      `Failed to create login task: ${JSON.stringify(loginTask)}`
    );
  }

  console.log(`[vectorize] Login check task created: ${loginTaskId}`);

  // Wait for the task to finish and check the output
  const taskOutput = await waitForTask(loginTaskId);

  // If already logged in, skip OTP entirely
  if (taskOutput.includes("ALREADY_LOGGED_IN")) {
    console.log(`[vectorize] Already logged in, skipping OTP`);
    lastSessionId = browserSessionId || null;
    return browserSessionId || "";
  }

  // Not logged in — need to do the OTP flow
  console.log(`[vectorize] Not logged in, waiting 15s for OTP email...`);
  await sleep(15000);

  const otp = await fetchOtpFromGmail();
  console.log(`[vectorize] Got OTP: ${otp}`);

  // Task 2: Enter the OTP in the same browser session
  console.log(`[vectorize] Entering OTP in browser`);
  const otpTask = await executeTool("BROWSER_TOOL_CREATE_TASK", {
    task: [
      `Enter the verification code / OTP: ${otp}`,
      `Submit or confirm the code to complete login`,
      `Wait for login to complete successfully`,
    ].join(". "),
    ...(browserSessionId ? { sessionId: browserSessionId } : {}),
  });

  const otpTaskId = otpTask.data?.watch_task_id;
  const finalSessionId =
    otpTask.data?.browser_session_id ||
    otpTask.data?.sessionId ||
    browserSessionId;

  if (otpTaskId) {
    await waitForTask(otpTaskId);
  }

  console.log(`[vectorize] Login complete, session: ${finalSessionId}`);
  lastSessionId = finalSessionId || null;
  return finalSessionId || "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchOtpFromGmail(): Promise<string> {
  // Try a few times in case the email hasn't arrived yet
  for (let attempt = 0; attempt < 3; attempt++) {
    console.log(
      `[vectorize] Checking Gmail for OTP email (attempt ${attempt + 1})`
    );

    const result = await executeTool(
      "GMAIL_FETCH_EMAILS",
      {
        query: "from:vectorizer.io newer_than:5m",
        max_results: 1,
        user_id: "me",
        verbose: true,
        include_payload: true,
      },
      GMAIL_CONNECTED_ACCOUNT
    );

    console.log(
      `[vectorize] Gmail result:`,
      JSON.stringify(result.data, null, 2).substring(0, 1000)
    );

    const messages = result.data?.messages || result.data?.emails || [];
    if (messages.length > 0) {
      const email = messages[0];
      const body =
        email.messageText ||
        email.body ||
        email.snippet ||
        email.text ||
        "";

      console.log(
        `[vectorize] Email body preview: ${body.substring(0, 300)}`
      );

      // Extract OTP code — typically 4-8 digits
      const otpMatch = body.match(/\b(\d{4,8})\b/);
      if (otpMatch) {
        return otpMatch[1];
      }

      // Maybe it's a different format — try to find any code-like pattern
      const codeMatch = body.match(
        /(?:code|otp|verification|token)[:\s]+([A-Za-z0-9]{4,8})/i
      );
      if (codeMatch) {
        return codeMatch[1];
      }

      // Return the full body so the browser can try to use it
      console.log(
        `[vectorize] No OTP pattern found, returning raw body for browser`
      );
      return body;
    }

    if (attempt < 2) {
      console.log(`[vectorize] No OTP email yet, waiting 10s...`);
      await sleep(10000);
    }
  }

  throw new Error("Failed to find OTP email from vectorizer.io in Gmail");
}

async function waitForTask(taskId: string): Promise<string> {
  const maxAttempts = 30;
  const pollInterval = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(pollInterval);

    const watchResult = await executeTool("BROWSER_TOOL_WATCH_TASK", {
      taskId,
    });

    const status = watchResult.data?.status;
    console.log(
      `[vectorize] Task ${taskId} status: ${status} (attempt ${i + 1})`
    );

    if (status === "finished") {
      const output = JSON.stringify(watchResult.data, null, 2);
      console.log(
        `[vectorize] Task ${taskId} finished:`,
        output.substring(0, 500)
      );
      return output;
    }

    if (status === "stopped" || status === "failed") {
      throw new Error(
        `Task ${taskId} ${status}: ${watchResult.data?.output}`
      );
    }
  }

  throw new Error(`Task ${taskId} timed out after ${maxAttempts} attempts`);
}

async function pollVectorizeTask(taskId: string): Promise<string> {
  const maxAttempts = 60;
  const pollInterval = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(pollInterval);

    const watchResult = await executeTool("BROWSER_TOOL_WATCH_TASK", {
      taskId,
    });

    const status = watchResult.data?.status;
    console.log(
      `[vectorize] Task ${taskId} status: ${status} (attempt ${i + 1})`
    );

    if (status === "finished") {
      console.log(
        `[vectorize] Finished response:`,
        JSON.stringify(watchResult.data, null, 2)
      );

      // Method 1: Check outputFiles from the Browser Tool API
      const outputFiles =
        watchResult.data?.outputFiles || watchResult.data?.output_files;
      if (outputFiles && outputFiles.length > 0) {
        console.log(
          `[vectorize] Found ${outputFiles.length} output files:`,
          JSON.stringify(outputFiles, null, 2)
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const svgFiles = outputFiles.filter((f: any) =>
          (f.fileName || f.name || "").toLowerCase().includes("svg")
        );

        if (svgFiles.length > 0) {
          const file = svgFiles[0];
          const fileId = file.id || file.fileId;
          console.log(
            `[vectorize] Using file: ${JSON.stringify(file)}, fileId: ${fileId}`
          );

          const fileResult = await executeTool(
            "BROWSER_TOOL_GET_OUTPUT_FILE",
            {
              taskId,
              fileId,
            }
          );
          console.log(
            `[vectorize] File result:`,
            JSON.stringify(fileResult.data, null, 2)
          );

          const downloadUrl =
            fileResult.data?.downloadUrl ||
            fileResult.data?.url ||
            fileResult.data?.download_url;
          if (downloadUrl) {
            const response = await fetch(downloadUrl);
            const svgContent = await response.text();
            console.log(
              `[vectorize] Downloaded (${svgContent.length} chars), starts with: ${svgContent.substring(0, 200)}`
            );

            if (
              svgContent.includes("<svg") ||
              svgContent.includes("<?xml")
            ) {
              return svgContent;
            }
            console.log(`[vectorize] Downloaded file is not valid SVG, trying other methods...`);
          }
        } else {
          console.log(`[vectorize] No SVG files in outputFiles, trying other extraction methods...`);
        }
      } else {
        console.log(`[vectorize] No outputFiles in response, trying other extraction methods...`);
      }

      const output = watchResult.data?.output;
      if (output && output.includes("<svg")) return output;

      const result = watchResult.data?.result;
      if (result && String(result).includes("<svg")) return String(result);

      // Check the steps' done action for SVG content (Browser Tool puts content there)
      const svgFromSteps = extractSvgFromSteps(watchResult.data?.steps);
      if (svgFromSteps) {
        console.log(
          `[vectorize] Extracted SVG from steps done action (${svgFromSteps.length} chars)`
        );
        return svgFromSteps;
      }

      // Last resort: find SVG file path in files_to_display and read it via a follow-up task
      const svgFilePath = extractSvgFilePathFromSteps(watchResult.data?.steps);
      if (svgFilePath) {
        console.log(
          `[vectorize] Found SVG file path in steps: ${svgFilePath}, reading via follow-up task`
        );
        const svgFromFile = await readFileViaBrowserTask(svgFilePath, watchResult.data?.id);
        if (svgFromFile) return svgFromFile;
      }

      throw new Error(
        "Vectorize task finished but no SVG found in output"
      );
    }

    if (status === "stopped" || status === "failed") {
      throw new Error(
        `Vectorize task ${status}: ${watchResult.data?.output}`
      );
    }
  }

  throw new Error(`Vectorize task timed out after ${maxAttempts} attempts`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSvgFilePathFromSteps(steps: any[] | undefined): string | null {
  if (!steps || !Array.isArray(steps)) return null;

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const actions = step?.actions;
    if (!actions || !Array.isArray(actions)) continue;

    for (const action of actions) {
      const actionStr = typeof action === "string" ? action : JSON.stringify(action);
      // Look for files_to_display containing .svg paths
      const fileMatch = actionStr.match(/files_to_display[^[]*\[([^\]]*\.svg[^\]]*)\]/);
      if (fileMatch) {
        const pathMatch = fileMatch[1].match(/"([^"]*\.svg)"/);
        if (pathMatch) return pathMatch[1];
      }
    }
  }

  return null;
}

async function readFileViaBrowserTask(filePath: string, sessionId?: string): Promise<string | null> {
  try {
    console.log(`[vectorize] Creating follow-up task to read SVG file: ${filePath}`);
    const readTask = await executeTool("BROWSER_TOOL_CREATE_TASK", {
      task: [
        `Read the contents of the file at: ${filePath}`,
        `Use JavaScript: const fs = require('fs'); const content = fs.readFileSync('${filePath}', 'utf8');`,
        `Or navigate to the file URL if it's accessible.`,
        `In your done message, include the COMPLETE file contents between markers: SVG_START and SVG_END`,
      ].join(". "),
      ...(sessionId ? { sessionId } : lastSessionId ? { sessionId: lastSessionId } : {}),
    });

    const readTaskId = readTask.data?.watch_task_id;
    if (!readTaskId) return null;

    const taskOutput = await waitForTask(readTaskId);
    // Try to extract SVG from the task output
    const markerMatch = taskOutput.match(/SVG_START([\s\S]*?)SVG_END/);
    if (markerMatch && markerMatch[1].includes("<svg")) return markerMatch[1].trim();

    const svgMatch = taskOutput.match(/(<svg[\s\S]*?<\/svg>)/);
    if (svgMatch) return svgMatch[1];

    return null;
  } catch (err) {
    console.error(`[vectorize] Failed to read SVG file via browser task:`, err);
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSvgFromSteps(steps: any[] | undefined): string | null {
  if (!steps || !Array.isArray(steps)) return null;

  // Walk steps in reverse to find the done action with SVG content
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const actions = step?.actions;
    if (!actions || !Array.isArray(actions)) continue;

    for (const action of actions) {
      const actionStr = typeof action === "string" ? action : JSON.stringify(action);

      // Check for SVG_START...SVG_END markers
      const markerMatch = actionStr.match(/SVG_START([\s\S]*?)SVG_END/);
      if (markerMatch) {
        const svg = markerMatch[1].trim();
        if (svg.includes("<svg")) return svg;
      }

      // Check for raw SVG content in the done text
      const svgMatch = actionStr.match(/(<svg[\s\S]*?<\/svg>)/);
      if (svgMatch) return svgMatch[1];

      // Check for <?xml ... <svg> content
      const xmlSvgMatch = actionStr.match(/(<\?xml[\s\S]*?<\/svg>)/);
      if (xmlSvgMatch) return xmlSvgMatch[1];
    }
  }

  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
