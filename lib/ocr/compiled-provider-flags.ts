declare const __SIMUL_OCR_PADDLE_COMPILED__: boolean;

/**
 * WXT replaces this sentinel for extension builds so Rollup can remove every
 * Paddle-specific route constant from Paddle-free artifacts. Unit tests use
 * the permissive fallback to exercise the optional provider directly.
 */
export const PADDLE_OCR_COMPILED =
  typeof __SIMUL_OCR_PADDLE_COMPILED__ === 'boolean'
    ? __SIMUL_OCR_PADDLE_COMPILED__
    : true;
