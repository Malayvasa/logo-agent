// An "SVG" exported from some tools is just a PNG/JPEG wrapped in an
// <image> element. It passes every "is this SVG markup?" check, but it isn't
// a vector: it won't scale and normalize-svg can't do anything useful with it.

const IMAGE_ELEMENT_REGEX = /<(?:svg:)?(?:image|feImage)\b[^>]*>/gi;
const HREF_REGEX = /\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const RASTER_DATA_URI_REGEX = /^data:image\/(?!svg\+xml)[a-z0-9.+-]+/i;
const RASTER_EXTENSION_REGEX = /\.(?:png|jpe?g|gif|webp|bmp|ico|avif|tiff?)(?:[?#]|$)/i;

export interface EmbeddedRaster {
  // "png", "jpeg", … for data URIs; the file extension for linked images.
  format: string;
  kind: "data-uri" | "linked";
}

// Returns the first raster image embedded in or linked from the SVG, or null
// if it's pure vector. <image> elements pointing at another SVG are allowed.
export function findEmbeddedRaster(svg: string): EmbeddedRaster | null {
  for (const [tag] of svg.matchAll(IMAGE_ELEMENT_REGEX)) {
    const hrefMatch = tag.match(HREF_REGEX);
    const href = (hrefMatch?.[1] ?? hrefMatch?.[2] ?? "").trim();

    const dataUri = href.match(RASTER_DATA_URI_REGEX);
    if (dataUri) {
      return { format: dataUri[0].slice("data:image/".length).toLowerCase(), kind: "data-uri" };
    }

    const ext = href.match(RASTER_EXTENSION_REGEX);
    if (ext) {
      return { format: ext[0].replace(/^\./, "").replace(/[?#]$/, "").toLowerCase(), kind: "linked" };
    }
  }
  return null;
}

export function embeddedRasterMessage(raster: EmbeddedRaster): string {
  const what =
    raster.kind === "data-uri"
      ? `an embedded ${raster.format.toUpperCase()} image`
      : `a linked ${raster.format.toUpperCase()} image`;
  return `The SVG contains ${what} instead of vector paths, so it isn't a real vector logo. Export the logo as outlined vector shapes and comment it again.`;
}
