/**
 * Access to all sites is part of the manifest since D166: Simul follows
 * every page the reader opens without a click on its icon on each new site.
 * Chrome refuses to remove a permission the manifest requires, and any
 * site's pattern overlaps `<all_urls>`, so the flows that give access back
 * when a feature is turned off leave out what the manifest requires (the
 * reader can still withhold it in Chrome's Site access, and Simul asks for
 * it again from a click).
 */

/** The origins of `origins` that Chrome lets Simul remove. */
export function removableHostOrigins(
  origins: readonly string[],
  requiredHostPermissions: readonly string[] | undefined,
): string[] {
  if (!requiredHostPermissions || requiredHostPermissions.length === 0) {
    return [...origins];
  }
  if (requiredHostPermissions.includes('<all_urls>')) return [];
  const required = new Set(requiredHostPermissions);
  return origins.filter((origin) => !required.has(origin));
}

/** The host permissions the running build's manifest requires. */
export function manifestHostPermissions(
  readManifest: () => object,
): readonly string[] {
  try {
    const value = (readManifest() as { host_permissions?: unknown }).host_permissions;
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Removes only what may be removed; nothing to remove is a removal done
 * (the access stays, as the manifest says).
 */
export async function removeRemovableHostOrigins(
  origins: readonly string[],
  requiredHostPermissions: readonly string[] | undefined,
  remove: (origins: string[]) => Promise<boolean>,
): Promise<boolean> {
  const removable = removableHostOrigins(origins, requiredHostPermissions);
  if (removable.length === 0) return true;
  return remove(removable);
}
