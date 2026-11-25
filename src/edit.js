import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { PdfError, saveNewFile } from './files.js';
import { planBookmarks } from './plan.js';
import { readOutline, resolvePage, withPdf } from './read.js';
import { writeOutline } from './outline.js';
import { shiftPageLabels } from './page-labels.js';
import { insertTocPages } from './toc.js';

function hasDigitalSignature(doc) {
  if (doc.catalog.has(PDFName.of('Perms'))) return true;
  const form = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const queue = form?.lookupMaybe(PDFName.of('Fields'), PDFArray)?.asArray() ?? [];
  const seen = new Set();
  while (queue.length) {
    const field = doc.context.lookup(queue.pop());
    if (!(field instanceof PDFDict) || seen.has(field)) continue;
    seen.add(field);
    const value = doc.context.lookup(field.get(PDFName.of('V')));
    if (value instanceof PDFDict && value.has(PDFName.of('ByteRange'))) return true;
    const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) queue.push(...kids.asArray());
  }
  return false;
}

async function verifyOutput(bytes, plan, toc, input, originalOutline, originalLabels) {
  return withPdf(bytes, async (pdf) => {
    const pageCount = plan.sourcePageCount + toc.tocPageCount;
    if (pdf.numPages !== pageCount) return false;
    if (originalLabels) {
      const labels = await pdf.getPageLabels();
      if (!labels || !originalLabels.every((label, index) => labels[toc.finalPageOf(index + 1) - 1] === label)) return false;
    }
    const outline = await readOutline(pdf, Math.max(2000, plan.bookmarks.length));
    if (outline.bookmarksTruncated || outline.bookmarks.length !== originalOutline.length) return false;
    const expectedOutline = originalOutline.map(({ title, page, depth }) => ({
      title, depth, page: page === null ? null : toc.finalPageOf(page)
    }));
    if (!outline.bookmarks.every(({ title, depth, page }, index) => {
      const expected = expectedOutline[index];
      return title === expected.title && depth === expected.depth && page === expected.page;
    })) return false;

    const links = [];
    for (let pageIndex = 0; pageIndex < toc.tocPageCount; pageIndex++) {
      const page = await pdf.getPage(input.insertToc.beforePage + pageIndex);
      for (const annotation of await page.getAnnotations()) {
        if (annotation.subtype === 'Link') links.push(await resolvePage(pdf, annotation.dest));
      }
    }
    return links.length === toc.targetPages.length && links.every((page, index) => page === toc.targetPages[index]);
  });
}

export async function writeBookmarks(files, source, input) {
  if (source.sha256 !== input.sourceSha256) {
    throw new PdfError('SOURCE_CHANGED', 'The file differs from the planned PDF. Inspect it and run a new plan.');
  }
  const plan = await planBookmarks(source, input, true);
  if (plan.planId !== input.planId) throw new PdfError('PLAN_CHANGED', 'Plan these exact entries and settings before writing.');
  if (!plan.ready) throw new PdfError('PLAN_HAS_ISSUES', 'Resolve every issue before writing.', { issueCount: plan.issueCount, issues: plan.issues });
  const target = await files.output(input.outputPath);
  const doc = await PDFDocument.load(source.bytes, { updateMetadata: false, throwOnInvalidObject: true });
  if (hasDigitalSignature(doc)) throw new PdfError('SIGNED_PDF', 'This PDF has a digital signature. Supply an unsigned copy for editing.');
  const toc = input.insertToc ? await insertTocPages(doc, plan.bookmarks, input.insertToc)
    : { tocPageCount: 0, targetPages: [], finalPageOf: (page) => page };
  const originalLabels = toc.tocPageCount ? plan.sourceState.labels : null;
  if (originalLabels) shiftPageLabels(doc, input.insertToc.beforePage, toc.tocPageCount, originalLabels);
  let originalOutline;
  if (input.outlineMode === 'keep') {
    const existing = plan.sourceState.outline;
    if (existing.bookmarksTruncated) throw new PdfError('OUTLINE_TOO_LARGE', 'The existing outline is too large to verify completely.');
    originalOutline = existing.bookmarks;
  } else {
    originalOutline = plan.bookmarks.map(({ title, sourcePage, depth }) => ({ title, depth, page: sourcePage }));
    writeOutline(doc, originalOutline.map((row) => ({ ...row, outputPage: toc.finalPageOf(row.page) })));
  }

  const bytes = await doc.save({ updateFieldAppearances: false });
  if (!(await verifyOutput(bytes, plan, toc, input, originalOutline, originalLabels))) {
    throw new PdfError('OUTPUT_VERIFICATION_FAILED', 'The generated PDF failed its bookmark, page label, or TOC link checks. No output was written.');
  }
  await saveNewFile(target, bytes);
  return {
    outputPath: target, sourceSha256: source.sha256, pageCount: doc.getPageCount(),
    bookmarkCount: originalOutline.length, tocPages: toc.tocPageCount,
    tocLinkCount: toc.targetPages.length, verified: true
  };
}
