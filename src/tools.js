import { z } from 'zod';
import { errorResult } from './files.js';
import { readOutline, readPageText, renderPage, withPdf } from './read.js';
import { planBookmarks } from './plan.js';
import { writeBookmarks } from './edit.js';

const pdfPath = z.string().min(1).max(4096).describe('A local .pdf path, absolute or relative to the first allowed root.');
const physicalPage = z.number().int().min(1).max(1_000_000).describe('1-based physical PDF page, counting the cover as page 1.');
const entry = z.object({
  title: z.string().min(1).max(300),
  depth: z.number().int().min(1).max(16).describe('1 for top level, 2 for its child; no skipped levels.'),
  page: physicalPage.optional(),
  printedPage: z.string().trim().min(1).max(48).optional().describe('Page label visibly printed on the document, such as iv or 12.')
}).strict().refine(({ page, printedPage }) => (page === undefined) !== (printedPage === undefined), 'Supply exactly one of page or printedPage.');

const planShape = {
  path: pdfPath,
  entries: z.array(entry).min(1).max(1000).optional().describe('Use for visually transcribed, multilingual, or irregular tables of contents.'),
  tocText: z.string().min(1).max(120_000).optional().describe('Plain TOC text with one title and printed page per line.'),
  pageMapping: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('offset'),
      offset: z.number().int().min(-1_000_000).max(1_000_000).describe('Physical page minus printed page. Printed 1 on physical 13 means +12.')
    }).strict(),
    z.object({ mode: z.literal('labels') }).strict().describe('Match the PDF’s embedded page labels exactly, including Roman numerals.')
  ]).optional().describe('Required for printedPage or tocText. Use explicit physical pages for mixed numbering or multiple offsets.'),
  outlineMode: z.enum(['create', 'replace', 'keep']).default('create').describe('create requires an empty outline; replace explicitly replaces it; keep preserves it and requires insertToc.'),
  insertToc: z.object({
    beforePage: physicalPage.default(1).describe('Insert before this original physical page. Page count plus one appends it.'),
    title: z.string().trim().min(1).max(120).default('Table of Contents')
  }).strict().optional().describe('Also add printable pages with one internal PDF link per entry.')
};

const exactSource = ({ entries, tocText }) => (entries === undefined) !== (tocText === undefined);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

const crop = z.object({
  left: z.number().min(0).max(0.99),
  top: z.number().min(0).max(0.99),
  width: z.number().min(0.04).max(1),
  height: z.number().min(0.04).max(1)
}).strict().refine((region) => region.left + region.width <= 1.000001 && region.top + region.height <= 1.000001, 'The crop must fit inside the rendered page.');

