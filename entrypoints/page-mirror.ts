import { installHtmlMirrorSourceBridge } from '../lib/replica/html-mirror-source';

// WXT emits this as an unlisted, local exact-document bridge.
export default defineUnlistedScript(installHtmlMirrorSourceBridge);
