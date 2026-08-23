export interface QuickTranslationShortcutInput {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey?: boolean;
  readonly isComposing?: boolean;
  readonly repeat?: boolean;
}

/** Keeps plain Enter available for multiline input while avoiding duplicate or
 * partially composed translations. */
export function isQuickTranslationShortcut(
  input: QuickTranslationShortcutInput,
): boolean {
  return input.key === 'Enter' &&
    (input.ctrlKey || input.metaKey) &&
    !input.altKey &&
    !input.isComposing &&
    !input.repeat;
}
