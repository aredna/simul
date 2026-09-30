# Local PDF third-party notices

Simul packages a subset of `pdfjs-dist` 6.3.289, the generic build of
Mozilla's PDF.js (commit `1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56`), to read
PDFs on the computer. The PDF.js files here are byte-identical to the npm
package. `LICENSE_BROTLI` comes from the PDF.js source at that commit, and the
two `simul-*` files, `asset-manifest.json` (each file's source, size, and
SHA-256), and this file are Simul's.

| Component | License | Files | License text |
| --- | --- | --- | --- |
| PDF.js (Mozilla Foundation) | Apache-2.0 | `pdf.min.mjs`, `pdf.worker.min.mjs` | `LICENSE` |
| Brotli decoder (the Brotli Authors), inside the worker | MIT | `pdf.worker.min.mjs` | `LICENSE_BROTLI` |
| Emscripten runtime glue for the OpenJPEG and JBIG2 decoders, inside the worker | MIT | `pdf.worker.min.mjs` | see below |
| wasm-bindgen glue for qcms, inside the worker | MIT | `pdf.worker.min.mjs` | see below |
| OpenJPEG | BSD-2-Clause | `wasm/openjpeg.wasm` | `wasm/LICENSE_OPENJPEG` |
| PDF.js OpenJPEG wrapper (Mozilla Foundation) | BSD-2-Clause | `wasm/openjpeg.wasm` | `wasm/LICENSE_PDFJS_OPENJPEG` |
| PDFium JBIG2 decoder (the PDFium Authors) | BSD-3-Clause | `wasm/jbig2.wasm` | `wasm/LICENSE_JBIG2` |
| PDF.js JBIG2 wrapper (Mozilla Foundation) | Apache-2.0 | `wasm/jbig2.wasm` | `wasm/LICENSE_PDFJS_JBIG2` |
| qcms (Mozilla Corporation, Marti Maria) | MIT | `wasm/qcms_bg.wasm` | `wasm/LICENSE_QCMS` |
| PDF.js qcms wrapper | MIT | `wasm/qcms_bg.wasm` | `wasm/LICENSE_PDFJS_QCMS` |
| Adobe CMaps (Adobe Systems Incorporated) | BSD-3-Clause | `cmaps/*.bcmap` | `cmaps/LICENSE` |
| Foxit Symbol and Dingbats fonts (the PDFium Authors) | BSD-3-Clause | `standard_fonts/*.pfb` | `standard_fonts/LICENSE_FOXIT` |
| CGATS001Compat-v2-micro ICC profile | CC0-1.0 | `iccs/CGATS001Compat-v2-micro.icc` | `iccs/LICENSE` |

The Emscripten runtime is Copyright (c) 2010-2014 Emscripten authors, and
wasm-bindgen is Copyright (c) 2014 Alex Crichton; both are used under the MIT
License, whose text is in `THIRD_PARTY_NOTICES.md` at the extension root.

Not packaged: the Liberation fonts (other standard fonts are drawn with the
computer's own fonts), the no-Wasm decoder fallbacks, the QuickJS scripting
sandbox, the viewer, and the image-decoder build.

Files written by Simul:

- `simul-shim.mjs` adds the six built-ins the modern PDF.js build calls and
  Chrome 138 lacks (`Map`/`WeakMap` `getOrInsert` and `getOrInsertComputed`,
  `Math.sumPrecise`, `Uint8Array` `toHex`, `toBase64` and `fromBase64`), each
  only when it is missing.
- `simul-worker.mjs` loads the shim, then the unmodified PDF.js worker.

No PDF.js code, font, CMap, or decoder is loaded remotely.
