import { installPdfViewerBridge } from '../lib/pdf/pdf-viewer-bridge';

// WXT emits this as an unlisted script that the panel injects into a PDF tab.
export default defineUnlistedScript(() => installPdfViewerBridge());
