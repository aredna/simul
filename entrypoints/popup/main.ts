import { createFoundationStatus } from '../../lib/foundation-status';

const status = document.querySelector<HTMLElement>('#status');

if (!status) {
  throw new Error('Popup status element is missing.');
}

status.textContent = createFoundationStatus('Simul');
