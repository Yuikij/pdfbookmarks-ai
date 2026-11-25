import { createHash } from 'node:crypto';
import { PdfError } from './files.js';
import { checkPage, readOutline, withPdf } from './read.js';

const maxEntries = 1000;
const maxDepth = 16;

function parseText(text) {
  const rows = [];
  const issues = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const body = line.trim();
    if (!body || /^(?:table of contents|contents|目录|目次)[:：]?$/iu.test(body)) continue;
    const match = body.match(/^(.+?)(?:\s*[.．·…⋯‥_]{2,}\s*|\s{2,}|\s+)(\d+|[ivxlcdm]+)\s*$/iu);
    if (!match) {
      issues.push({ code: 'UNPARSED_LINE', line: index + 1, value: body.slice(0, 240) });
      continue;
    }
    const [, title, printedPage] = match;
    const decimal = title.match(/^(\d+(?:\.\d+)*)(?:[.、)]?\s+)/u);
    const depth = decimal ? decimal[1].split('.').length
      : /^第\s*[0-9一二三四五六七八九十百零〇]+\s*节/u.test(title) ? 2
      : 1 + Math.floor((line.match(/^\s*/u)?.[0] ?? '').replaceAll('\t', '  ').length / 2);
    rows.push({ title, printedPage, depth, line: index + 1 });
    if (rows.length > maxEntries) throw new PdfError('TOO_MANY_BOOKMARKS', 'Use at most 1,000 bookmarks per edit.');
  }
  return { rows, issues };
}

function mapPrintedPage(printedPage, pageMapping, labels) {
  if (pageMapping?.mode === 'labels') {
    const matches = (labels ?? []).flatMap((label, index) => label === printedPage ? [index + 1] : []);
    if (matches.length === 1) return matches[0];
    return matches.length > 1 ? 'AMBIGUOUS_PAGE_LABEL' : 'PAGE_LABEL_NOT_FOUND';
  }
  if (pageMapping?.mode === 'offset') {
    if (!/^\d+$/u.test(printedPage)) return 'NON_NUMERIC_PRINTED_PAGE';
    return Number(printedPage) + pageMapping.offset;
  }
  return 'PAGE_MAPPING_REQUIRED';
}

export async function planBookmarks(source, input, includeSourceState = false) {
  return withPdf(source.bytes, async (pdf) => {
    const { entries, tocText, pageMapping, outlineMode, insertToc } = input;
    if (outlineMode === 'keep' && !insertToc) throw new PdfError('NO_CHANGES', 'Keeping the outline requires a visible table of contents to insert.');
    if (insertToc && insertToc.beforePage !== pdf.numPages + 1) checkPage(pdf, insertToc.beforePage);
    const existing = await readOutline(pdf, includeSourceState && outlineMode === 'keep' ? 2000 : 1);
    const existingOutline = existing.bookmarks.length > 0;
    const { rows, issues } = entries ? { rows: entries, issues: [] } : parseText(tocText);
    if (outlineMode === 'create' && existingOutline) issues.unshift({ code: 'OUTLINE_EXISTS' });
    if (rows.length === 0) issues.push({ code: 'NO_BOOKMARKS' });
    const labels = pageMapping?.mode === 'labels' || (includeSourceState && insertToc) ? await pdf.getPageLabels() : null;
    const bookmarks = [];
    let previousDepth = 0;
    for (const [index, row] of rows.entries()) {
      const rowLocation = { entry: index + 1, ...(row.line && { line: row.line }) };
      const title = row.title.trim();
      const page = row.page ?? mapPrintedPage(row.printedPage, pageMapping, labels);
      if (!title || title.length > 300 || /[\u0000-\u001f\u007f]/u.test(title)) {
        issues.push({ code: 'INVALID_TITLE', ...rowLocation });
      }
      if (typeof page === 'string') {
        issues.push({ code: page, printedPage: row.printedPage, ...rowLocation });
      } else if (!Number.isSafeInteger(page) || page < 1 || page > pdf.numPages) {
        issues.push({ code: 'PAGE_OUT_OF_RANGE', page: Number.isFinite(page) ? page : null, ...rowLocation });
      }
      if (row.depth < 1 || row.depth > maxDepth || row.depth > previousDepth + 1) {
        issues.push({ code: 'INVALID_HIERARCHY', depth: row.depth, ...rowLocation });
      }
      previousDepth = row.depth;
      bookmarks.push({ title, sourcePage: typeof page === 'number' && Number.isFinite(page) ? page : null,
        depth: row.depth, ...(row.printedPage && { printedPage: row.printedPage }) });
    }
    const mustVerify = bookmarks.filter((bookmark) => Number.isSafeInteger(bookmark.sourcePage) && bookmark.sourcePage >= 1 && bookmark.sourcePage <= pdf.numPages);
    const anchors = mustVerify.length > 2 ? [mustVerify[0], mustVerify[Math.floor(mustVerify.length / 2)], mustVerify.at(-1)] : mustVerify;
    const planId = createHash('sha256').update(JSON.stringify({
      sha256: source.sha256, bookmarks, outlineMode, insertToc, pageMapping
    })).digest('hex');
    return {
      planId,
      ready: issues.length === 0,
      sourceSha256: source.sha256,
      sourcePageCount: pdf.numPages,
      existingOutline,
      outlineMode,
      insertToc: insertToc ?? null,
      bookmarkCount: bookmarks.length,
      sample: bookmarks.length <= 12 ? bookmarks : [...bookmarks.slice(0, 8), ...bookmarks.slice(-4)],
      reviewAnchors: anchors,
      issues: issues.slice(0, 30),
      issueCount: issues.length,
      bookmarks,
      ...(includeSourceState && { sourceState: { labels, outline: existing } }),
    };
  });
}