const readOnly = { readOnlyHint: true, openWorldHint: false };
const newFile = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export const tools = {
  pdf_inspect: {
    title: 'Inspect PDF bookmarks and page labels',
    description: 'Start here for a local PDF. Return its physical page count, sampled embedded labels, an outline sample and the source fingerprint. Extra outline entries can be requested with outlineOffset. Embedded page labels may differ from numbers printed on a page.',
    inputSchema: z.object({
      path: pdfPath,
      bookmarkLimit: z.number().int().min(0).max(200).default(40),
      outlineOffset: z.number().int().min(0).max(1999).default(0)
    }).strict(),
    annotations: readOnly,
    async run(input, source) {
      return withPdf(source.bytes, async (pdf) => {
        const labels = await pdf.getPageLabels();
        const front = Array.from({ length: Math.min(10, pdf.numPages) }, (_, index) => index + 1);
        const tail = Array.from({ length: Math.max(0, Math.min(4, pdf.numPages - 10)) }, (_, index) => pdf.numPages - Math.min(4, pdf.numPages - 10) + index + 1);
        const outline = await readOutline(pdf, Math.min(2000, input.outlineOffset + input.bookmarkLimit + 1));
        const bookmarks = outline.bookmarks.slice(input.outlineOffset, input.outlineOffset + input.bookmarkLimit);
        const next = input.outlineOffset + bookmarks.length;
        return {
          pageCount: pdf.numPages, sourceSha256: source.sha256, hasEmbeddedPageLabels: Boolean(labels),
          pageLabels: [...front, ...tail].map((page) => ({ page, label: labels?.[page - 1] ?? null })),
          hasBookmarks: outline.bookmarks.length > 0 || outline.bookmarksTruncated,
          bookmarks, nextOutlineOffset: input.bookmarkLimit && next < Math.min(2000, outline.bookmarks.length + Number(outline.bookmarksTruncated)) ? next : null,
          outlineLimitReached: next >= 2000 && outline.bookmarksTruncated
        };
      });
    }
  },
  pdf_read_pages: {
    title: 'Read PDF text and find directory pages',
    description: 'Read the text layer of selected physical pages to locate a table of contents or verify a chapter destination. For empty or sparse pages, use pdf_render_page and visually read the image. This tool returns document text to the AI client.',
    inputSchema: z.object({
      path: pdfPath,
      pages: z.array(physicalPage).min(1).max(8),
      charactersPerPage: z.number().int().min(100).max(6000).default(2200)
    }).strict(),
    annotations: readOnly,
    async run(input, source) {
      return withPdf(source.bytes, async (pdf) => {
        const pages = [];
        const labels = await pdf.getPageLabels();
        for (const page of new Set(input.pages)) {
          pages.push({ ...await readPageText(pdf, page, input.charactersPerPage), label: labels?.[page - 1] ?? null });
        }
        return { sourceSha256: source.sha256, pages };
      });
    }
  },
  pdf_render_page: {
    title: 'Show one PDF page as an image',
    description: 'Render one local PDF page for visual reading, especially a scanned table of contents or a printed page number. Returns actual JPEG image content to the AI client. Crop coordinates are normalized from the top-left of the shown page. Use a crop to read small text.',
    inputSchema: z.object({
      path: pdfPath, page: physicalPage,
      maxPixels: z.number().int().min(500).max(2400).default(1600).describe('Maximum pixels on the longest output edge.'),
      crop: crop.optional()
    }).strict(),
    annotations: readOnly,
    async run(input, source) {
      const { data, ...render } = await withPdf(source.bytes, (pdf) => renderPage(pdf, input.page, input.maxPixels, input.crop));
      return { ...render, sourceSha256: source.sha256, image: data.toString('base64') };
    }
  },
  pdf_plan_bookmarks: {
    title: 'Preview PDF bookmark and TOC changes',
    description: 'Validate hierarchy, resolve printed page labels to physical pages, and preview without writing. Inspect reviewAnchors before editing. Fix all issues, then pass the exact same entries/settings, sourceSha256 and planId to pdf_write_bookmarks.',
    inputSchema: z.object(planShape).strict().refine(exactSource, 'Supply exactly one of entries or tocText.'),
    annotations: readOnly,
    async run(input, source) {
      const { bookmarks: _bookmarks, ...preview } = await planBookmarks(source, input);
      return preview;
    }
  },
  pdf_write_bookmarks: {
    title: 'Write verified bookmarks to a new PDF',
    description: 'Apply a clean plan using the same entries and settings. Saves a new PDF only after reopening it and checking every bookmark destination and generated TOC link. Always choose a new outputPath. Use replace only if the user requested replacing the existing outline.',
    inputSchema: z.object({
      ...planShape,
      outputPath: pdfPath,
      sourceSha256: digest,
      planId: digest
    }).strict().refine(exactSource, 'Supply exactly one of entries or tocText.'),
    annotations: newFile,
    async run(input, source, files) {
      return writeBookmarks(files, source, input);
    }
  }
};

export async function runTool(files, name, args) {
  const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
  if (!tool) return { error: { code: 'UNKNOWN_TOOL', message: 'Use tools to list available commands.' } };
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return { error: { code: 'INVALID_INPUT', message: 'Check the tool arguments.', details: parsed.error.issues } };
  }
  try {
    return await tool.run(parsed.data, await files.read(parsed.data.path), files);
  } catch (error) {
    return { error: errorResult(error) };
  }
}
