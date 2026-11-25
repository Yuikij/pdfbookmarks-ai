import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber } from 'pdf-lib';
import { PdfError } from './files.js';

const pageLabels = PDFName.of('PageLabels');
const nums = PDFName.of('Nums');
const kids = PDFName.of('Kids');
const style = PDFName.of('S');
const start = PDFName.of('St');

export function shiftPageLabels(doc, beforePage, insertedCount, sourceLabels) {
  const { catalog, context } = doc;
  const root = catalog.lookupMaybe(pageLabels, PDFDict);
  if (!root) return;
  const ranges = new Map();
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const tree = queue.pop();
    if (seen.has(tree)) continue;
    seen.add(tree);
    const pairs = tree.lookupMaybe(nums, PDFArray);
    if (pairs) {
      if (pairs.size() % 2 !== 0) throw new PdfError('INVALID_PAGE_LABELS', 'The source page label table is malformed.');
      for (let index = 0; index < pairs.size(); index += 2) {
        const position = pairs.lookup(index, PDFNumber).asNumber();
        const ref = pairs.get(index + 1);
        ranges.set(position, ref);
      }
    }
    const children = tree.lookupMaybe(kids, PDFArray);
    if (children) {
      for (const child of children.asArray()) {
        const node = context.lookup(child);
        if (node instanceof PDFDict) queue.push(node);
      }
    }
  }

  const boundary = beforePage - 1;
  const earlier = [...ranges.keys()].filter((index) => index < boundary).sort((a, b) => a - b);
  const shifted = [...ranges.entries()].map(([index, rule]) => [
    index >= boundary ? index + insertedCount : index, rule
  ]);
  const labels = new Set(sourceLabels);
  let batch = 1;
  let prefix = 'TOC ';
  const conflicts = () => Array.from({ length: insertedCount }, (_, index) => index + 1)
    .some((index) => labels.has(prefix + index));
  while (conflicts()) prefix = `TOC ${++batch}.`;
  shifted.push([boundary, context.obj({ S: 'D', P: PDFHexString.fromText(prefix) })]);
  const originalCount = doc.getPageCount() - insertedCount;
  if (boundary < originalCount && !ranges.has(boundary)) {
    const previous = earlier.length ? earlier.at(-1) : 0;
    const ref = ranges.get(previous);
    const originalRule = ref ? context.lookup(ref, PDFDict) : context.obj({ S: 'D' });
    const continued = originalRule.clone(context);
    if (continued.has(style)) {
      const firstNumber = continued.lookupMaybe(start, PDFNumber)?.asNumber() ?? 1;
      continued.set(start, context.obj(firstNumber + boundary - previous));
    }
    shifted.push([boundary + insertedCount, continued]);
  }
  catalog.set(pageLabels, context.obj({
    Nums: shifted.sort(([left], [right]) => left - right).flat()
  }));
}
