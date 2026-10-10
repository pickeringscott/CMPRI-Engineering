import sharp from "sharp";

const OCR_IMAGE_WIDTH = 1800;
const MAX_INPUT_PIXELS = 30_000_000;

export async function createRoomOperationsOcrCrops(input: Uint8Array): Promise<Buffer[]> {
  const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .jpeg({ quality: 95 })
    .toBuffer({ resolveWithObject: true });

  if (info.width < 300 || info.height < 300) {
    throw new Error("The uploaded report image is too small to read.");
  }

  const left = Math.floor(info.width * 0.015);
  const width = info.width - left * 2;
  const top = Math.floor(info.height * 0.04);
  const bottom = Math.ceil(info.height * 0.96);
  const middle = Math.floor((top + bottom) / 2);
  const overlap = Math.ceil(info.height * 0.025);
  const crops = [
    { top, height: middle - top + overlap },
    { top: middle - overlap, height: bottom - middle + overlap },
  ];

  return Promise.all(crops.map(({ top: cropTop, height }) =>
    sharp(data)
      .extract({ left, top: cropTop, width, height })
      .resize({ width: OCR_IMAGE_WIDTH })
      .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
      .toBuffer()
  ));
}

export async function createRoomOperationsRecoveryCrops(input: Uint8Array): Promise<Buffer[]> {
  const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .jpeg({ quality: 95 })
    .toBuffer({ resolveWithObject: true });

  if (info.width < 300 || info.height < 300) {
    throw new Error("The uploaded report image is too small to read.");
  }

  const left = Math.floor(info.width * 0.01);
  const width = info.width - left * 2;
  const top = Math.floor(info.height * 0.02);
  const bottom = Math.ceil(info.height * 0.98);
  const sectionHeight = (bottom - top) / 4;
  const overlap = Math.ceil(info.height * 0.08);
  const crops = Array.from({ length: 4 }, (_, index) => {
    const cropTop = Math.max(top, Math.floor(top + sectionHeight * index) - overlap);
    const cropBottom = Math.min(bottom, Math.ceil(top + sectionHeight * (index + 1)) + overlap);
    return { top: cropTop, height: cropBottom - cropTop };
  });

  return Promise.all(crops.map(({ top: cropTop, height }) =>
    sharp(data)
      .extract({ left, top: cropTop, width, height })
      .resize({ width: 2400 })
      .sharpen()
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      .toBuffer()
  ));
}
