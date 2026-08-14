/**
 * A DOM small enough to run `inbox.js` in Node, and nothing more.
 *
 * `actions.js` and `diff.js` are pure and test themselves; `inbox.js` is the
 * one module that touches the DOM, so until now it had no test at all. An
 * accessibility rule cannot be checked in a pure function — "the field exposes
 * a name" is a statement about elements and how they are tied together — so
 * this file implements the handful of DOM operations the page actually uses.
 *
 * A browser-shaped dependency (jsdom, a headless browser) would be the obvious
 * alternative and is deliberately not taken: the whole screen is native ES
 * modules with no bundler and no build step, and the spec asks for a new
 * dependency only where there is no way around one. What the page uses is
 * `createElement`, `getElementById`, `append`, `replaceChildren`, `classList`,
 * `textContent`, `addEventListener` and `focus` — that list is the file.
 *
 * It is a stub, so it is honest about being one: no layout, no CSS, no event
 * bubbling, no default actions. Anything that depends on those is not testable
 * here and should not pretend to be.
 */

type Listener = () => void;

/** One element: properties the page sets, plus the queries a test needs. */
export class FakeElement {
  readonly tagName: string;

  /* --- properties the page writes ------------------------------------- */
  className = '';
  id = '';
  /** Mirrors `HTMLLabelElement.htmlFor`, i.e. the `for` attribute. */
  htmlFor = '';
  type = '';
  placeholder = '';
  value = '';
  disabled = false;

  /** Set by `focus()`; the page moves focus into the reason field. */
  focused = false;

  children: FakeElement[] = [];

  #text = '';
  readonly #attributes = new Map<string, string>();
  readonly #listeners = new Map<string, Listener[]>();

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  /** Own text when the element is a leaf, the children's otherwise — as in the DOM. */
  get textContent(): string {
    if (this.children.length > 0) return this.children.map((child) => child.textContent).join('');
    return this.#text;
  }

  set textContent(value: string) {
    this.#text = value;
    this.children = [];
  }

  get classList() {
    const names = (): string[] => this.className.split(/\s+/).filter((name) => name !== '');
    const write = (list: string[]): void => {
      this.className = list.join(' ');
    };
    return {
      contains: (name: string): boolean => names().includes(name),
      add: (name: string): void => {
        if (!names().includes(name)) write([...names(), name]);
      },
      remove: (name: string): void => {
        write(names().filter((existing) => existing !== name));
      },
      toggle: (name: string, force?: boolean): void => {
        const on = force ?? !names().includes(name);
        if (on) {
          if (!names().includes(name)) write([...names(), name]);
        } else {
          write(names().filter((existing) => existing !== name));
        }
      },
    };
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.#text = '';
    this.children = [...nodes];
  }

  addEventListener(type: string, handler: Listener): void {
    const handlers = this.#listeners.get(type) ?? [];
    handlers.push(handler);
    this.#listeners.set(type, handlers);
  }

  focus(): void {
    this.focused = true;
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name.toLowerCase(), value);
  }

  /** `id` and `for` answer from their properties, the way the real DOM mirrors them. */
  getAttribute(name: string): string | null {
    const key = name.toLowerCase();
    if (key === 'id') return this.id === '' ? null : this.id;
    if (key === 'for') return this.htmlFor === '' ? null : this.htmlFor;
    return this.#attributes.get(key) ?? null;
  }

  /* --- what a test needs ---------------------------------------------- */

  /** Fires the handlers registered for `type`. No bubbling: the page does not use any. */
  dispatch(type: string): void {
    for (const handler of this.#listeners.get(type) ?? []) handler();
  }

  /** A click, as far as this page is concerned. */
  click(): void {
    this.dispatch('click');
  }

  /** Types into a field: the value changes, then `input` fires — in that order. */
  typeText(text: string): void {
    this.value = text;
    this.dispatch('input');
  }

  /** Every descendant, depth-first, this element excluded. */
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  byTag(tagName: string): FakeElement[] {
    const wanted = tagName.toLowerCase();
    return this.descendants().filter((node) => node.tagName === wanted);
  }

  byClass(className: string): FakeElement[] {
    return this.descendants().filter((node) => node.classList.contains(className));
  }
}

/** The one element matching, with a readable failure when there is not exactly one. */
export function only(nodes: FakeElement[], what: string): FakeElement {
  if (nodes.length !== 1) throw new Error(`expected exactly one ${what}, found ${nodes.length}`);
  return nodes[0];
}

/** The document: the five ids `index.html` declares, plus `createElement`. */
export class FakeDocument {
  readonly #byId = new Map<string, FakeElement>();

  constructor(ids: readonly string[]) {
    for (const id of ids) {
      const element = new FakeElement('div');
      element.id = id;
      this.#byId.set(id, element);
    }
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  getElementById(id: string): FakeElement | null {
    return this.#byId.get(id) ?? null;
  }

  /** Same lookup, but a missing id is a broken test rather than a `null` later. */
  require(id: string): FakeElement {
    const element = this.#byId.get(id);
    if (element === undefined) throw new Error(`the fake page has no element with id "${id}"`);
    return element;
  }
}

/**
 * The accessible name of a control, over the slice of the algorithm this page
 * can reach: `aria-label`, or a `<label>` tied to it by `for`/`id`.
 *
 * `placeholder` is deliberately not consulted, and that is the whole point of
 * this file's tests. The real algorithm does fall back to it, last, but a
 * placeholder is a hint: it disappears as soon as someone types, it is not
 * announced consistently across browser and reader pairs, and a field whose
 * only name is a placeholder is a field with no name for anyone who has to
 * come back to it after filling it in.
 *
 * @param root Subtree to look for the `<label>` in — a row, or the page.
 * @param control The input whose name is being resolved.
 */
export function accessibleNameOf(root: FakeElement, control: FakeElement): string {
  const ariaLabel = control.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim();

  if (control.id === '') return '';
  const label = root
    .byTag('label')
    .find((candidate) => candidate.getAttribute('for') === control.id);
  return label === undefined ? '' : label.textContent.trim();
}
