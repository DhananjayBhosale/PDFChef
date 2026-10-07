import { formatDate, formatNumber, formatPercent, getLocale, t } from './i18n/core.ts';

export interface ComparisonReportInput {
  generatedAt: Date;
  fileA: { name: string; pageCount: number; sizeBytes: number };
  fileB: { name: string; pageCount: number; sizeBytes: number };
  pageCountEqual: boolean;
  firstPageTextEqual: boolean | null;
  firstPageSignatureA: string;
  firstPageSignatureB: string;
  pageSignaturesA: string[];
  pageSignaturesB: string[];
  pagesCompared: number;
  identicalPageCount: number;
  differentPages: number[];
  unavailablePages: number[];
  matchRatio: number | null;
  commonPages: number;
}

const reportDateOptions: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
};

/** Build the human-readable comparison report without rewriting source text or excerpts. */
export function createComparisonReport(input: ComparisonReportInput): string {
  const list = new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' });
  const formatPageList = (pages: number[]) => list.format(pages.map((page) => formatNumber(page)));
  const empty = t('compareReport.empty');
  const mismatchDetails = input.differentPages.slice(0, 20).map((pageNumber) => {
    const left = input.pageSignaturesA[pageNumber - 1] || empty;
    const right = input.pageSignaturesB[pageNumber - 1] || empty;
    return [
      t('compareReport.page', { v0: formatNumber(pageNumber) }),
      t('compareReport.extractedText', { v0: 'A', v1: left.slice(0, 180) }),
      t('compareReport.extractedText', { v0: 'B', v1: right.slice(0, 180) }),
    ].join('\n');
  }).join('\n\n');

  return [
    t('compareReport.title'),
    t('compareReport.generated', { v0: formatDate(input.generatedAt, reportDateOptions) }),
    '',
    t('compareReport.file', { v0: 'A', v1: input.fileA.name }),
    t('compareReport.pages', { v0: formatNumber(input.fileA.pageCount) }),
    t('compareReport.size', { v0: formatNumber(input.fileA.sizeBytes) }),
    '',
    t('compareReport.file', { v0: 'B', v1: input.fileB.name }),
    t('compareReport.pages', { v0: formatNumber(input.fileB.pageCount) }),
    t('compareReport.size', { v0: formatNumber(input.fileB.sizeBytes) }),
    '',
    t('compareReport.summary'),
    t('compareReport.pageCountEqual', { v0: t(input.pageCountEqual ? 'compareReport.yes' : 'compareReport.no') }),
    t('compareReport.firstPageTextEqual', {
      v0: input.firstPageTextEqual === null
        ? t('compareReport.unavailable')
        : t(input.firstPageTextEqual ? 'compareReport.yes' : 'compareReport.no'),
    }),
    '',
    t('compareReport.firstPageSignature', { v0: 'A' }),
    input.firstPageSignatureA || empty,
    '',
    t('compareReport.firstPageSignature', { v0: 'B' }),
    input.firstPageSignatureB || empty,
    '',
    t('compareReport.pageByPageDetail'),
    t('compareReport.whatWasCompared'),
    t('compareReport.pagesCompared', { v0: formatNumber(input.pagesCompared) }),
    t('compareReport.matchingPages', { v0: formatNumber(input.identicalPageCount) }),
    t('compareReport.differingPages', { v0: formatNumber(input.differentPages.length) }),
    t('compareReport.pagesWithoutText', { v0: formatNumber(input.unavailablePages.length) }),
    t('compareReport.matchShare', {
      v0: input.matchRatio === null ? t('compareReport.unavailable') : formatPercent(input.matchRatio),
    }),
    t('compareReport.noTextCaveat'),
    ...(input.pagesCompared < input.commonPages
      ? [t('compareReport.firstCommonPagesOnly', { v0: formatNumber(input.pagesCompared) })]
      : []),
    '',
    t('compareReport.differentExtractedPages'),
    input.differentPages.length > 0 ? formatPageList(input.differentPages) : t('compareReport.none'),
    '',
    t('compareReport.truncatedTextDetails'),
    mismatchDetails || t('compareReport.none'),
  ].join('\n');
}
