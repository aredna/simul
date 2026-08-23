const NO_OPTIONAL_KEYS: readonly string[] = [];

/** Validate one small structured-clone record without per-call helper allocations. */
export function hasExactKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = NO_OPTIONAL_KEYS,
): boolean {
  const actualKeyCount = Object.keys(value).length;
  if (
    actualKeyCount < required.length ||
    actualKeyCount > required.length + optional.length
  ) return false;
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return false;
  }
  let knownKeyCount = required.length;
  for (const key of optional) {
    if (Object.hasOwn(value, key)) knownKeyCount += 1;
  }
  return actualKeyCount === knownKeyCount;
}
