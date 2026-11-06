import { generateText, Output } from "ai";
import sharp from "sharp";
import { z } from "zod";
import { aiGatewayModel } from "./config";

// vectorizer.ai traces flat colour regions, so a gradient comes back as a
// stack of hard-edged bands. Quiver redraws the logo as SVG and keeps real
// <linearGradient>/<radialGradient> fills, so vectorize.ts sends gradient
// logos there instead. This module makes that call with a vision model.

const RENDER_SIZE = 256;
const GAP = 16;

const gradientSchema = z.object({
  hasGradient: z.boolean(),
  confidence: z.enum(["low", "medium", "high"]),
  reason: z.string(),
});

export type GradientClassification = z.infer<typeof gradientSchema>;

const PROMPT = [
  `This is a raster logo, shown twice: on a white background (left) and a dark background (right) so transparent areas are visible.`,
  `Does the logo artwork itself use colour gradients: smooth transitions between colours or shades across a shape (linear or radial fills, glossy highlights, soft shading)?`,
  `Answer false for flat-colour logos, even multi-coloured ones. Don't count blur from upscaling, anti-aliased edges or JPEG compression noise as gradients.`,
  `Keep reason under 120 characters.`,
].join("\n");

export async function detectGradient(png: Buffer): Promise<GradientClassification> {
  const preview = await renderForModel(png);
  const result = await generateText({
    model: aiGatewayModel(),
    output: Output.object({ schema: gradientSchema }),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          { type: "file", mediaType: "image/png", data: preview },
        ],
      },
    ],
  });

  if (!result.output) {
    throw new Error("AI Gateway returned no gradient classification");
  }
  return result.output;
}

async function renderForModel(png: Buffer): Promise<Buffer> {
  const icon = await sharp(png)
    .resize(RENDER_SIZE, RENDER_SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const tile = (background: string) =>
    sharp(icon).flatten({ background }).png().toBuffer();
  const [light, dark] = await Promise.all([tile("#ffffff"), tile("#1f1f1f")]);

  return sharp({
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
}
