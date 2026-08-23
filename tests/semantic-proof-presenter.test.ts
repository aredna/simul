import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { SemanticProofPresenter } from '../lib/replica/semantic-proof-presenter';

describe('SemanticProofPresenter', () => {
  it('refreshes derived presentation once per successful proof batch', () => {
    const { document } = parseHTML('<html><body></body></html>');
    let refreshes = 0;
    const options = {
      document,
      mode: 'isolated-html' as const,
      afterApply: () => {
        refreshes += 1;
      },
    };
    const presenter = new SemanticProofPresenter(options);

    expect(presenter.apply([])).toBe(true);
    expect(refreshes).toBe(1);
    expect(presenter.apply([])).toBe(true);
    expect(refreshes).toBe(2);

    presenter.clear();
    expect(refreshes).toBe(3);
  });
});
