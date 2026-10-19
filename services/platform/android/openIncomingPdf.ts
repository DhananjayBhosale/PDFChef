import { LocalizedError } from '../../i18n/errors.ts';
import type { WorkspacePlatform } from '../contracts.ts';

/** Only a validated external-intent event calls this; picker imports stay in their tool. */
export const openIncomingAndroidPdf = async (
  platform: WorkspacePlatform,
  ref: string,
  openWeb: (file: File, toolPath: string) => void,
  // Closing the native reader ends the hand-over; the caller decides where that leads.
  onClosed: () => void = () => undefined,
): Promise<void> => {
  const record = (await platform.records.list()).find(item => item.document?.ref === ref);
  if (!record?.available || record.document?.mimeType !== 'application/pdf') {
    throw new LocalizedError("open-incoming-pdf.error.c42046a644");
  }
  let toolPath = '/view';
  if (platform.pdfReader?.isEligible(record.document)) {
    try {
      const result = await platform.pdfReader.open(record.document);
      if (result.action === 'closed') {
        onClosed();
        return;
      }
      toolPath = result.toolPath;
    } catch {
      // An unavailable native renderer can still use the shared web viewer.
    }
  }
  openWeb(await platform.reopen(record), toolPath);
};
