/*! Simul: the tesseract.js worker entry (Trusted Types, D161). Simul's CSP
 * requires Trusted Types, and tesseract's worker loads its engine with
 * importScripts(string), so this worker first creates a default policy that
 * lets through only this extension's own files, then loads tesseract.js. */
self.trustedTypes?.createPolicy('default', {
  createScriptURL(input) {
    const own = new URL(self.location.href);
    const url = new URL(input, own);
    if (url.protocol !== own.protocol || url.host !== own.host || url.host === '') {
      throw new TypeError(`A script URL outside the extension was refused: ${url.protocol}//${url.host}`);
    }
    return input;
  },
});
importScripts('worker.min.js');
