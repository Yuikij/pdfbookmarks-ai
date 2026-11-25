#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createFileAccess, errorResult, PdfError, saveNewFile } from './files.js';
import { runTool, tools } from './tools.js';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const help = `PDFBookmarks ${version}
  pdfbookmarks-mcp [serve] --root /path/to/pdfs
  pdfbookmarks-mcp tools
  pdfbookmarks-mcp call <tool> --root /path/to/pdfs --json '{"path":"book.pdf"}'

Repeat --root to allow multiple folders. With no --root, CLI calls use the
working directory and the server uses MCP roots from the client.
Add --image-out preview.jpg to write a rendered page instead of returning base64.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { root: { type: 'string', multiple: true }, 'image-out': { type: 'string' }, json: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } }
  });
  const [command = 'serve', name, ...extra] = positionals;
  if (values.help) return process.stdout.write(help);
  if (values.version) return process.stdout.write(`${version}\n`);
  if (command === 'tools' && !name) {
    return process.stdout.write(JSON.stringify(Object.entries(tools).map(([toolName, tool]) => ({
      name: toolName, description: tool.description, inputSchema: z.toJSONSchema(tool.inputSchema, { target: 'draft-7' })
    })), null, 2) + '\n');
  }
  const roots = (values.root ?? [process.cwd()]).map((root) => path.resolve(root));
  if (command === 'serve' && !name && !values.json && !values['image-out']) {
    const { serve } = await import('./server.js');
    return serve(values.root ? await createFileAccess(roots) : null, version);
  }
  if (command !== 'call' || !name || extra.length || !values.json) {
    throw new PdfError('INVALID_COMMAND', 'Run --help for usage.');
  }
  let args;
  try {
    args = JSON.parse(values.json);
  } catch {
    throw new PdfError('INVALID_JSON', '--json must be a JSON object.');
  }
  if (values['image-out'] && name !== 'pdf_render_page') {
    throw new PdfError('INVALID_COMMAND', '--image-out only works with pdf_render_page.');
  }
  const files = await createFileAccess(roots);
  const result = await runTool(files, name, args);
  if (values['image-out'] && result.image) {
    const target = await files.output(values['image-out'], ['.jpg', '.jpeg']);
    await saveNewFile(target, Buffer.from(result.image, 'base64'));
    result.imagePath = target;
    delete result.image;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.error) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const { code, message } = errorResult(error);
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
}
