import { createRequire } from 'node:module';
import path from 'node:path';
import { PdfError } from './files.js';

const require = createRequire(import.meta.url);
let pdfjsPromise;
const maxResultNodes = 2000;

export async function withPdf(bytes, fn) {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await pdfjsPromise;
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const loading = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    cMapUrl: path.join(root, 'cmaps') + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep,
    wasmUrl: path.join(root, 'wasm') + path.sep,
    useWorkerFetch: false,
    isEvalSupported: false,
    enableXfa: false,
    maxImageSize: 32_000_000,
    canvasMaxAreaInBytes: 32_000_000 * 4
  });
  try {
    return await fn(await loading.promise);
  } finally {
    await loading.destroy();
  }
}

export function checkPage(pdf, page) {
  if (page < 1 || page > pdf.numPages) {
    throw new PdfError('PAGE_OUT_OF_RANGE', `Physical page ${page} is outside 1–${pdf.numPages}.`);
  }
}

export async function resolvePage(pdf, dest) {
  if (!dest) return null;
  try {
    const resolved = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || resolved.length === 0) return null;
    const ref = resolved[0];
    const page = Number.isInteger(ref) ? ref + 1 : (await pdf.getPageIndex(ref)) + 1;
    return page >= 1 && page <= pdf.numPages ? page : null;
  } catch {
    return null;
  }
}

export async function readOutline(pdf, limit = maxResultNodes) {
  const outline = (await pdf.getOutline()) ?? [];
  const flat = [];
  let truncated = false;
  async function walk(items, depth, parent) {
    for (const item of items) {
      if (flat.length >= limit || depth > 64) {
        truncated = true;
        return;
      }
      const index = flat.length + 1;
      flat.push({ title: item.title, page: await resolvePage(pdf, item.dest), depth, parent });
      if (item.items?.length) await walk(item.items, depth + 1, index);
    }
  }
  await walk(outline, 1, null);
  return { bookmarks: flat, bookmarksTruncated: truncated };
}

export async function readPageText(pdf, physicalPage, characterLimit) {
  checkPage(pdf, physicalPage);
  const page = await pdf.getPage(physicalPage);
  const { items } = await page.getTextContent();
  const lines = [];
  let line = '';
  let previous;
  for (const item of items) {
    if (!('str' in item)) continue;
    if (previous && item.str) {
      const lineGap = Math.abs(previous.transform[5] - item.transform[5]);
      const threshold = Math.max(2, Math.abs(item.height || previous.height) * 0.45);
      if (lineGap > threshold && line.trim()) {
        lines.push(line.trimEnd());
        line = '';
      } else if (line && item.transform[4] - previous.transform[4] - previous.width > 1 && !/\s$/.test(line)) {
        line += ' ';
      }
    }
    line += item.str;
    if (item.hasEOL) {
      if (line.trim()) lines.push(line.trimEnd());
      line = '';
    }
    previous = item;
  }
  if (line.trim()) lines.push(line.trimEnd());
  const text = lines.join('\n');
  return {
    page: physicalPage,
    text: text.slice(0, characterLimit),
    truncated: text.length > characterLimit,
    textLayer: text.trim() ? (text.trim().length >= 40 ? 'present' : 'sparse') : 'empty'
  };
}

export async function renderPage(pdf, physicalPage, maxPixels, crop) {
  checkPage(pdf, physicalPage);
  const page = await pdf.getPage(physicalPage);
  const base = page.getViewport({ scale: 1 });
  const widthFraction = crop?.width ?? 1;
  const heightFraction = crop?.height ?? 1;
  const regionWidth = base.width * widthFraction;
  const regionHeight = base.height * heightFraction;
  const scale = Math.min(6, maxPixels / Math.max(regionWidth, regionHeight));
  const viewport = page.getViewport({ scale, offsetX: -base.width * (crop?.left ?? 0) * scale, offsetY: -base.height * (crop?.top ?? 0) * scale });
  const width = Math.max(1, Math.round(regionWidth * scale));
  const height = Math.max(1, Math.round(regionHeight * scale));
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(width, height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
  const data = canvas.toBuffer('image/jpeg', 83);
  return { data, width, height, page: physicalPage, crop: crop ?? null, mimeType: 'image/jpeg' };
}
