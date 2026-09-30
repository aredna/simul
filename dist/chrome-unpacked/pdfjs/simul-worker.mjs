/*! Simul: the pdf.js worker entry. The shim runs first; the re-export keeps
 * pdf.js's in-page fallback worker working. */
import './simul-shim.mjs';
export * from './pdf.worker.min.mjs';
