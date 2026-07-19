import { capturePageSnapshot } from '../lib/page-snapshot';

// WXT emits this as an unlisted bundle. The side panel injects the same pure,
// closure-free function with scripting.executeScript, using either a temporary
// activeTab grant or explicit optional site access. No persistent content
// script is installed.
export default defineUnlistedScript(capturePageSnapshot);
