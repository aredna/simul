import { describe, expect, it } from 'vitest';

import * as privacyPolicy from '../lib/replica/source-privacy-policy';

describe('the privacy core\'s value readers', () => {
  it('exposes no value reader without a read scope (A8)', () => {
    // These read a native control's live value and had no caller and no
    // read-scope parameter: a future reader could have sent it under any
    // profile. They stay gone, so their return is a reviewed decision.
    for (const name of [
      'readSourceControlText',
      'readSourceSelectedOptionIndexes',
      'readSourceSelectPickerOpen',
    ]) {
      expect(name in privacyPolicy, name).toBe(false);
    }
  });
});