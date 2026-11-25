import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const maxPdfBytes = 128 * 1024 * 1024;

export class PdfError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function errorResult(error) {
  if (error instanceof PdfError) {
    return { code: error.code, message: error.message, ...(error.details && { details: error.details }) };
  }
  if (error.code === 'ENOENT') return { code: 'PATH_NOT_FOUND', message: 'The file or its parent folder does not exist.' };
  if (error.code === 'EACCES' || error.code === 'EPERM') return { code: 'ACCESS_DENIED', message: 'The operating system denied access to the file or output folder.' };
  if (error.name === 'PasswordException') return { code: 'ENCRYPTED_PDF', message: 'Open an unencrypted copy of this PDF first.' };
  if (error.name === 'InvalidPDFException' || error.name === 'MissingPDFException') {
    return { code: 'INVALID_PDF', message: 'The file could not be opened as a PDF.' };
  }
  return { code: 'PDF_OPERATION_FAILED', message: 'The operation failed. Try a smaller PDF or check that it opens in a PDF reader.' };
}

const isWithin = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export async function createFileAccess(roots) {
  const allowedRoots = await Promise.all(roots.map(async (root) => {
    const resolved = await realpath(root);
    if (!(await stat(resolved)).isDirectory()) {
      throw new PdfError('INVALID_ROOT', '--root must be an existing directory.');
    }
    return resolved;
  }));

  const assertAllowed = (target) => {
    if (!allowedRoots.some((root) => isWithin(root, target))) {
      throw new PdfError('PATH_OUTSIDE_ROOT', 'Choose a file inside a directory allowed by --root.');
    }
  };

  const resolvePath = (name, extensions = ['.pdf']) => {
    if (!extensions.includes(path.extname(name).toLowerCase())) {
      throw new PdfError('INVALID_EXTENSION', `Use a local path with one of these extensions: ${extensions.join(', ')}.`);
    }
    return path.resolve(allowedRoots[0], name);
  };

  return {
    async read(name) {
      const target = await realpath(resolvePath(name));
      assertAllowed(target);
      if (!(await stat(target)).isFile()) throw new PdfError('PDF_FILE_REQUIRED', 'Use a regular PDF file.');
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const { size } = await handle.stat();
        if (size > maxPdfBytes) throw new PdfError('PDF_TOO_LARGE', 'Input PDFs are limited to 128 MiB. Try a smaller copy.');
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== size || (await handle.stat()).size !== size) {
          throw new PdfError('SOURCE_CHANGED', 'The PDF changed while it was being read. Inspect the current copy again.');
        }
        if (!bytes.subarray(0, 1024).includes('%PDF-')) throw new PdfError('INVALID_PDF', 'The file has no PDF header.');
        return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
      } finally {
        await handle.close();
      }
    },
    async output(name, extensions) {
      const target = resolvePath(name, extensions);
      const parent = await realpath(path.dirname(target));
      assertAllowed(parent);
      return path.join(parent, path.basename(target));
    }
  };
}

export async function saveNewFile(target, bytes) {
  const temp = path.join(path.dirname(target), `.pdfbookmarks-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await link(temp, target);
  } catch (error) {
    if (error.code === 'EEXIST') throw new PdfError('OUTPUT_EXISTS', 'Choose a new output filename. Existing files are never overwritten.');
    if (['ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) {
      throw new PdfError('OUTPUT_FILESYSTEM_UNSUPPORTED', 'Choose an output folder on a filesystem that supports hard links, such as a local APFS, NTFS, or ext4 volume.');
    }
    throw error;
  } finally {
    await unlink(temp).catch(() => {});
  }
}
