interface FaviconResult {
  candidates: string[];
}

export async function fetchFavicon(
  websiteUrl: string
): Promise<FaviconResult> {
  const url = new URL(websiteUrl);
  const origin = url.origin;
  const domain = url.hostname;

  const candidates: string[] = [];

  // Strategy 1: Parse HTML for icons
  console.log(`[fetch-favicon] Fetching HTML from ${origin}`);
  let htmlIcons: { href: string; size: number }[] = [];
  try {
    htmlIcons = await findIconsFromHtml(origin);
  } catch (err) {
    console.log(`[fetch-favicon] HTML parsing failed: ${err}`);
  }

  // Add large HTML icons first (known size >= 64px)
  const largeHtmlIcons = htmlIcons.filter((i) => i.size >= 64);
  for (const icon of largeHtmlIcons) {
    console.log(`[fetch-favicon] HTML icon candidate: ${icon.href} (${icon.size}px)`);
    candidates.push(icon.href);
  }

  // Strategy 2: Try common icon paths (often higher quality)
  const commonPaths = [
    "/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png",
    "/favicon-192x192.png",
    "/favicon-96x96.png",
    "/favicon.png",
  ];

  for (const path of commonPaths) {
    try {
      const testUrl = `${origin}${path}`;
      const res = await fetch(testUrl, { method: "HEAD", redirect: "follow" });
      if (res.ok) {
        const contentType = res.headers.get("content-type") || "";
        if (contentType.startsWith("image/")) {
          if (!candidates.includes(testUrl)) {
            console.log(`[fetch-favicon] Common path candidate: ${testUrl}`);
            candidates.push(testUrl);
          }
        }
      }
    } catch {
      // continue to next path
    }
  }

  // Strategy 3: Add remaining HTML icons (unknown/small size)
  const smallHtmlIcons = htmlIcons.filter((i) => i.size < 64);
  for (const icon of smallHtmlIcons) {
    if (!candidates.includes(icon.href)) {
      console.log(`[fetch-favicon] HTML icon candidate (small/unknown): ${icon.href}`);
      candidates.push(icon.href);
    }
  }

  // Strategy 4: Google's favicon API (always works, variable quality)
  const googleUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
  console.log(`[fetch-favicon] Adding Google API fallback: ${googleUrl}`);
  candidates.push(googleUrl);

  console.log(`[fetch-favicon] Total candidates: ${candidates.length}`);
  return { candidates };
}

async function findIconsFromHtml(
  origin: string
): Promise<{ href: string; size: number }[]> {
  const res = await fetch(origin, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; LogoAgent/1.0)" },
  });

  if (!res.ok) return [];

  const html = await res.text();

  // Find all <link> tags with rel containing "icon"
  const linkRegex =
    /<link\s+[^>]*rel=["'](?:[^"']*(?:icon|apple-touch-icon)[^"']*)["'][^>]*>/gi;
  const links = html.match(linkRegex) || [];

  interface IconCandidate {
    href: string;
    size: number;
    isAppleTouch: boolean;
  }

  const candidates: IconCandidate[] = [];

  for (const link of links) {
    const hrefMatch = link.match(/href=["']([^"']+)["']/);
    if (!hrefMatch) continue;

    const href = hrefMatch[1];
    const isAppleTouch = /apple-touch-icon/i.test(link);

    // Parse sizes attribute (e.g. sizes="180x180")
    const sizesMatch = link.match(/sizes=["'](\d+)x(\d+)["']/);
    const size = sizesMatch ? parseInt(sizesMatch[1], 10) : isAppleTouch ? 180 : 0;

    // Resolve relative URLs
    let fullUrl: string;
    try {
      fullUrl = new URL(href, origin).href;
    } catch {
      continue;
    }

    // Skip .ico files — they're usually tiny and multi-res containers
    if (fullUrl.endsWith(".ico")) continue;

    candidates.push({ href: fullUrl, size, isAppleTouch });
  }

  if (candidates.length === 0) return [];

  // Sort: largest first, prefer apple-touch-icon
  candidates.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    if (a.isAppleTouch && !b.isAppleTouch) return -1;
    if (!a.isAppleTouch && b.isAppleTouch) return 1;
    return 0;
  });

  console.log(
    `[fetch-favicon] Found ${candidates.length} icon candidates from HTML`
  );

  return candidates.map((c) => ({ href: c.href, size: c.size }));
}
