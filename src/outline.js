import { PDFHexString, PDFName } from 'pdf-lib';

export function writeOutline(doc, bookmarks) {
  const { context, catalog } = doc;
  const root = context.obj({ Type: 'Outlines', Count: bookmarks.length });
  const rootRef = context.register(root);
  const parents = [{ dict: root, ref: rootRef }];
  for (const bookmark of bookmarks) {
    parents.length = bookmark.depth;
    const parent = parents.at(-1);
    const dest = doc.getPage(bookmark.outputPage - 1).ref;
    const dict = context.obj({
      Title: PDFHexString.fromText(bookmark.title),
      Parent: parent.ref,
      Dest: [dest, PDFName.of('Fit')]
    });
    const ref = context.register(dict);
    const previous = parent.dict.get(PDFName.of('Last'));
    if (previous) {
      context.lookup(previous).set(PDFName.of('Next'), ref);
      dict.set(PDFName.of('Prev'), previous);
    } else {
      parent.dict.set(PDFName.of('First'), ref);
    }
    parent.dict.set(PDFName.of('Last'), ref);
    for (const ancestor of parents.slice(1)) {
      ancestor.descendants++;
      ancestor.dict.set(PDFName.of('Count'), context.obj(ancestor.descendants));
    }
    parents.push({ dict, ref, descendants: 0 });
  }
  catalog.set(PDFName.of('Outlines'), rootRef);
  catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}
