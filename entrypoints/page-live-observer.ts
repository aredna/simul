import { installLivePageObserverBridge } from '../lib/live-page-mirror';

// WXT emits this as an unlisted local bundle so imported scroll helpers remain
// in scope inside Chrome's isolated page world.
export default defineUnlistedScript(installLivePageObserverBridge);
