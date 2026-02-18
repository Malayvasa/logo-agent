interface FaviconResult {
  imageUrl: string;
}

export async function fetchFavicon(
  websiteUrl: string
): Promise<FaviconResult> {
  const url = new URL(websiteUrl);
  const origin = url.origin;
  const domain = url.hostname;

  // Strategy 1: Parse HTML for a large icon (>= 64px)
  console.log(`[fetch-favicon] Fetching HTML from ${origin}`);
  let htmlIcon: { href: string; size: number } | null = null;
  try {
    htmlIcon = await findBestIconFromHtml(origin);
  } catch (err) {
    console.log(`[fetch-favicon] HTML parsing failed: ${err}`);
  }

  // If HTML found a large icon (known size >= 64px), use it directly
  if (htmlIcon && htmlIcon.size >= 64) {
    console.log(`[fetch-favicon] Using HTML icon: ${htmlIcon.href} (${htmlIcon.size}px)`);
    return { imageUrl: htmlIcon.href };
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
          console.log(`[fetch-favicon] Found icon at common path: ${testUrl}`);
          return { imageUrl: testUrl };
        }
      }
    } catch {
      // continue to next path
    }
  }

  // Strategy 3: Use the HTML icon if we found one (even with unknown size)
  if (htmlIcon) {
    console.log(`[fetch-favicon] Using HTML icon (unknown size): ${htmlIcon.href}`);
    return { imageUrl: htmlIcon.href };
  }

  // Strategy 4: Google's favicon API (always works, variable quality)
  const googleUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
  console.log(`[fetch-favicon] Falling back to Google API: ${googleUrl}`);
  return { imageUrl: googleUrl };
}

async function findBestIconFromHtml(
  origin: string
): Promise<{ href: string; size: number } | null> {
  const res = await fetch(origin, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; LogoAgent/1.0)" },
  });

  if (!res.ok) return null;

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

  if (candidates.length === 0) return null;

  // Sort: largest first, prefer apple-touch-icon
  candidates.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    if (a.isAppleTouch && !b.isAppleTouch) return -1;
    if (!a.isAppleTouch && b.isAppleTouch) return 1;
    return 0;
  });

  console.log(
    `[fetch-favicon] Found ${candidates.length} icon candidates, best: ${candidates[0].href} (${candidates[0].size}px)`
  );

  return { href: candidates[0].href, size: candidates[0].size };
}
