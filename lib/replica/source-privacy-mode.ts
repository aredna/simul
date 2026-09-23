/**
 * The Advanced "Show everything (testing)" switch (D75). With it on, the
 * mirror copies the page without privacy filtering: password, card and
 * one-time-code fields, file inputs, masked text, hidden and collapsed
 * regions, control labels and values, and the attributes the mirror normally
 * strips (`value`, `aria-*`, `data-*` and the like) travel as the page holds
 * them. It exists so a missing piece of a page can be traced to a privacy
 * rule or ruled out. What stops the mirror acting on the page stays: no
 * scripts, navigation, form submission or source mutation.
 *
 * Both sides of one mirror use the same value: the panel applies the setting
 * before it opens a session and sends it in the start message, and the page
 * applies it from there, as with the size limits (D64). The value is a live
 * binding, so every privacy rule reads the current setting.
 */
export let SOURCE_PRIVACY_FILTERS_OFF = false;

export function applySourcePrivacyFiltersOff(off: boolean): void {
  SOURCE_PRIVACY_FILTERS_OFF = off === true;
}
