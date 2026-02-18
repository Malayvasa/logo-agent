import { executeTool } from "./composio";

const GMAIL_CONNECTED_ACCOUNT = "ca_TssZYkFAW_L5";

interface VectorizeResult {
  svgContent: string;
}

export async function vectorize(
  faviconImageUrl: string,
  sessionId?: string
): Promise<VectorizeResult> {
  // Step 1: Log in to vectorizer.io with OTP
  console.log(`[vectorize] Step 1: Logging into vectorizer.io`);
  const browserSessionId = await loginToVectorizer(sessionId);

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

async function loginToVectorizer(
  sessionId?: string
): Promise<string> {
  // Task 1: Navigate to vectorizer.io, click login, enter email, request OTP
  console.log(`[vectorize] Initiating login on vectorizer.io`);
  const loginTask = await executeTool("BROWSER_TOOL_CREATE_TASK", {
    task: [
      `Go to https://www.vectorizer.io/`,
      `Find and click the login or sign-in button`,
      `Enter the email address: malay@composio.dev`,
      `Click the button to send the OTP or verification code`,
      `Wait until you see the OTP/code input field, then STOP`,
    ].join(". "),
    startUrl: "https://www.vectorizer.io/",
    ...(sessionId ? { sessionId } : {}),
  });

  const loginTaskId = loginTask.data?.watch_task_id;
  const browserSessionId =
    loginTask.data?.browser_session_id ||
    loginTask.data?.sessionId ||
    sessionId;

  if (!loginTaskId) {
    throw new Error(
      `Failed to create login task: ${JSON.stringify(loginTask)}`
    );
  }

  console.log(`[vectorize] Login task created: ${loginTaskId}`);

  // Wait for the login task to finish (OTP requested)
  await waitForTask(loginTaskId);

  // Wait for OTP email to arrive
  console.log(`[vectorize] Waiting 15s for OTP email to arrive...`);
  await sleep(15000);

  // Fetch OTP from Gmail
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

async function waitForTask(taskId: string): Promise<void> {
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
      console.log(
        `[vectorize] Task ${taskId} finished:`,
        JSON.stringify(watchResult.data, null, 2).substring(0, 500)
      );
      return;
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

        if (svgFiles.length === 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const names = outputFiles
            .map((f: any) => f.fileName || f.name)
            .join(", ");
          console.log(
            `[vectorize] No SVG files in output, only: ${names}`
          );
          throw new Error(
            "Vectorize task finished but no SVG file was produced"
          );
        }

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
            !svgContent.includes("<svg") &&
            !svgContent.includes("<?xml")
          ) {
            throw new Error(
              `Downloaded file is not valid SVG (starts with: ${svgContent.substring(0, 50)})`
            );
          }

          return svgContent;
        }
      }

      const output = watchResult.data?.output;
      if (output && output.includes("<svg")) return output;

      const result = watchResult.data?.result;
      if (result && String(result).includes("<svg")) return String(result);

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
