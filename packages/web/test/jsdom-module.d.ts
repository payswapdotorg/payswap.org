/**
 * Minimal ambient declaration for the `jsdom` test dependency (P3-W2-003).
 *
 * jsdom ships no TypeScript types of its own and this work order adds ZERO
 * new dependencies (no @types/jsdom), so the a11y suites declare exactly
 * the surface they use: constructing a document from markup, with an
 * explicit (never opaque) origin.
 */
declare module "jsdom" {
  export interface DOMWindow extends Window {
    document: Document;
  }

  export interface JSDOMConstructorOptions {
    url?: string;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMConstructorOptions);
    readonly window: DOMWindow;
  }
}
