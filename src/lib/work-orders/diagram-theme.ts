export type DiagramPixels = { width: number; height: number; data: Uint8ClampedArray };
export type DiagramPalette = { surface: readonly [number, number, number]; ink: readonly [number, number, number] };

/** Display adaptation only. The authenticated source PNG and its identity remain unchanged. */
export function themeSourceDiagram(image: DiagramPixels, palette: DiagramPalette, sourceText = "") {
  const unchanged = (reason: string) => ({ data: image.data, adapted: false, reason });
  const { width, height, data } = image;
  const count = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isSafeInteger(count) || width < 16 || height < 16 || count > 4_000_000 || data.length !== count * 4) return unchanged("bounds");
  if (/\b(?:photo(?:graph|graphic)?s?|camera|screenshot|thermal image|scan(?:ned)?)\b/i.test(sourceText)) return unchanged("photographic-source");
  let paper = 0, ink = 0, middle = 0, border = 0, borderPaper = 0, pairs = 0, texture = 0, dark = 0, isolated = 0, darkTransitions = 0;
  const colors = new Map<number, number>();
  const nonPaperColors = new Map<number, number>();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4, r = data[at], g = data[at + 1], b = data[at + 2];
    if (data[at + 3] !== 255) return unchanged("transparency");
    const white = r >= 245 && g >= 245 && b >= 245;
    if (white) paper++; else {
      ink++;
      const exact = r * 65536 + g * 256 + b;
      nonPaperColors.set(exact, (nonPaperColors.get(exact) || 0) + 1);
      if (nonPaperColors.size > 8192) return unchanged("complex-palette");
    }
    if (r === g && g === b && r > 40 && r < 220) middle++;
    if (x < 3 || y < 3 || x >= width - 3 || y >= height - 3) { border++; if (white) borderPaper++; }
    const key = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5);
    colors.set(key, (colors.get(key) || 0) + 1);
    if (x && y && x < width - 1 && y < height - 1 && Math.max(r, g, b) <= 100) {
      dark++;
      const neighborWhite = (index: number) => data[index] >= 245 && data[index + 1] >= 245 && data[index + 2] >= 245;
      const left = neighborWhite(at - 4), right = neighborWhite(at + 4), above = neighborWhite(at - width * 4), below = neighborWhite(at + width * 4);
      if (Number(left) + Number(right) + Number(above) + Number(below) >= 3) isolated++;
      if (right) darkTransitions++;
    }
    if (x && !white) {
      const previous = at - 4;
      if (data[previous] < 245 || data[previous + 1] < 245 || data[previous + 2] < 245) {
        pairs++;
        const change = Math.max(Math.abs(r - data[previous]), Math.abs(g - data[previous + 1]), Math.abs(b - data[previous + 2]));
        if (change > 0 && change < 49) texture++;
      }
    }
  }
  // Flat, sparse, white-paper artwork only. Continuous-tone and ambiguous images stay original.
  if (paper / count < .45 || paper / count > .975 || borderPaper / border < .90) return unchanged("paper-layout");
  if (middle / Math.max(1, ink) > .16 || texture / Math.max(1, pairs) > .12) return unchanged("continuous-tone");
  // Halftone/dithered photographs have hard binary edges, rather than continuous-tone gradients.
  if (isolated / Math.max(1, dark) > .04 || darkTransitions / Math.max(1, dark) > .20) return unchanged("halftone-texture");
  const flatInk = [...nonPaperColors.values()].sort((a, b) => b - a).slice(0, 24).reduce((sum, value) => sum + value, 0) / Math.max(1, ink);
  if (flatInk < .80) return unchanged("continuous-tone");
  const paletteCoverage = [...colors.values()].sort((a, b) => b - a).slice(0, 24).reduce((sum, value) => sum + value, 0) / count;
  if (paletteCoverage < .99) return unchanged("complex-palette");
  const output = new Uint8ClampedArray(data);
  for (let at = 0; at < output.length; at += 4) {
    const maximum = Math.max(data[at], data[at + 1], data[at + 2]);
    const minimum = Math.min(data[at], data[at + 1], data[at + 2]);
    // Pale neutral node fills can have a small scanner/rendering tint. Saturated source colors stay exact.
    if (maximum !== minimum && !(maximum - minimum <= 18 && minimum >= 160) && !(maximum - minimum <= 24 && maximum <= 128)) continue;
    const value = Math.round((data[at] + data[at + 1] + data[at + 2]) / 3);
    const inkWeight = value >= 160 ? 0 : value <= 128 ? 1 : (160 - value) / 32;
    for (let channel = 0; channel < 3; channel++) output[at + channel] = Math.round(palette.surface[channel] * (1 - inkWeight) + palette.ink[channel] * inkWeight);
  }
  return { data: output, adapted: true, reason: "flat-diagram" };
}

/** Resolve the host's actual computed palette and make a memory-only display PNG. */
export async function themeSourceDiagramBlob(blob: Blob, host: HTMLElement | null, sourceText: string): Promise<{ blob: Blob; adapted: boolean }> {
  if (!host || typeof createImageBitmap !== "function") return { blob, adapted: false };
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(blob);
    if (bitmap.width * bitmap.height > 4_000_000) return { blob, adapted: false };
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { blob, adapted: false };
    const style = getComputedStyle(host);
    const color = (css: string): [number, number, number] => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = css; context.fillRect(0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      return [pixel[0], pixel[1], pixel[2]];
    };
    const palette = { surface: color(style.backgroundColor), ink: color(style.color) };
    context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const themed = themeSourceDiagram(image, palette, sourceText);
    if (!themed.adapted) return { blob, adapted: false };
    image.data.set(themed.data); context.putImageData(image, 0, 0);
    const display = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    return display ? { blob: display, adapted: true } : { blob, adapted: false };
  } catch { return { blob, adapted: false }; }
  finally { bitmap?.close(); }
}
