/** Header and footer text as each page prints it; light, so the live preview draws it without loading pdf-lib. */
export interface HeaderFooterOptions {
  headerText: string;
  footerText: string;
  fontSize: number;
  includePageNumbers: boolean;
}

export const interpolateHeaderFooterText = (value: string, pageNumber: number, totalPages: number) =>
  value.replaceAll('{n}', String(pageNumber)).replaceAll('{total}', String(totalPages));

/** The size in points, and the header and footer lines exactly as one page gets them (the live preview draws the same). */
export const headerFooterFontSize = (fontSize: number) => Math.max(8, Math.min(48, Number.isFinite(fontSize) ? fontSize : 10));
export const headerFooterLines = (options: HeaderFooterOptions, pageNumber: number, totalPages: number) => {
  const footerBase = options.footerText.trim();
  return {
    header: interpolateHeaderFooterText(options.headerText.trim(), pageNumber, totalPages),
    footer: interpolateHeaderFooterText(
      options.includePageNumbers && !footerBase ? 'Page {n} of {total}' : footerBase,
      pageNumber,
      totalPages,
    ),
  };
};
