import sharp from "sharp";
import { detectGradient } from "./detect-gradient";
import { fetchWithLinearAuth } from "./linear-fetch";

export class ImageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageFetchError";
  }
}

export type VectorizeEngine = "vectorizer" | "quiver";

interface VectorizeResult {
  svgContent: string;
  engine: VectorizeEngine;
}

const VECTORIZER_API_ID =
  process.env.VECTORIZER_API_ID || process.env.VECTORIZER_API_KEY;
const VECTORIZER_API_SECRET = process.env.VECTORIZER_API_SECRET;
const QUIVER_API_KEY = process.env.QUIVER_API_KEY;
const QUIVER_MODEL = process.env.QUIVER_MODEL || "arrow-2";
// Quiver usually answers in 10–40s but has taken ~2 min; the route allows 300s.
const QUIVER_TIMEOUT_MS = 180_000;
const MIN_SIZE = 128;
const UPSCALE_TARGET = 256;

export async function vectorize(
  faviconImageUrl: string
): Promise<VectorizeResult> {
  console.log(`[vectorize] Fetching image: ${faviconImageUrl}`);

  // Download the image (uploads.linear.app needs the Linear API key — Linear
  // gates its CDN behind the same auth as the GraphQL API)
  const imageResponse = await fetchWithLinearAuth(faviconImageUrl);
  if (!imageResponse.ok) {
    throw new ImageFetchError(
      `Failed to fetch image (${imageResponse.status}): ${faviconImageUrl}`
    );
  }
  let imageBuffer: Buffer = Buffer.from(await imageResponse.arrayBuffer());

  // Convert to PNG to ensure sharp can handle it (handles edge cases like ICO, WebP, etc.)
  try {
    imageBuffer = await sharp(imageBuffer).png().toBuffer();
  } catch (err) {
    throw new ImageFetchError(
      `Image format not supported: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // The gradient check looks at the image before upscaling, so lanczos
  // smoothing on a tiny favicon isn't mistaken for a gradient.
  const originalPng = imageBuffer;

  // Check dimensions and upscale if too small
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  console.log(`[vectorize] Image dimensions: ${width}x${height}`);

  if (width < MIN_SIZE || height < MIN_SIZE) {
    console.log(
      `[vectorize] Image too small (${width}x${height}), upscaling to ${UPSCALE_TARGET}x${UPSCALE_TARGET}`
    );
    imageBuffer = await sharp(imageBuffer)
      .resize(UPSCALE_TARGET, UPSCALE_TARGET, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toBuffer();
    console.log(`[vectorize] Upscaled to ${UPSCALE_TARGET}x${UPSCALE_TARGET}`);
  }

  // Gradient logos go to Quiver, which keeps real gradient fills; vectorizer.ai
  // would trace them into flat bands. The check is best-effort: if AI Gateway
  // or Quiver isn't configured or errors, the logo still goes to vectorizer.ai.
  if (QUIVER_API_KEY && (await hasGradient(originalPng))) {
    try {
      return { svgContent: await vectorizeWithQuiver(imageBuffer), engine: "quiver" };
    } catch (err) {
      console.log(
        `[vectorize] Quiver failed, falling back to vectorizer.ai: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return {
    svgContent: await vectorizeWithVectorizerAi(imageBuffer),
    engine: "vectorizer",
  };
}

async function hasGradient(png: Buffer): Promise<boolean> {
  try {
    const result = await detectGradient(png);
    console.log(
      `[vectorize] Gradient check: ${result.hasGradient} (${result.confidence}) — ${result.reason}`
    );
    return result.hasGradient;
  } catch (err) {
    console.log(
      `[vectorize] Gradient check failed, assuming flat: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

async function vectorizeWithQuiver(imageBuffer: Buffer): Promise<string> {
  console.log(`[vectorize] Calling Quiver (${QUIVER_MODEL})`);

  const response = await fetch("https://api.quiver.ai/v1/svgs/vectorizations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${QUIVER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: QUIVER_MODEL,
      image: { base64: imageBuffer.toString("base64") },
      stream: false,
    }),
    signal: AbortSignal.timeout(QUIVER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Quiver API error (${response.status}): ${errorBody}`);
  }

  const body = (await response.json()) as {
    data?: { svg?: string }[];
    credits?: number;
    usage?: { total_tokens?: number };
  };
  const svgContent = body.data?.[0]?.svg;
  if (!svgContent || !svgContent.includes("<svg")) {
    throw new Error(
      `Quiver returned no SVG: ${JSON.stringify(body).substring(0, 200)}`
    );
  }

  console.log(
    `[vectorize] Got SVG from Quiver (${svgContent.length} chars, ${body.credits ?? body.usage?.total_tokens ?? "?"} ${body.credits != null ? "credits" : "tokens"})`
  );
  return svgContent;
}

async function vectorizeWithVectorizerAi(imageBuffer: Buffer): Promise<string> {
  if (!VECTORIZER_API_ID || !VECTORIZER_API_SECRET) {
    throw new Error(
      "VECTORIZER_API_ID and VECTORIZER_API_SECRET env vars are required"
    );
  }

  console.log(`[vectorize] Calling vectorizer.ai API`);

  const formData = new FormData();
  formData.append(
    "image",
    new Blob([new Uint8Array(imageBuffer)], { type: "image/png" }),
    "image.png"
  );
  formData.append("output.file_format", "svg");
  formData.append("output.size.width", "128");
  formData.append("output.size.height", "128");
  formData.append("output.size.unit", "px");
  formData.append("output.size.aspect_ratio", "preserve_inset");
  formData.append("processing.shapes.min_area_px", "20");

  const auth = Buffer.from(
    `${VECTORIZER_API_ID}:${VECTORIZER_API_SECRET}`
  ).toString("base64");

  const response = await fetch("https://api.vectorizer.ai/api/v1/vectorize", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Vectorizer API error (${response.status}): ${errorBody}`
    );
  }

  const svgContent = await response.text();
  console.log(
    `[vectorize] Got SVG (${svgContent.length} chars) in ${response.headers.get("x-credits-charged") || "?"} credits`
  );

  if (!svgContent.includes("<svg") && !svgContent.includes("<?xml")) {
    throw new Error(
      `Vectorizer API returned non-SVG content: ${svgContent.substring(0, 100)}`
    );
  }

  return svgContent;
}
