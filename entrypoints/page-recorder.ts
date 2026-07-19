import { installPageRecorderBridge } from '../lib/replica/page-recorder';

// WXT emits this as an unlisted, locally bundled script. It is injected only
// after existing activeTab or optional-host authorization succeeds.
export default defineUnlistedScript(installPageRecorderBridge);
