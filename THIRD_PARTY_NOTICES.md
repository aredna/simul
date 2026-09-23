# Third-party notices

This file covers third-party material distributed in Simul's ready-to-load
Chrome extension and generated third-party tooling retained in the public
source repository. It does not grant a license to original Simul material;
see [LICENSE](LICENSE).

The inventory is derived from what the Simul 0.5.1 extension artifact
actually contains: the locked production dependency graph, the pinned OCR
asset manifest, and the modules tesseract.js bundled into its prebuilt Worker
(read from the Worker's published source map). Development-only npm packages
are not included in the extension artifact and retain the licenses shipped in
their own packages. Generated BMAD Method files are covered separately below.

## Runtime inventory

| Components | Version | License | Where it ships |
| --- | --- | --- | --- |
| `tesseract.js` | 7.0.0 | Apache-2.0 | OCR offscreen chunk (modified, see below) and `ocr/tesseract/worker/worker.min.js` (modified) |
| `tesseract.js-core` | 7.0.0 | Apache-2.0 | `ocr/tesseract/core/` (unmodified) |
| selected `tessdata_fast` language models | commit `87416418657359cb625c412a48b6e1d6d41c29bd` | Apache-2.0 | `ocr/tesseract/lang/` (gzip-compressed, content unchanged) |
| `base64-js` | 1.5.1 | MIT | Tesseract Worker |
| `bmp-js` | 0.1.0 | MIT | Tesseract Worker |
| `buffer` | 6.0.3 | MIT | Tesseract Worker |
| `idb-keyval` | 6.2.1 | Apache-2.0 | Tesseract Worker |
| `ieee754` | 1.2.1 | BSD-3-Clause | Tesseract Worker |
| `is-url` | 1.2.4 | MIT | Tesseract Worker |
| `regenerator-runtime` | 0.13.11 | MIT | Tesseract Worker and OCR offscreen chunk |
| `wasm-feature-detect` | 1.8.0 | Apache-2.0 | Tesseract Worker |
| `zlibjs` | 0.3.1 | MIT | Tesseract Worker |
| webpack 5 runtime | (as built by tesseract.js) | MIT | Tesseract Worker |
| Tesseract OCR, Leptonica, giflib, libjpeg, libpng, libtiff, libwebp, OpenLibm, zlib, Emscripten runtime, musl libc | see `CORE_THIRD_PARTY_NOTICES.txt` | various permissive | compiled into the WebAssembly core |
| Vite module-preload helper | 8.2.2 | MIT | Simul's own chunks |
| `@wxt-dev/browser` | 0.2.2 | MIT | Simul's own chunks |

These packages are in the locked production dependency graph of tesseract.js
but contribute no code to the extension; their notices are kept below
conservatively: `idb-keyval` 6.3.0 (the Worker carries its own 6.2.1),
`node-fetch` 2.7.0, `opencollective-postinstall` 2.0.3, `tr46` 0.0.3,
`webidl-conversions` 3.0.1, and `whatwg-url` 5.0.0.

## Changes made by Simul

As Apache License 2.0 section 4(b) requires, the tesseract.js files Simul
changed say so at their top, and the changes are:

- `ocr/tesseract/worker/worker.min.js` is tesseract.js 7.0.0
  `dist/worker.min.js` with its remote fallback locations for the core and the
  language data replaced by local-only markers, its `sourceMappingURL` line
  removed, and a modification notice added.
- The tesseract.js code bundled into Simul's OCR offscreen chunk
  (`chunks/offscreen-*.js`) has its remote worker, core, and language-data
  fallback locations replaced by local-only markers, and the chunk starts with
  a modification notice.

The `tessdata_fast` language models are the upstream `.traineddata` files
compressed with gzip; their content is unchanged. The tesseract.js-core
loaders are unmodified.

## MIT-licensed material

Copyright notices retained for MIT-licensed material:

- `base64-js`: Copyright (c) 2014 Jameson Little.
- `bmp-js`: Copyright (c) 2014 @丝刀口.
- `buffer` (the Tesseract Worker's browser `buffer` module): Copyright (c)
  Feross Aboukhadijeh, and other contributors.
- `node-fetch`: Copyright (c) 2016 David Frank.
- `opencollective-postinstall`: Copyright (c) 2018 Open Collective.
- `regenerator-runtime`: Copyright (c) 2014-present, Facebook, Inc.
- `tr46`: Copyright (c) Sebastian Mayr.
- `whatwg-url`: Copyright (c) 2015–2016 Sebastian Mayr.
- `zlibjs`: Copyright (c) 2012 imaya.
- webpack 5 runtime in the Tesseract Worker: Copyright JS Foundation and other
  contributors.
- Vite module-preload helper: Copyright (c) 2019-present, VoidZero Inc. and
  Vite contributors.
- `@wxt-dev/browser`: Copyright (c) 2023 Aaron.
- `is-url` is distributed under MIT terms without a copyright line in its
  published license file.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Apache License 2.0 material

The complete Apache License 2.0 text is retained at these source-repository
paths:

- `vendor/ocr/tesseract/licenses/TESSERACT_JS_APACHE-2.0.txt`;
- `vendor/ocr/tesseract/licenses/TESSERACT_CORE_APACHE-2.0.txt`; and
- `vendor/ocr/tesseract/licenses/TESSDATA_FAST_APACHE-2.0.txt`.

Inside the ready-to-load extension, the same files are under
`ocr/tesseract/licenses/`.

Additional attribution: `idb-keyval` is Copyright 2016, Jake Archibald, and
`wasm-feature-detect` is Copyright 2017 Google Inc. The published
`wasm-feature-detect` and `idb-keyval` packages contain no separate NOTICE
file.
The Tesseract packages and models contain no separate NOTICE file beyond the
files retained in the vendored license directory.

## BSD-3-Clause material

The Tesseract Worker incorporates `ieee754` 1.2.1 (maintained by Feross
Aboukhadijeh), which is Copyright 2008 Fair Oaks Labs, Inc.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

## BSD-2-Clause material

`webidl-conversions` is Copyright (c) 2014, Domenic Denicola. All rights
reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

## OCR-specific and compiled-core notices

The exact upstream Tesseract Worker notice is retained at
`vendor/ocr/tesseract/licenses/WORKER_THIRD_PARTY.txt` in the source
repository and `ocr/tesseract/licenses/WORKER_THIRD_PARTY.txt` in the
ready-to-load extension.

The WebAssembly core incorporates pinned builds of Tesseract OCR, Leptonica,
giflib, Independent JPEG Group libjpeg, libpng, libtiff, libwebp, OpenLibm,
and zlib, compiled with Emscripten 4.0.15, whose JavaScript runtime (MIT) and
musl C library (MIT) are part of the output. The C++ runtime and compiler-rt
it links are Apache-2.0 with the LLVM exception, which needs no notice for
compiled object code. The unmodified upstream license/notice files and exact
commit provenance are retained at
`vendor/ocr/tesseract/licenses/CORE_THIRD_PARTY_NOTICES.txt` in the source
repository and `ocr/tesseract/licenses/CORE_THIRD_PARTY_NOTICES.txt` in the
ready-to-load extension. The canonical reviewed source is
`legal/tesseract-core-v7-third-party-notices.txt`.

As required by the Independent JPEG Group terms: this software is based in
part on the work of the Independent JPEG Group.

## Development dependency audit

The npm lockfile was reviewed separately from the production inventory above.
The development graph uses MIT, Apache-2.0, BSD, ISC, 0BSD, BlueOak-1.0.0,
MPL-2.0, Zlib, CC0, and packages offering a permissive license choice. The
MPL-2.0 packages (`fx-runner`, `lightningcss` platform packages, and `web-ext`)
are development/build tools and are not shipped in `dist/chrome-unpacked`.
Their files remain under MPL-2.0 and are not relicensed as Simul code.

Multi-licensed development packages are used under their permissive choices:
`node-forge` under BSD-3-Clause, `jszip` under MIT, `rc` under its
BSD-2-Clause/MIT/Apache-2.0 choices, and `type-fest` under MIT. `pako` retains
both its MIT and Zlib terms. The locked production dependency graph contains no
GPL-only, AGPL, or proprietary package.

Development packages are fetched by contributors and retain the license files
published in their npm packages. `node_modules` is not committed or included in
the extension artifact. Generated or bundled third-party code remains governed
by its upstream terms even when the surrounding original Simul code is MIT.

## Source-distribution tooling

This repository also distributes generated BMAD Method 6.10.0 workflow and
agent files under `.agents/` and `_bmad/`. Those files are not included in the
Chrome extension artifact. They are licensed under the upstream MIT License,
Copyright (c) 2025 BMad Code, LLC, with the upstream trademark notice retained
verbatim at `legal/BMAD-METHOD-v6.10.0-LICENSE.txt`.

The terms above do not grant rights to the BMad™, BMad Method™, or BMad Core™
trademarks. Upstream project and trademark guidance:
https://github.com/bmad-code-org/BMAD-METHOD/tree/v6.10.0
