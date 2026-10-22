import { LocalizedError } from './i18n/errors.ts';
import {
  IMAGE_HEADER_BYTES,
  ImageOpenError,
  problemAfterFailedDecode,
  problemBeforeDecode,
  readImageDimensions,
} from './imageIntake.ts';
import { photoPixelCap, planImageNormalization } from './imageNormalization.ts';
import { canvasToBlob } from './pdfShared';

export interface PreparedPdfImageAsset {
  file: File;
  previewUrl: string;
  aspectRatio: number;
}

export interface ImageNormalizationOptions {
  rotation?: number;
  /** A smaller cap for pictures that only ever print small. */
  maxPixels?: number;
  /** Also make a small copy for an on-screen thumbnail, so the list never decodes full photos. */
  previewMaxPixels?: number;
}

const loadImageElement = async (file: File): Promise<{ image: HTMLImageElement; url: string }> => {
  const size = readImageDimensions(new Uint8Array(await file.slice(0, IMAGE_HEADER_BYTES).arrayBuffer()));
  const refused = problemBeforeDecode(size);
  if (refused) throw new ImageOpenError(refused);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      // HEIC, AVIF and the like have no size this reader knows, so the decoder's answer counts too.
      const late = problemBeforeDecode({ width: image.naturalWidth, height: image.naturalHeight });
      if (!late) {
        resolve({ image, url });
        return;
      }
      URL.revokeObjectURL(url);
      reject(new ImageOpenError(late));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ImageOpenError(problemAfterFailedDecode(size)));
    };
    image.src = url;
  });
};

const normalizeImageAsset = async (file: File, options: ImageNormalizationOptions = {}) => {
  const { rotation = 0, previewMaxPixels } = options;
  const maxPixels = options.maxPixels ?? await photoPixelCap();
  const { image, url } = await loadImageElement(file);
  // The plan decides the pixel size and the encoding; the canvas only ever holds that many pixels.
  const plan = planImageNormalization(image.naturalWidth, image.naturalHeight, file.type, maxPixels);
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
  let preview: Blob | null = null;
  if (previewMaxPixels) {
    const small = planImageNormalization(width, height, outputType, previewMaxPixels);
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = small.width;
    previewCanvas.height = small.height;
    const previewContext = previewCanvas.getContext('2d');
    if (previewContext) {
      previewContext.imageSmoothingQuality = 'high';
      previewContext.drawImage(canvas, 0, 0, small.width, small.height);
      preview = await canvasToBlob(previewCanvas, outputType, small.quality);
    }
    previewCanvas.width = 0;
    previewCanvas.height = 0;
  }
  canvas.width = 0;
  canvas.height = 0;
  const extension = outputType === 'image/jpeg' ? 'jpg' : 'png';
  const normalized = new File([blob], `${file.name.replace(/\.[^/.]+$/, '')}.${extension}`, { type: outputType });
  return {
    file: normalized,
    preview: preview ?? normalized,
    width,
    height,
  };
};

export const normalizeImageFile = async (file: File, options?: ImageNormalizationOptions): Promise<File> =>
  (await normalizeImageAsset(file, options)).file;

export const preparePdfImageAsset = async (
  file: File,
  options?: Pick<ImageNormalizationOptions, 'previewMaxPixels'>,
): Promise<PreparedPdfImageAsset> => {
  // Drawing through the browser image decoder normalizes EXIF orientation before pdf-lib sees the pixels.
  // Raw JPEG embedding otherwise displays some phone photos sideways in the exported PDF.
  const normalized = await normalizeImageAsset(file, options);

  return {
    file: normalized.file,
    previewUrl: URL.createObjectURL(normalized.preview),
    aspectRatio: normalized.width / normalized.height,
  };
};

export const rotatePreparedPdfImageAsset = async (file: File, rotation = 90): Promise<PreparedPdfImageAsset> => {
  const normalized = await normalizeImageAsset(file, { rotation });
  return {
    file: normalized.file,
    previewUrl: URL.createObjectURL(normalized.preview),
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
