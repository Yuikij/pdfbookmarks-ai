# CLI fallback

Requires Node.js 22.13+. Obtain the pinned npm archive from the [GitHub release](https://github.com/Yuikij/pdfbookmarks-ai/releases/latest), or use an installed `pdfbookmarks-mcp` command. Invoke the release directly using this example, substituting your root directory.

```sh
npx --yes 'https://github.com/Yuikij/pdfbookmarks-ai/releases/download/v0.1.0/pdfbookmarks-mcp-0.1.0.tgz' \
  call pdf_inspect --root '/path/to/pdfs' --json '{"path":"book.pdf"}'
```

With a local installation, render a file that a visual agent can open:

```sh
pdfbookmarks-mcp call pdf_render_page --root '/path/to/pdfs' \
  --json '{"path":"book.pdf","page":3}' --image-out 'book-toc-preview.jpg'
```

Run `pdfbookmarks-mcp tools` for the JSON argument schemas. Every result is JSON. A failed call returns a nonzero exit status and a stable error code. For plan/write, keep the same input and add `planId`, `sourceSha256`, and `outputPath` for the write.
