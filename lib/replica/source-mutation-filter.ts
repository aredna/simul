/**
 * Returns false only when a native MutationObserver record proves that the
 * current DOM value is identical to the value before the assignment.
 * Incomplete synthetic/polyfilled records remain conservatively actionable.
 */
export function sourceMutationMayChangeCurrentValue(
  record: MutationRecord,
): boolean {
  if (record.type === 'attributes') {
    if (record.oldValue !== null && typeof record.oldValue !== 'string') {
      return true;
    }
    if (
      record.target.nodeType !== 1 ||
      !record.attributeName ||
      typeof (record.target as Element).getAttribute !== 'function'
    ) return true;
    const target = record.target as Element;
    try {
      const current = record.attributeNamespace
        ? target.getAttributeNS(
            record.attributeNamespace,
            record.attributeName,
          )
        : target.getAttribute(record.attributeName);
      return current !== record.oldValue;
    } catch {
      return true;
    }
  }
  if (record.type === 'characterData') {
    if (record.oldValue !== null && typeof record.oldValue !== 'string') {
      return true;
    }
    try {
      return record.target.nodeValue !== record.oldValue;
    } catch {
      return true;
    }
  }
  return true;
}
