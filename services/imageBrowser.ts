import { LocalizedError } from './i18n/errors.ts';
import { t } from './i18n/core.ts';
import { canvasToBlob } from './pdfShared';

export interface PreparedPdfImageAsset {
  file: File;
  previewUrl: string;
  aspectRatio: number;
}

const loadImageElement = (file: File): Promise<{ image: HTMLImageElement; url: string }> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new LocalizedError("image-browser.image.could.not.be.decoded.7984a8"));
    };
    image.src = url;
  });

const normalizeImageAsset = async (file: File, rotation = 0) => {
  const { image, url } = await loadImageElement(file);
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const canvas = document.createElement('canvas');
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const swapsAxes = normalizedRotation === 90 || normalizedRotation === 270;
  canvas.width = swapsAxes ? sourceHeight : sourceWidth;
  canvas.height = swapsAxes ? sourceWidth : sourceHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    URL.revokeObjectURL(url);
    throw new LocalizedError("image-browser.canvas.context.unavailable.f925e4");
  }

  try {
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(normalizedRotation * Math.PI / 180);
    context.drawImage(image, -sourceWidth / 2, -sourceHeight / 2);
  } finally {
    URL.revokeObjectURL(url);
  }

  const outputType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const width = canvas.width;
  const height = canvas.height;
  const blob = await canvasToBlob(canvas, outputType, outputType === 'image/jpeg' ? 0.94 : undefined);
  canvas.width = 0;
  canvas.height = 0;
  const extension = outputType === 'image/jpeg' ? 'jpg' : 'png';
  return {
    file: new File([blob], `${file.name.replace(/\.[^/.]+$/, '')}.${extension}`, { type: outputType }),
    width,
    height,
  };
};

export const normalizeImageFile = async (file: File, rotation = 0): Promise<File> =>
  (await normalizeImageAsset(file, rotation)).file;

export const preparePdfImageAsset = async (file: File): Promise<PreparedPdfImageAsset> => {
  // Drawing through the browser image decoder normalizes EXIF orientation before pdf-lib sees the pixels.
  // Raw JPEG embedding otherwise displays some phone photos sideways in the exported PDF.
  const normalized = await normalizeImageAsset(file);

  return {
    file: normalized.file,
    previewUrl: URL.createObjectURL(normalized.file),
    aspectRatio: normalized.width / normalized.height,
  };
};

export const rotatePreparedPdfImageAsset = async (file: File, rotation = 90): Promise<PreparedPdfImageAsset> => {
  const normalized = await normalizeImageAsset(file, rotation);
  return {
    file: normalized.file,
    previewUrl: URL.createObjectURL(normalized.file),
    aspectRatio: normalized.width / normalized.height,
  };
};

export const getContainedImageSize = (
  aspectRatio: number,
  maxFraction: number,
  pageAspect = 210 / 297,
) => {
  let width = maxFraction;
  let height = (width * pageAspect) / aspectRatio;

  if (height > maxFraction) {
    height = maxFraction;
    width = (height * aspectRatio) / pageAspect;
  }

  return { width, height };
};
