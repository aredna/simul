# PaddleOCR.js local trial notices

This reviewed notice applies to the checked-in ready-to-load four-provider
profile and any source build made with `SIMUL_OCR_PADDLE=1`. The ordinary
unflagged Paddle-free `.output` build does not contain these components. A
Paddle-enabled artifact packages the SDK's module Worker locally and patches
its unused remote model/CDN defaults to fail-closed local sentinels.

| Component | Exact version / revision | License |
| --- | --- | --- |
| `@paddleocr/paddleocr-js` | 0.4.2, npm git head `e5046169b225bcdfbe25d45b4e809ff0f1a69c2c` | Apache-2.0 |
| PP-OCRv6 tiny model archives | reviewed SHA-256 values in `asset-manifest.json` | Apache-2.0 |
| `onnxruntime-web` and its packaged Wasm runtime | 1.24.3 | MIT |
| `@techstark/opencv-js` | 4.10.0-release.1 | Apache-2.0 |
| `clipper-lib` | 6.4.2, git head `97a4d5e79671973b457c13432d8e8c4107f8a51d` | Boost-1.0 |
| `js-yaml` | 4.1.1 | MIT |

The `js-yaml` version above is the code embedded in the published Paddle SDK
Worker. The repository's separately locked npm resolution is 4.3.0.

The complete upstream license texts are packaged beside this notice under
`ocr/paddle/licenses/`. The Paddle model archives are the official unmodified
`PP-OCRv6_tiny_det` and `PP-OCRv6_tiny_rec` ONNX inference archives. Simul
does not redistribute a Paddle model server, remote loader, or hosted fallback.

The Paddle SDK bundle may incorporate or call dependencies from its locked npm
graph. Their copyright and license declarations remain in the source packages
and the repository-wide `THIRD_PARTY_NOTICES.md`; the trial artifact includes
the license texts required for the SDK, models, OpenCV, ONNX Runtime, Clipper,
and YAML parser shipped in the executable closure.
