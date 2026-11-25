import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { createFileAccess } from '../src/files.js';
import { runTool } from '../src/tools.js';

const project = new URL('../', import.meta.url);
const fontPath = fileURLToPath(new URL('fonts/DroidSansFallbackFull.ttf', project));
GlobalFonts.registerFromPath(fontPath, 'Demo');
const dir = path.resolve(process.argv[2] ?? 'examples');
await mkdir(dir, { recursive: true });

const source = await PDFDocument.create();
const canvas = createCanvas(900, 1120);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#f5f2e8';
ctx.fillRect(0, 0, 900, 1120);
ctx.fillStyle = '#172231';
ctx.font = '64px Demo';
ctx.fillText('目 录', 94, 166);
ctx.strokeStyle = '#535a62';
ctx.beginPath();
ctx.moveTo(96, 213);
ctx.lineTo(800, 213);
ctx.stroke();
ctx.font = '35px Demo';
const sections = [
  ['第一章  研究简介', '1', 1],
  ['1.1  研究问题', '2', 2],
  ['第二章  样本与方法', '3', 1],
  ['2.1  样本来源', '4', 2],
  ['2.2  分析过程', '5', 2],
  ['第三章  研究发现', '6', 1]
];
for (const [index, [title, page, depth]] of sections.entries()) {
  const y = 300 + index * 82;
  const x = depth === 1 ? 96 : 143;
  ctx.fillText(title, x, y);
  ctx.fillText(page, 767, y);
  const dots = Math.floor((746 - x - ctx.measureText(title).width) / ctx.measureText('. ').width);
  ctx.fillText('. '.repeat(Math.max(0, dots)), x + ctx.measureText(title).width + 12, y);
}
ctx.fillStyle = '#465161';
ctx.font = '25px Demo';
ctx.fillText('示例文档 · 图像目录', 96, 1010);
const raster = await source.embedJpg(canvas.toBuffer('image/jpeg', 90));
source.addPage([450, 560]).drawImage(raster, { x: 0, y: 0, width: 450, height: 560 });
source.registerFontkit(fontkit);
const font = await source.embedFont(await readFile(fontPath), { subset: true });
source.addPage([450, 560]).drawText('研究方法手册', { x: 45, y: 462, size: 28, font });
for (const [title, number] of sections) {
  const page = source.addPage([450, 560]);
  page.drawText(title, { x: 45, y: 455, size: 24, font });
  page.drawText(number, { x: 218, y: 30, size: 12, font });
}
await writeFile(path.join(dir, 'scanned-contents.pdf'), await source.save());

const files = await createFileAccess([dir]);
const call = async (tool, input) => {
  const result = await runTool(files, tool, input);
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result;
};
const input = {
  path: 'scanned-contents.pdf',
  entries: sections.map(([title, printedPage, depth]) => ({ title, printedPage, depth })),
  pageMapping: { mode: 'offset', offset: 2 },
  insertToc: { beforePage: 1, title: '可点击目录' }
};
const { planId, sourceSha256 } = await call('pdf_plan_bookmarks', input);
const result = await call('pdf_write_bookmarks', {
  ...input, planId, sourceSha256, outputPath: 'with-bookmarks.pdf'
});
for (const [pdf, image] of [['scanned-contents.pdf', 'before.jpg'], ['with-bookmarks.pdf', 'after.jpg']]) {
  const output = await call('pdf_render_page', { path: pdf, page: 1, maxPixels: 1000 });
  await writeFile(path.join(dir, image), Buffer.from(output.image, 'base64'));
}
console.log(JSON.stringify(result));
