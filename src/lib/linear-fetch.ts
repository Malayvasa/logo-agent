// Files dropped into a Linear comment land at uploads.linear.app/<id>/<id>/<id>
// (no extension, no signature). Fetching that URL anonymously returns 401 —
// Linear gates the CDN behind the same API token as the GraphQL API.
//
// Composio's Linear toolkit doesn't expose a passthrough HTTP fetcher, so we
// hold a Linear personal API key separately and attach it as the Authorization
// header for any request to uploads.linear.app. For all other hosts the call
// degrades to a plain fetch — the helper is safe to drop in anywhere we'd
// otherwise call fetch() on a possibly-Linear-hosted URL.

const LINEAR_UPLOAD_HOST = "uploads.linear.app";

export function isLinearUpload(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname === LINEAR_UPLOAD_HOST;
  } catch {
    return false;
  }
}

export async function fetchWithLinearAuth(
  url: string,
  init?: RequestInit
): Promise<Response> {
  if (!isLinearUpload(url)) return fetch(url, init);

  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.warn(
      "[linear-fetch] uploads.linear.app URL but LINEAR_API_KEY is not set; request will likely 401"
    );
    return fetch(url, init);
  }

  const headers = new Headers(init?.headers);
  // Linear personal API keys go directly in the Authorization header — no
  // "Bearer" prefix. OAuth tokens use "Bearer", but personal keys don't.
  headers.set("Authorization", apiKey);
  return fetch(url, { ...init, headers });
}
