const TARGET_SIZE = 128;

export function normalizeSvg(svgContent: string): string {
  let svg = svgContent.trim();

  // Extract existing viewBox if present
  const viewBoxMatch = svg.match(/viewBox="([^"]+)"/);
  const existingViewBox = viewBoxMatch ? viewBoxMatch[1] : null;

  // Extract existing width/height
  const widthMatch = svg.match(/width="([^"]+)"/);
  const heightMatch = svg.match(/height="([^"]+)"/);

  // If no viewBox exists, try to create one from width/height
  if (!existingViewBox && widthMatch && heightMatch) {
    const w = parseFloat(widthMatch[1]);
    const h = parseFloat(heightMatch[1]);
    if (!isNaN(w) && !isNaN(h)) {
      svg = svg.replace(/<svg/, `<svg viewBox="0 0 ${w} ${h}"`);
    }
  }

  // Set width and height to target size
  if (widthMatch) {
    svg = svg.replace(/width="[^"]*"/, `width="${TARGET_SIZE}"`);
  } else {
    svg = svg.replace(/<svg/, `<svg width="${TARGET_SIZE}"`);
  }

  if (heightMatch) {
    svg = svg.replace(/height="[^"]*"/, `height="${TARGET_SIZE}"`);
  } else {
    svg = svg.replace(/<svg/, `<svg height="${TARGET_SIZE}"`);
  }

  // Ensure xmlns is present
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
    svg = svg.replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  return svg;
}
