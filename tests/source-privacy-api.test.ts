import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';

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
describe('a form whose fields are named for its own properties (D201)', () => {
  // A form answers `form.<field name>` before its own properties, in a
  // content script as in the page (D181). linkedom keeps `localName` and
  // `nodeType` on the element: they go to a prototype as in a browser, where
  // the form's own field then stands in front of them.
  function answerForFields(form: Element, fields: Record<string, Element>): void {
    const prototype = Object.getPrototypeOf(form) as object;
    Object.setPrototypeOf(form, Object.create(prototype, {
      localName: { configurable: true, get: () => 'form' },
      tagName: { configurable: true, get: () => 'FORM' },
      nodeType: { configurable: true, get: () => 1 },
    }));
    delete (form as { localName?: string }).localName;
    delete (form as { nodeType?: number }).nodeType;
    for (const [name, field] of Object.entries(fields)) {
      Object.defineProperty(form, name, { configurable: true, value: field });
    }
  }

  it('reads the name of a form above an image past a field named tagName', () => {
    // The check of an image's ancestors threw, and the image reader with it.
    const { document } = parseHTML(
      '<!doctype html><html><body><form><input id="field"><img id="inside"></form></body></html>',
    );
    answerForFields(document.querySelector('form')!, {
      tagName: document.getElementById('field')!,
    });
    const image = document.getElementById('inside') as unknown as Element;
    expect(privacyPolicy.hasSourceImageCaptureBlockingAncestor(image)).toBe(false);
    expect(privacyPolicy.hasSourceActivationElementAncestor(image)).toBe(false);
  });

  it('walks up past a form whose field is named parentElement', () => {
    // Through the field, the walk left the form's ancestors: here for a
    // field elsewhere; one inside the form led back to it without end.
    const { document } = parseHTML(
      '<!doctype html><html><body><p id="elsewhere"></p></body></html>',
    );
    const select = document.createElement('select');
    const form = document.createElement('form');
    const option = document.createElement('option');
    form.append(option);
    select.append(form);
    document.body.append(select);
    answerForFields(form, { parentElement: document.getElementById('elsewhere')! });
    expect(privacyPolicy.isSourceOptionInsideNativeSelect(
      option as unknown as Element,
    )).toBe(true);
  });
});
