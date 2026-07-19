import { capturePageSnapshot } from '../lib/page-snapshot';

// WXT emits this as an unlisted bundle. The side panel injects the same pure,
// closure-free function with scripting.executeScript so no persistent content
// script or host permission is needed.
export default defineUnlistedScript(capturePageSnapshot);
