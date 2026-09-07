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
 * t433 added the four `interview.js` needs on top of that list: `innerHTML`,
 * `contains`, `name`, and the document's `activeElement`. The first one is the
 * only interesting addition, and it is deliberately NOT a parser: assigning
 * `innerHTML` stores the string and, so that the page can find again the field
 * it is carrying a typed value into, registers every `id="…"` the string
 * declares as a NEW element of the document — replacing whatever answered to
 * that id before, exactly as a real swap does. Nothing else about the markup is
 * interpreted, and a test that needs more than "this id now exists" is a test
 * this stub cannot honestly serve.
 *
 * It is a stub, so it is honest about being one: no layout, no CSS, no event
 * bubbling, no default actions. Anything that depends on those is not testable
 * here and should not pretend to be.
 */

type Listener = () => void;

/** An opening tag in an injected HTML string — the only markup this stub reads. */
const OPENING_TAG = /<([a-z][a-z0-9-]*)((?:\s[^>]*)?)>/gi;

/** `id="x"` and `name="x"` inside one element's attributes. */
const ID_ATTRIBUTE = /\bid="([^"]+)"/i;
const NAME_ATTRIBUTE = /\bname="([^"]+)"/i;

/** One element: properties the page sets, plus the queries a test needs. */
export class FakeElement {
  readonly tagName: string;

  /* --- properties the page writes ------------------------------------- */
  className = '';
  id = '';
  /** Mirrors `HTMLLabelElement.htmlFor`, i.e. the `for` attribute. */
  htmlFor = '';
  /** The `name` attribute, as a property — the handle a form control carries. */
  name = '';
  type = '';
  placeholder = '';
  value = '';
  disabled = false;

  /** Set by `focus()`; the page moves focus into the reason field. */
  focused = false;

  children: FakeElement[] = [];

  /** The document this element belongs to, when it was made by one. */
  ownerDocument: FakeDocument | null = null;

  #html = '';
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

  /** The markup last assigned; `''` for an element nobody swapped into. */
  get innerHTML(): string {
    return this.#html;
  }

  /**
   * Swaps this element's contents, the way `interview.js` does after a poll.
   *
   * Whatever was inside is gone — children and text both — and every `id` the
   * new markup declares becomes a NEW element of the owning document. That
   * replacement is the honest half: a stub that let the old element keep
   * answering to its id would make "the value was carried over" pass without
   * anything having been carried anywhere.
   */
  set innerHTML(value: string) {
    this.#html = value;
    this.#text = '';
    this.children = [];
    this.ownerDocument?.absorb(value);
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

  /** Is `node` this element, or somewhere under it? — `Node.contains`. */
  contains(node: FakeElement | null): boolean {
    if (node === null) return false;
    return node === this || this.descendants().includes(node);
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

  /** What has focus right now; a test sets it, `focus()` never moves it here. */
  activeElement: FakeElement | null = null;

  constructor(ids: readonly string[]) {
    for (const id of ids) {
      const element = new FakeElement('div');
      element.id = id;
      element.ownerDocument = this;
      this.#byId.set(id, element);
    }
  }

  createElement(tagName: string): FakeElement {
    const element = new FakeElement(tagName);
    element.ownerDocument = this;
    return element;
  }

  /**
   * Registers every element an injected HTML string declares by id (t433).
   *
   * Called by {@link FakeElement.innerHTML}'s setter and by nothing else. It
   * reads three things and no more — the tag, the id and the `name` — because
   * that is the whole of what a page finding its way back to a field needs.
   *
   * @param html The markup just assigned.
   */
  absorb(html: string): void {
    for (const match of html.matchAll(OPENING_TAG)) {
      const id = ID_ATTRIBUTE.exec(match[2])?.[1];
      if (id === undefined) continue;
      const element = new FakeElement(match[1]);
      element.ownerDocument = this;
      element.id = id;
      element.name = NAME_ATTRIBUTE.exec(match[2])?.[1] ?? '';
      this.#byId.set(id, element);
    }
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
