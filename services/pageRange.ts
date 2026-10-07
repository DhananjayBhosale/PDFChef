import { LocalizedError } from './i18n/errors.ts';
import { t } from './i18n/core.ts';
const MAX_PAGE_RANGE_INPUT_LENGTH = 512;
const MAX_PAGE_RANGE_TOKENS = 256;

/**
 * Parses a user-entered 1-based page list without doing work outside the
 * document bounds. Validate range endpoints before expansion: malformed input
 * such as `1-999999999` must be rejected in constant time, not looped over.
 */
export const parseBoundedPageRange = (value: string, totalPages: number): number[] => {
  const normalized = value.trim()
    .replace(/[\u2010-\u2015\u2212\ufe63\uff0d]/g, '-')
    .replace(/[\u060c\u3001\uff0c]/g, ',')
    .replace(/[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f\uff10-\uff19]/g, (digit) => {
      const code = digit.charCodeAt(0);
      const zero = code >= 0xff10 ? 0xff10 : code >= 0x0966 ? 0x0966 : code >= 0x06f0 ? 0x06f0 : 0x0660;
      return String(code - zero);
    });
  if (!normalized) throw new LocalizedError("page-range.enter.a.page.or.range.for.example.1e4311");
  if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
    throw new LocalizedError("page-range.load.a.pdf.before.entering.a.page.1396f8");
  }
  if (normalized.length > MAX_PAGE_RANGE_INPUT_LENGTH) {
    throw new LocalizedError("page-range.that.page.range.is.too.long.use.b8cb1e");
  }

  const tokens = normalized.split(',');
  if (tokens.length > MAX_PAGE_RANGE_TOKENS) {
    throw new LocalizedError("page-range.that.page.range.has.too.many.groups.07b7dd");
  }

  const pages = new Set<number>();
  for (const rawToken of tokens) {
    const token = rawToken.trim();
    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
    const singleMatch = token.match(/^\d+$/);

    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        throw new LocalizedError("page-range.is.not.a.safe.page.range.468e19", { v0: token });
      }
      if (start > end) throw new LocalizedError("page-range.page.range.must.run.from.low.to.6d2356", { v0: token });
      if (start < 1 || end > totalPages) {
        const invalid = start < 1 ? start : end;
        throw new LocalizedError("page-range.page.is.outside.this.pdf.1.a300a7", { v0: invalid, v1: totalPages });
      }
      for (let page = start; page <= end; page += 1) pages.add(page - 1);
      continue;
    }

    if (singleMatch) {
      const page = Number(token);
      if (!Number.isSafeInteger(page) || page < 1 || page > totalPages) {
        throw new LocalizedError("page-range.page.is.outside.this.pdf.1.a300a7", { v0: token, v1: totalPages });
      }
      pages.add(page - 1);
      continue;
    }

    throw new LocalizedError("page-range.is.not.a.valid.page.or.range.fd01be", { v0: token || rawToken });
  }

  return [...pages].sort((left, right) => left - right);
};
