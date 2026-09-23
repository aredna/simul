# Local OCR third-party notices

Simul packages Tesseract.js 7.0.0, tesseract.js-core 7.0.0, and selected
official `tessdata_fast` files at commit
`87416418657359cb625c412a48b6e1d6d41c29bd`. These components are licensed
under Apache License 2.0. Exact license texts and the Tesseract Worker notice
are included beside the runtime assets.

The compiled Tesseract core includes work from Tesseract OCR, Leptonica,
giflib, libjpeg, libpng, libtiff, libwebp, openlibm, and zlib, and was built
with Emscripten 4.0.15, whose runtime and musl C library are part of it. Their
notices and exact source provenance are retained in
`tesseract/licenses/CORE_THIRD_PARTY_NOTICES.txt`. This software is based in
part on the work of the Independent JPEG Group.

The Tesseract Worker also bundles `base64-js`, `bmp-js`, `buffer`,
`idb-keyval`, `ieee754`, `is-url`, `regenerator-runtime`,
`wasm-feature-detect`, `zlibjs`, and the webpack runtime; their notices are in
`THIRD_PARTY_NOTICES.md` at the extension root.

Changes made by Simul (Apache License 2.0, section 4(b)):

- `tesseract/worker/worker.min.js` is tesseract.js 7.0.0 `dist/worker.min.js`
  with its remote fallback locations for the core and the language data
  replaced by local-only markers, its `sourceMappingURL` line removed, and a
  modification notice added at the top.
- The tesseract.js code bundled into Simul's OCR offscreen chunk has its
  remote worker, core, and language-data fallback locations replaced by
  local-only markers, and the chunk starts with a modification notice.
- The language files are the upstream `.traineddata` files compressed with
  gzip; their content is unchanged. The core loaders are unmodified.

No OCR JavaScript, Worker, Wasm core, or language model is loaded remotely.
