import { NextRequest, NextResponse } from "next/server";

// Returns null if the caller is authorized; otherwise a 401/503 response to return.
// Auth is a Bearer token compared against ADMIN_API_KEY. The endpoint fails
// closed (503) when the env var is missing, so a misconfigured deploy can never
// expose unauthenticated admin endpoints.
export function requireAdmin(request: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    return NextResponse.json(
      { error: "Admin endpoint not configured (set ADMIN_API_KEY)" },
      { status: 503 }
    );
  }

  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const provided = match?.[1];

  if (!provided || !timingSafeEqual(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Reject URLs that resolve to private/loopback/link-local addresses or
// non-http(s) schemes. Used to harden user-supplied URLs against SSRF before
// the server fetches them.
export function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname;

  // Reject literal IPs in private / loopback / link-local / multicast space.
  // We only handle the common IPv4 forms and IPv6 ::1 / fc00::/7 / fe80::/10.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split(".").map((p) => parseInt(p, 10));
    if (parts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;
    const [a, b] = parts;
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 0) return false;
    if (a === 169 && b === 254) return false; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false; // multicast / reserved
  }

  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1).toLowerCase();
    if (v6 === "::1" || v6 === "::") return false;
    if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return false;
  }

  return true;
}
