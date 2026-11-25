import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function makeScan() {
  const pdf = await PDFDocument.create();
  const canvas = createCanvas(900, 1200);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 900, 1200);
  ctx.fillStyle = 'black';
  ctx.font = '36px sans-serif';
  const lines = ['TABLE OF CONTENTS', '1. Introduction ...................... 1', '    1.1 Method ........................ 2', '2. Results ............................... 3'];
  lines.forEach((line, index) => ctx.fillText(line, 70, 135 + index * 82));
  const image = await pdf.embedPng(canvas.toBuffer('image/png'));
  pdf.addPage([450, 600]).drawImage(image, { x: 0, y: 0, width: 450, height: 600 });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  for (const title of ['Title page', 'Introduction', 'Method', 'Results']) {
    pdf.addPage([450, 600]).drawText(title, { x: 42, y: 500, font: regular });
  }
  pdf.catalog.set(PDFName.of('PageLabels'), pdf.context.obj({ Nums: [0, { S: 'r' }, 2, { S: 'D' }] }));
  return pdf.save();
}

test('real stdio client renders a scan, plans Chinese outline and verifies a linked TOC', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pdfbookmarks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await makeScan();
  await writeFile(path.join(root, 'source.pdf'), source);
  const outside = path.join(os.tmpdir(), path.basename(root) + '-outside.pdf');
  await writeFile(outside, source);
  t.after(() => rm(outside, { force: true }));
  if (process.platform !== 'win32') await symlink(outside, path.join(root, 'external.pdf'));

  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--root', root], stderr: 'pipe' });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 5);
  assert.equal(tools.find(({ name }) => name === 'pdf_write_bookmarks').annotations.destructiveHint, false);

  const inspection = await call('pdf_inspect', { path: 'source.pdf' });
  assert.equal(inspection.structuredContent.pageCount, 5);
  assert.deepEqual(inspection.structuredContent.pageLabels.map(({ label }) => label), ['i', 'ii', '1', '2', '3']);
  assert.equal(inspection.structuredContent.sourceSha256, sha(source));
  const text = await call('pdf_read_pages', { path: 'source.pdf', pages: [1, 3] });
  assert.equal(text.structuredContent.pages[0].textLayer, 'empty');
  assert.match(text.structuredContent.pages[1].text, /Introduction/u);
  const crop = { left: 0.04, top: 0.04, width: 0.92, height: 0.47 };
  const vision = await call('pdf_render_page', { path: 'source.pdf', page: 1, crop });
  const jpeg = vision.content.find((item) => item.type === 'image');
  assert.equal(jpeg.mimeType, 'image/jpeg');
  assert.ok(Buffer.from(jpeg.data, 'base64').subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF])));
  assert.deepEqual(vision.structuredContent.crop, crop);

  const input = {
    path: 'source.pdf',
    entries: [
      { title: '第一章 简介', depth: 1, printedPage: '1' },
      { title: '研究方法', depth: 2, printedPage: '2' },
      { title: '第二章 结果', depth: 1, printedPage: '3' },
    ],
    pageMapping: { mode: 'offset', offset: 2 },
    insertToc: { title: '目录' }
  };
  const invalid = await call('pdf_plan_bookmarks', { ...input, pageMapping: { mode: 'offset', offset: 9 } });
  assert.equal(invalid.structuredContent.ready, false);
  assert.equal(invalid.structuredContent.issues[0].code, 'PAGE_OUT_OF_RANGE');
  const plan = (await call('pdf_plan_bookmarks', input)).structuredContent;
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.reviewAnchors.map(({ sourcePage }) => sourcePage), [3, 4, 5]);
  const editArgs = { ...input, outputPath: 'output.pdf', sourceSha256: plan.sourceSha256, planId: plan.planId };
  const altered = await call('pdf_write_bookmarks', { ...editArgs, insertToc: { title: 'Changed' } });
  assert.equal(altered.structuredContent.error.code, 'PLAN_CHANGED');
  const edited = await call('pdf_write_bookmarks', editArgs);
  assert.equal(edited.isError, undefined, JSON.stringify(edited.content));
  assert.equal(edited.structuredContent.tocLinkCount, 3);
  assert.equal(edited.structuredContent.verified, true);
  const output = await call('pdf_inspect', { path: 'output.pdf', bookmarkLimit: 2 });
  assert.deepEqual(output.structuredContent.bookmarks.map(({ title, page, depth }) => [title, page, depth]), [
    ['第一章 简介', 4, 1], ['研究方法', 5, 2]
  ]);
  assert.equal(output.structuredContent.nextOutlineOffset, 2);
  const repeat = await call('pdf_write_bookmarks', editArgs);
  assert.equal(repeat.structuredContent.error.code, 'OUTPUT_EXISTS');
  assert.equal(sha(await readFile(path.join(root, 'source.pdf'))), sha(source));

  const keep = { ...input, path: 'output.pdf', outlineMode: 'keep', entries: [{ title: 'New TOC', depth: 1, page: 4 }], insertToc: {} };
  const keepPlan = (await call('pdf_plan_bookmarks', keep)).structuredContent;
  const kept = await call('pdf_write_bookmarks', { ...keep, outputPath: 'keep.pdf', planId: keepPlan.planId, sourceSha256: keepPlan.sourceSha256 });
  assert.equal(kept.structuredContent.verified, true, JSON.stringify(kept.content));
  assert.equal(kept.structuredContent.bookmarkCount, 3);

  const blocked = await call('pdf_inspect', { path: outside });
  assert.equal(blocked.structuredContent.error.code, 'PATH_OUTSIDE_ROOT');
  if (process.platform !== 'win32') {
    const external = await call('pdf_inspect', { path: 'external.pdf' });
    assert.equal(external.structuredContent.error.code, 'PATH_OUTSIDE_ROOT');
  }
});

test('default server requires workspace roots and accepts a client-provided root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pdfbookmarks-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'example.pdf'), await makeScan());
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli] });
  const client = new Client({ name: 'roots-test', version: '1.0.0' }, { capabilities: { roots: {} } });
  t.after(() => client.close());
  const { ListRootsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  let roots = [];
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots }));
  await client.connect(transport);
  const args = { name: 'pdf_inspect', arguments: { path: 'example.pdf' } };
  assert.equal((await client.callTool(args)).structuredContent.error.code, 'ROOT_REQUIRED');
  roots = [{ uri: pathToFileURL(root).href }];
  assert.equal((await client.callTool(args)).structuredContent.pageCount, 5);
});
