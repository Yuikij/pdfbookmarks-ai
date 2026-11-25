import { readFile } from 'node:fs/promises';
import { PDFName, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { PdfError } from './files.js';

let fontBytes;
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;

function truncateToWidth(text, font, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const chars = [...text];
  let left = 0;
  let right = chars.length;
  while (left < right) {
    const middle = Math.ceil((left + right) / 2);
    const label = chars.slice(0, middle).join('') + '…';
    if (font.widthOfTextAtSize(label, size) <= maxWidth) left = middle;
    else right = middle - 1;
  }
  return chars.slice(0, left).join('') + '…';
}

async function selectFonts(doc, titles) {
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const standard = new Set(regular.getCharacterSet());
  const chars = new Set([...titles.join('…')].map((char) => char.codePointAt(0)));
  if (!cjk.test(titles.join('')) && [...chars].every((code) => standard.has(code))) return [regular, bold];

  fontBytes ??= readFile(new URL('../fonts/DroidSansFallbackFull.ttf', import.meta.url));
  doc.registerFontkit(fontkit);
  const embedded = await doc.embedFont(await fontBytes, { subset: true });
  const supported = new Set(embedded.getCharacterSet());
  const missing = [...chars].filter((code) => !supported.has(code));
  if (missing.length) {
    throw new PdfError('UNSUPPORTED_TOC_GLYPHS', 'Some characters cannot be shown in the printed TOC. Keep them in bookmark-only mode or use display titles supported by the font.', { characters: missing.slice(0, 12).map((code) => String.fromCodePoint(code)) });
  }
  return [embedded, embedded];
}

export async function insertTocPages(doc, bookmarks, options) {
    const { beforePage: clampedInsertAt, title } = options;
    const srcPageCount = doc.getPageCount();
    const entries = bookmarks.map(({ title, sourcePage, depth }) => ({ title, page: sourcePage, depth }));
    const [font, titleFont] = await selectFonts(doc, [title, ...entries.map(entry => entry.title)]);
    // Use the page next to the insertion as the TOC paper size.
    const refPage = doc.getPage(Math.min(clampedInsertAt - 1, srcPageCount - 1));
    const { width: pageW, height: pageH } = refPage.getSize();
    if (pageW < 240 || pageH < 250) throw new PdfError('PAGE_TOO_SMALL', 'Insert the directory before a page at least 240 × 250 points.');
    const margin = { top: 58, bottom: 44, left: 40, right: 40 };
    const titleSize = 22;
    const titleBlockH = titleSize + 34;
    const sizeFor = d => (d === 1 ? 12 : d === 2 ? 10.5 : 9.5);
    const lineHFor = d => (d === 1 ? 25 : d === 2 ? 21 : 19);
    const gapBeforeL1 = 7; // 一级条目前的额外间距（分组感）
    const indentFor = d => Math.min(d - 1, 8) * Math.min(14, (pageW - 180) / 13);

    // Paginate before numbering links so the destination shift is known.
    const usableH = pageH - margin.top - margin.bottom;
    const tocPages = []; // 每页的条目列表
    let current = [];
    let used = titleBlockH; // 第一页含标题块
    for (const e of entries) {
        const lh = lineHFor(e.depth) + (e.depth === 1 && current.length > 0 ? gapBeforeL1 : 0);
        if (used + lh > usableH && current.length > 0) {
            tocPages.push(current);
            current = [];
            used = 0;
        }
        current.push(e);
        used += lh;
    }
    if (current.length > 0) tocPages.push(current);
    const tocPageCount = tocPages.length;

    // Original pages at or after the insertion keep their identities and shift in order.
    const finalPageOf = (page) => (page >= clampedInsertAt ? page + tocPageCount : page);

    const insertedPages = [];
    for (let i = 0; i < tocPageCount; i++) {
        insertedPages.push(doc.insertPage(clampedInsertAt - 1 + i, [pageW, pageH]));
    }
    const pageRefOfFinal = (finalPage) => doc.getPage(finalPage - 1).ref;

    const dotW = font.widthOfTextAtSize('.', 10);
    const textColor = rgb(0.13, 0.13, 0.13);
    const dimColor = rgb(0.45, 0.45, 0.45);

    for (let pi = 0; pi < tocPageCount; pi++) {
        const page = insertedPages[pi];
        const annots = [];
        let y = pageH - margin.top;

        if (pi === 0) {
            page.drawText(truncateToWidth(title, titleFont, titleSize, pageW - margin.left - margin.right), {
                x: margin.left,
                y: y - titleSize,
                size: titleSize,
                font: titleFont,
                color: textColor,
            });
            page.drawLine({
                start: { x: margin.left, y: y - titleSize - 10 },
                end: { x: pageW - margin.right, y: y - titleSize - 10 },
                thickness: 1,
                color: rgb(0.8, 0.8, 0.8),
            });
            y -= titleBlockH;
        }

        for (const e of tocPages[pi]) {
            const size = sizeFor(e.depth);
            const lh = lineHFor(e.depth) + (e.depth === 1 && e !== tocPages[pi][0] ? gapBeforeL1 : 0);
            y -= lh;

            const finalPage = finalPageOf(e.page);
            const numText = String(finalPage);
            const numW = font.widthOfTextAtSize(numText, size);
            const indent = indentFor(e.depth);
            const textX = margin.left + indent;
            const numX = pageW - margin.right - numW;
            const maxTitleW = numX - textX - 24;

            const label = truncateToWidth(e.title, font, size, maxTitleW);
            const labelW = font.widthOfTextAtSize(label, size);

            page.drawText(label, {
                x: textX, y, size, font,
                color: e.depth === 1 ? textColor : dimColor,
            });

            // Leader dots fit between the label and page number.
            const leadStart = textX + labelW + 6;
            const leadEnd = numX - 6;
            if (leadEnd - leadStart > dotW * 2) {
                const nDots = Math.floor((leadEnd - leadStart) / (dotW * 2));
                page.drawText('. '.repeat(nDots), {
                    x: leadStart, y, size: 10, font,
                    color: rgb(0.62, 0.62, 0.62),
                });
            }

            page.drawText(numText, {
                x: numX, y, size, font,
                color: e.depth === 1 ? textColor : dimColor,
            });

            // The whole row is an internal link.
            const annot = doc.context.obj({
                Type: 'Annot',
                Subtype: 'Link',
                Rect: [margin.left, y - 4, pageW - margin.right, y + size + 4],
                Border: [0, 0, 0],
                A: {
                    S: 'GoTo',
                    D: [pageRefOfFinal(finalPage), PDFName.of('XYZ'), null, null, null],
                },
            });
            annots.push(doc.context.register(annot));
        }

        if (annots.length > 0) {
            page.node.set(PDFName.of('Annots'), doc.context.obj(annots));
        }

        if (tocPageCount > 1) {
            const footer = `${pi + 1} / ${tocPageCount}`;
            const fw = font.widthOfTextAtSize(footer, 9);
            page.drawText(footer, {
                x: (pageW - fw) / 2, y: margin.bottom - 26, size: 9, font, color: dimColor,
            });
        }
    }

    return { tocPageCount, targetPages: entries.map(entry => finalPageOf(entry.page)), finalPageOf };
}
