import { LocalizedError } from './i18n/errors.ts';
import { t } from './i18n/core.ts';
import { planImageNormalization } from './imageNormalization.ts';
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
  // The plan decides the pixel size and the encoding; the canvas only ever holds that many pixels.
  const plan = planImageNormalization(image.naturalWidth, image.naturalHeight, file.type);
  const canvas = document.createElement('canvas');
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const swapsAxes = normalizedRotation === 90 || normalizedRotation === 270;
  canvas.width = swapsAxes ? plan.height : plan.width;
  canvas.height = swapsAxes ? plan.width : plan.height;

  const context = canvas.getContext('2d');
  if (!context) {
    URL.revokeObjectURL(url);
    throw new LocalizedError("image-browser.canvas.context.unavailable.f925e4");
  }

  try {
    if (plan.fill) {
      context.fillStyle = plan.fill;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.imageSmoothingQuality = 'high';
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(normalizedRotation * Math.PI / 180);
    context.drawImage(image, -plan.width / 2, -plan.height / 2, plan.width, plan.height);
  } finally {
    URL.revokeObjectURL(url);
  }

  const { outputType } = plan;
  const width = canvas.width;
  const height = canvas.height;
  const blob = await canvasToBlob(canvas, outputType, plan.quality);
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
