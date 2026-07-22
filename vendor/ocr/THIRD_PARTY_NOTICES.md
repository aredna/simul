# Local OCR third-party notices

Simul packages Tesseract.js 7.0.0, tesseract.js-core 7.0.0, and selected
official `tessdata_fast` files at commit
`87416418657359cb625c412a48b6e1d6d41c29bd`. These components are licensed
under Apache License 2.0. Exact license texts and the Tesseract Worker notice
are included beside the runtime assets.

The compiled Tesseract core includes work from Tesseract OCR, Leptonica,
giflib, libjpeg, libpng, libtiff, libwebp, openlibm, and zlib. Their notices
and exact source provenance are retained in
`tesseract/licenses/CORE_THIRD_PARTY_NOTICES.txt`.
No OCR JavaScript, Worker, Wasm core, or language model is loaded remotely.

The local OCR trial can also package tesseract-wasm 0.11.0 as a separately
labeled direct binding around Tesseract OCR. tesseract-wasm is BSD-2-Clause,
its bundled Comlink transport and Tesseract core are Apache-2.0, and Leptonica
is BSD-2-Clause. Exact runtime provenance, hashes, and license texts are
included under `tesseract-wasm/`. This direct binding reuses the catalog above
and is treated as the same recognition family as Tesseract.js.
