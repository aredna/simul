import { describe, expect, it } from 'vitest';

import { Currency, PAGE_CURRENCY_SCOPES } from '../entrypoints/sidepanel/currency';

describe('Currency', () => {
  it('keeps a token current until the same scope begins again', () => {
    const currency = new Currency();
    const first = currency.begin('identity');
    expect(currency.isCurrent(first)).toBe(true);
    const second = currency.begin('identity');
    expect(currency.isCurrent(first)).toBe(false);
    expect(currency.isCurrent(second)).toBe(true);
  });

  it('keeps scopes independent so an unrelated check cannot cancel a follow', () => {
    const currency = new Currency();
    const follow = currency.begin('identity');
    currency.begin('availability');
    currency.begin('availability');
    currency.supersede('image-access');
    expect(currency.isCurrent(follow)).toBe(true);
  });

  it('cannot accept a token against a different scope', () => {
    const currency = new Currency();
    const availability = currency.begin('availability');
    // A token that was minted for one scope carries that scope with it, so a
    // guard written against another scope compares the right counter anyway.
    currency.begin('identity');
    expect(currency.isCurrent(availability)).toBe(true);
    currency.begin('availability');
    expect(currency.isCurrent(availability)).toBe(false);
  });

  it('supersedes every page-scoped token at once but leaves device scopes alone', () => {
    const currency = new Currency();
    const page = PAGE_CURRENCY_SCOPES.map((scope) => currency.begin(scope));
    const access = currency.begin('image-access');
    currency.supersedePage();
    for (const token of page) expect(currency.isCurrent(token)).toBe(false);
    expect(currency.isCurrent(access)).toBe(true);
  });

  it('treats a token minted elsewhere as stale rather than current', () => {
    const currency = new Currency();
    expect(currency.isCurrent({ scope: 'identity', id: 1 })).toBe(false);
    currency.begin('identity');
    expect(currency.isCurrent({ scope: 'identity', id: 1 })).toBe(true);
  });
});
