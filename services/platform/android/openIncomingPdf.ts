import { LocalizedError } from '../../i18n/errors.ts';
import type { WorkspacePlatform } from '../contracts.ts';

/**
 * Only a validated external-intent event calls this: the native reader already showed the
 * handed-over PDF and the person chose a tool, so the tool opens with that same copy.
 */
export const openIncomingAndroidPdf = async (
  platform: WorkspacePlatform,
  ref: string,
  toolPath: string,
  openWeb: (file: File, toolPath: string) => void,
): Promise<void> => {
  const record = (await platform.records.list()).find(item => item.document?.ref === ref);
  if (!record?.available || record.document?.mimeType !== 'application/pdf') {
    throw new LocalizedError("open-incoming-pdf.error.c42046a644");
  }
  openWeb(await platform.reopen(record), toolPath);
};
