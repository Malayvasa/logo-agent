import sharp from "sharp";

export class ImageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageFetchError";
  }
}

interface VectorizeResult {
  svgContent: string;
}

const VECTORIZER_API_ID =
  process.env.VECTORIZER_API_ID || process.env.VECTORIZER_API_KEY;
const VECTORIZER_API_SECRET = process.env.VECTORIZER_API_SECRET;
const MIN_SIZE = 128;
const UPSCALE_TARGET = 256;

export async function vectorize(
  faviconImageUrl: string
): Promise<VectorizeResult> {
  if (!VECTORIZER_API_ID || !VECTORIZER_API_SECRET) {
    throw new Error(
      "VECTORIZER_API_ID and VECTORIZER_API_SECRET env vars are required"
    );
  }

  console.log(`[vectorize] Fetching image: ${faviconImageUrl}`);

  // Download the image
  const imageResponse = await fetch(faviconImageUrl);
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

  // Send to vectorizer.ai API
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

  return { svgContent };
}
