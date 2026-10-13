import { generateText, Output } from "ai";
import sharp from "sharp";
import { z } from "zod";
import { aiGatewayModel } from "./config";

// Logos in the CDN render as square app icons, so a brand name spelled out
// next to (or instead of) the mark gets shrunk to an unreadable strip. The
// January bulk import brought in a few of these (instantly was one); this
// module flags them so a human can swap in the bare symbol.

const RENDER_SIZE = 256;
const GAP = 16;

const classificationSchema = z.object({
  kind: z.enum(["symbol", "monogram", "wordmark", "symbol_with_wordmark"]),
  confidence: z.enum(["low", "medium", "high"]),
  textSeen: z.string(),
  reason: z.string(),
});

export type WordmarkClassification = z.infer<typeof classificationSchema>;

export interface WordmarkResult extends WordmarkClassification {
  slug: string;
  flagged: boolean;
  // Width / height of the visible content. Wordmarks run wide, so this is a
  // useful sanity check next to the model's call.
  aspectRatio: number;
  // The light/dark render the model saw, reused as the Slack thread image.
  preview: Buffer;
}

const PROMPT = [
  `This is the logo for "{slug}", rendered twice: on a white background (left) and a dark background (right), so light and dark artwork are both visible. The dark render may use the brand's dark-theme variant.`,
  `Classify what the logo contains:`,
  `- "symbol": a graphic mark with no readable text.`,
  `- "monogram": the mark is one or two letters (e.g. a stylised "f" or "HP"), with no other words.`,
  `- "wordmark": the logo is mainly the brand name or other words spelled out (three or more letters of readable text).`,
  `- "symbol_with_wordmark": a graphic mark plus the brand name or other words next to or under it.`,
  `Put any readable text in textSeen (empty string if none). Keep reason under 120 characters.`,
].join("\n");

export async function detectWordmark(
  slug: string,
  svg: Buffer,
  darkSvg?: Buffer
): Promise<WordmarkResult> {
  const { preview, aspectRatio } = await renderForModel(svg, darkSvg);
  const { classification } = await classifyPreview(slug, preview, aiGatewayModel());

  const flagged =
    classification.kind === "wordmark" ||
    classification.kind === "symbol_with_wordmark";

  return { slug, flagged, aspectRatio, preview, ...classification };
}

// Exposed separately so scripts can compare models on the same render.
export async function classifyPreview(slug: string, preview: Buffer, model: string) {
  const result = await generateText({
    model,
    output: Output.object({ schema: classificationSchema }),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT.replace("{slug}", slug) },
          { type: "file", mediaType: "image/png", data: preview },
        ],
      },
    ],
  });

  if (!result.output) {
    throw new Error(`AI Gateway returned no classification for ${slug}`);
  }

  return {
    classification: result.output,
    usage: result.usage,
    providerMetadata: result.providerMetadata,
  };
}

// The dark tile uses the logo's `-dark` variant when the CDN has one, matching
// what `/api/:slug?theme=dark` serves; otherwise the main asset on dark.
export async function renderForModel(
  svg: Buffer,
  darkSvg?: Buffer
): Promise<{ preview: Buffer; aspectRatio: number }> {
  const rasterize = (source: Buffer) =>
    sharp(source, { density: 300 })
      .resize(RENDER_SIZE, RENDER_SIZE, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

  const [icon, darkIcon] = await Promise.all([
    rasterize(svg),
    darkSvg ? rasterize(darkSvg) : null,
  ]);

  const tile = (source: Buffer, background: string) =>
    sharp(source).flatten({ background }).png().toBuffer();
  const [light, dark] = await Promise.all([
    tile(icon, "#ffffff"),
    tile(darkIcon ?? icon, "#1f1f1f"),
  ]);

  const preview = await sharp({
    create: {
      width: RENDER_SIZE * 2 + GAP,
      height: RENDER_SIZE,
      channels: 3,
      background: "#808080",
    },
  })
    .composite([
      { input: light, left: 0, top: 0 },
      { input: dark, left: RENDER_SIZE + GAP, top: 0 },
    ])
    .png()
    .toBuffer();

  return { preview, aspectRatio: await contentAspectRatio(icon) };
}

async function contentAspectRatio(icon: Buffer): Promise<number> {
  const { data, info } = await sharp(icon)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      const isWhite = data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245;
      if (data[i + 3] > 20 && !isWhite) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return 1;
  const ratio = (maxX - minX + 1) / (maxY - minY + 1);
  return Math.round(ratio * 100) / 100;
}
