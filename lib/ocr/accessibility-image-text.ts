export const MAX_ACCESSIBILITY_IMAGE_TEXT = 3_500;

/**
 * Canonicalize a direct image label while rejecting strings that only name a
 * URL or file. Natural-language labels may still contain punctuation, paths,
 * or domains when they are part of a larger phrase.
 */
export function normalizeAccessibilityImageText(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!text || text.length > MAX_ACCESSIBILITY_IMAGE_TEXT) return undefined;
  if (!/[\p{L}\p{N}]/u.test(text)) return undefined;
  if (isUrlOrFileOnlyAccessibilityText(text)) return undefined;
  return text;
}

function isUrlOrFileOnlyAccessibilityText(text: string): boolean {
  if (/\s/u.test(text)) return false;

  // Absolute/protocol-relative URLs and URI schemes, including file:, data:,
  // blob:, ftp:, chrome-extension:, and mailto:.
  if (/^(?:\/\/|[a-z][a-z0-9+.-]*:[^\s]*)$/iu.test(text)) return true;

  // Host-only and host/path forms commonly copied into alt text without a
  // scheme. Do not reject a domain when it appears in a natural sentence.
  if (/^www\.[^\s/\\?#]+(?:[/?#][^\s]*)?$/iu.test(text)) return true;

  // Unix, Windows, dot-relative, and ordinary relative paths. Requiring the
  // entire label to be whitespace-free avoids rejecting phrases such as
  // "Open / close".
  if (/^(?:[a-z]:[\\/]|[./\\]|[^/\\?#]+[\\/])[^\s]*$/iu.test(text)) {
    return true;
  }

  // A bare filename remains a filename when cache-busting query or fragment
  // data is appended. Keep the extension generic so a renamed asset cannot
  // bypass this receiver-side policy.
  return /^[^\s/\\?#]+\.[\p{L}\p{N}]{1,16}(?:[?#][^\s]*)?$/iu.test(text);
}
