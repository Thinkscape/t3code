/**
 * omp 19's `ask` sends one HTML `form`; T3's card asks one question per named control. Parsing and
 * constraints port omp's `pi-tui/html-form` and `rpc-mode.ts`, because omp fails the whole `ask`
 * on an invalid `data` reply.
 */
import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import { parse, type DefaultTreeAdapterTypes } from "parse5";

type DomNode = DefaultTreeAdapterTypes.Node;
type DomElement = DefaultTreeAdapterTypes.Element;

type SpanStyle = "code" | "strong" | "em";

/** A run of inline text; `"\n"` inside `text` is a hard line break (`<br>`). */
interface Span {
  text: string;
  style?: SpanStyle;
}

interface ChoiceOption {
  readonly value: string;
  readonly label: Span[];
  checked: boolean;
  readonly disabled: boolean;
}

/** A radio group (`multi: false`), checkbox group (`multi: true`) or `<select>` (`select: true`). */
interface ChoiceField {
  readonly kind: "choice";
  readonly name: string;
  readonly multi: boolean;
  readonly select: boolean;
  /** omp offers a free-text "Other" answer: radio and checkbox groups of 2+ options without one. */
  other: boolean;
  readonly label: Span[];
  readonly options: ChoiceOption[];
  required: boolean;
}

/** A single-line `<input>` or a `<textarea>` (`type: "textarea"`). */
interface TextField {
  readonly kind: "text";
  readonly name: string;
  readonly type: string;
  readonly label: Span[];
  readonly value: string;
  readonly placeholder: string;
  readonly required: boolean;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly pattern?: string | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
}

type FormField = ChoiceField | TextField;

type FormBlock =
  | { readonly kind: "text"; readonly spans: Span[]; readonly heading: boolean }
  | { readonly kind: "list"; readonly items: Span[][]; readonly ordered: boolean }
  | { readonly kind: "pre"; readonly text: string }
  | { readonly kind: "table"; readonly rows: Span[][][] }
  | { readonly kind: "image"; readonly src: string; readonly alt: string }
  | { readonly kind: "svg"; readonly alt: string }
  | { readonly kind: "field"; readonly field: FormField; optionsEnd?: number };

interface FormSection {
  title: Span[];
  blocks: FormBlock[];
}

interface HtmlForm {
  readonly sections: ReadonlyArray<FormSection>;
  readonly fields: ReadonlyArray<FormField>;
  readonly hidden: ReadonlyArray<readonly [name: string, value: string]>;
}

/** Submitted value of one control, as omp's form data carries it. */
export type OmpFormValue = string | number | ReadonlyArray<string>;

// Parsing ports omp's `pi-tui/html-form/parse.ts` onto parse5's tree.

type TagTable = Readonly<Record<string, true>>;

const SKIPPED: TagTable = {
  button: true,
  head: true,
  iframe: true,
  link: true,
  meta: true,
  noscript: true,
  script: true,
  style: true,
  template: true,
  title: true,
};
const BLOCK: TagTable = {
  address: true,
  article: true,
  aside: true,
  blockquote: true,
  dd: true,
  details: true,
  div: true,
  dl: true,
  dt: true,
  figure: true,
  figcaption: true,
  footer: true,
  header: true,
  li: true,
  main: true,
  nav: true,
  p: true,
  section: true,
};
const HEADING: TagTable = {
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  summary: true,
};
const STYLE_OF: Record<string, SpanStyle> = {
  b: "strong",
  code: "code",
  em: "em",
  i: "em",
  kbd: "code",
  samp: "code",
  strong: "strong",
  tt: "code",
};
const IGNORED_INPUTS: TagTable = {
  button: true,
  file: true,
  image: true,
  reset: true,
  submit: true,
};
const CONTROLS: TagTable = { input: true, select: true, textarea: true };

const isElement = (node: DomNode): node is DomElement => "tagName" in node;

function childNodes(node: DomNode): ReadonlyArray<DomNode> {
  return "childNodes" in node ? node.childNodes : [];
}

function childElements(node: DomNode): ReadonlyArray<DomElement> {
  return childNodes(node).filter(isElement);
}

function attribute(element: DomElement, name: string): string | null {
  return element.attrs.find((attr) => attr.name === name)?.value ?? null;
}

function hasAttribute(element: DomElement, name: string): boolean {
  return element.attrs.some((attr) => attr.name === name);
}

/** Descendant elements of `node` in document order, `node` excluded. */
function descendants(node: DomNode, tags: TagTable): Array<DomElement> {
  const found: Array<DomElement> = [];
  const visit = (current: DomNode) => {
    for (const child of childNodes(current)) {
      if (!isElement(child)) continue;
      if (tags[child.tagName]) found.push(child);
      visit(child);
    }
  };
  visit(node);
  return found;
}

function textContent(node: DomNode): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterTypes.TextNode).value;
  return childNodes(node).map(textContent).join("");
}

function closest(element: DomElement, tag: string): DomElement | null {
  let current: DomNode | null = element;
  while (current !== null && isElement(current)) {
    if (current.tagName === tag) return current;
    current = current.parentNode;
  }
  return null;
}

function contains(ancestor: DomElement, node: DomElement): boolean {
  let current: DomNode | null = node;
  while (current !== null) {
    if (current === ancestor) return true;
    current = "parentNode" in current ? current.parentNode : null;
  }
  return false;
}

function appendSpan(spans: Span[], text: string, style: SpanStyle | undefined): void {
  if (!text) return;
  const last = spans[spans.length - 1];
  if (last && last.style === style) last.text += text;
  else spans.push(style ? { text, style } : { text });
}

/** Collapse whitespace like HTML layout does; empty spans drop. */
function normalizeSpans(spans: ReadonlyArray<Span>): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    appendSpan(out, span.text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n"), span.style);
  }
  const first = out[0];
  if (first) first.text = first.text.replace(/^\s+/, "");
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/\s+$/, "");
  return out.filter((span) => span.text !== "");
}

function spansText(spans: ReadonlyArray<Span>): string {
  return spans.map((span) => span.text).join("");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function numberAttribute(element: DomElement, name: string): number | undefined {
  const raw = attribute(element, name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function svgTitle(svg: DomElement): string {
  const label = attribute(svg, "aria-label");
  if (label) return label.trim();
  const title = childElements(svg).find((child) => child.tagName === "title");
  return title === undefined ? "" : oneLine(textContent(title));
}

class FormBuilder {
  readonly #root: DomNode;
  readonly #sections: FormSection[] = [];
  readonly #fields: FormField[] = [];
  readonly #hidden: Array<readonly [string, string]> = [];
  readonly #groups = new Map<
    string,
    { field: ChoiceField; section: FormSection; block: Extract<FormBlock, { kind: "field" }> }
  >();
  readonly #labelFor = new Map<string, DomElement>();
  #section: FormSection = { title: [], blocks: [] };
  #inline: Span[] = [];
  #fieldsetDepth = 0;

  constructor(root: DomNode) {
    this.#root = root;
    this.#sections.push(this.#section);
  }

  build(): HtmlForm {
    const ids = new Set<string>();
    for (const control of descendants(this.#root, CONTROLS)) {
      const id = attribute(control, "id");
      if (id) ids.add(id);
    }
    for (const label of descendants(this.#root, { label: true })) {
      const target = attribute(label, "for");
      if (target && ids.has(target) && !this.#labelFor.has(target)) {
        this.#labelFor.set(target, label);
      }
    }
    this.#children(this.#root, undefined);
    this.#flush(false);
    for (const field of this.#fields) {
      if (field.kind !== "choice" || field.select || field.options.length < 2) continue;
      field.other = !field.options.some((option) => /^\s*other\b/i.test(spansText(option.label)));
    }
    return {
      sections: this.#sections.filter(
        (section) => section.blocks.length > 0 || section.title.length > 0,
      ),
      fields: this.#fields,
      hidden: this.#hidden,
    };
  }

  #children(node: DomNode, style: SpanStyle | undefined): void {
    for (const child of childNodes(node)) this.#walk(child, style);
  }

  #walk(node: DomNode, style: SpanStyle | undefined): void {
    if (node.nodeName === "#text") {
      appendSpan(this.#inline, (node as DefaultTreeAdapterTypes.TextNode).value, style);
      return;
    }
    if (!isElement(node)) return;
    const tag = node.tagName;
    if (SKIPPED[tag]) return;
    switch (tag) {
      case "br":
        appendSpan(this.#inline, "\n", undefined);
        return;
      case "hr":
        this.#flush(false);
        return;
      case "input":
      case "select":
      case "textarea":
        this.#control(node, undefined);
        return;
      case "label":
        this.#label(node, style);
        return;
      case "fieldset":
        this.#fieldset(node);
        return;
      case "legend":
        this.#flush(false);
        this.#children(node, style);
        this.#flush(true);
        return;
      case "ul":
      case "ol":
        this.#list(node, tag === "ol");
        return;
      case "pre":
        this.#flush(false);
        this.#section.blocks.push({
          kind: "pre",
          text: textContent(node).replace(/^\n/, "").trimEnd(),
        });
        return;
      case "table":
        this.#table(node);
        return;
      case "img": {
        const src = attribute(node, "src")?.trim();
        if (!src) return;
        this.#flush(false);
        this.#section.blocks.push({
          kind: "image",
          src,
          alt: (attribute(node, "alt") ?? "").trim(),
        });
        return;
      }
      case "svg":
        this.#flush(false);
        this.#section.blocks.push({ kind: "svg", alt: svgTitle(node) });
        return;
    }
    if (HEADING[tag]) {
      this.#flush(false);
      this.#children(node, style);
      this.#flush(true);
      return;
    }
    if (BLOCK[tag]) {
      this.#flush(false);
      this.#children(node, style);
      this.#flush(false);
      return;
    }
    this.#children(node, STYLE_OF[tag] ?? style);
  }

  #flush(heading: boolean): void {
    const spans = normalizeSpans(this.#inline);
    this.#inline = [];
    if (spans.length > 0) this.#section.blocks.push({ kind: "text", spans, heading });
  }

  /** Inline spans of `element`, skipping controls (their label is the text around them). */
  #spansOf(element: DomElement): Span[] {
    const spans: Span[] = [];
    const visit = (node: DomNode, style: SpanStyle | undefined): void => {
      if (node.nodeName === "#text") {
        appendSpan(spans, (node as DefaultTreeAdapterTypes.TextNode).value, style);
        return;
      }
      if (!isElement(node)) return;
      const tag = node.tagName;
      if (SKIPPED[tag] || CONTROLS[tag] || tag === "svg") return;
      if (tag === "br") {
        appendSpan(spans, "\n", undefined);
        return;
      }
      if (tag === "img") {
        appendSpan(spans, attribute(node, "alt") ?? "", style);
        return;
      }
      if (BLOCK[tag] || HEADING[tag]) appendSpan(spans, " ", undefined);
      for (const child of childNodes(node)) visit(child, STYLE_OF[tag] ?? style);
    };
    for (const child of childNodes(element)) visit(child, undefined);
    return normalizeSpans(spans);
  }

  #label(label: DomElement, style: SpanStyle | undefined): void {
    const target = attribute(label, "for");
    if (target && this.#labelFor.get(target) === label) return;
    const controls = descendants(label, CONTROLS);
    if (controls.length === 0) {
      this.#children(label, style);
      return;
    }
    this.#flush(false);
    const spans = this.#spansOf(label);
    for (const control of controls) this.#control(control, spans);
  }

  #fieldset(fieldset: DomElement): void {
    this.#flush(false);
    const legend = childElements(fieldset).find((child) => child.tagName === "legend");
    if (this.#fieldsetDepth > 0) {
      if (legend) this.#walk(legend, undefined);
    } else {
      this.#startSection(legend ? this.#spansOf(legend) : []);
    }
    this.#fieldsetDepth++;
    for (const child of childNodes(fieldset)) {
      if (child !== legend) this.#walk(child, undefined);
    }
    this.#flush(false);
    this.#fieldsetDepth--;
    if (this.#fieldsetDepth === 0) this.#startSection([]);
  }

  #startSection(title: Span[]): void {
    if (this.#section.blocks.length === 0 && this.#section.title.length === 0) {
      this.#section.title = title;
      return;
    }
    this.#section = { title, blocks: [] };
    this.#sections.push(this.#section);
  }

  #list(list: DomElement, ordered: boolean): void {
    this.#flush(false);
    if (descendants(list, CONTROLS).length > 0) {
      this.#children(list, undefined);
      this.#flush(false);
      return;
    }
    const items = childElements(list)
      .filter((child) => child.tagName === "li")
      .map((item) => this.#spansOf(item))
      .filter((spans) => spans.length > 0);
    if (items.length > 0) this.#section.blocks.push({ kind: "list", items, ordered });
  }

  #table(table: DomElement): void {
    this.#flush(false);
    const rows = descendants(table, { tr: true }).filter((row) => closest(row, "table") === table);
    const cellsOf = (row: DomElement) =>
      childElements(row).filter((cell) => cell.tagName === "td" || cell.tagName === "th");
    if (descendants(table, CONTROLS).length === 0) {
      const cells = rows.map((row) => cellsOf(row).map((cell) => this.#spansOf(cell)));
      if (cells.some((row) => row.length > 0))
        this.#section.blocks.push({ kind: "table", rows: cells });
      return;
    }
    // A table of controls: each row's text becomes a line, and unlabeled controls borrow their
    // column header as their label.
    let header: Span[][] = [];
    for (const row of rows) {
      const cells = cellsOf(row);
      const rowControls = descendants(row, CONTROLS);
      if (cells.every((cell) => cell.tagName === "th") && rowControls.length === 0) {
        header = cells.map((cell) => this.#spansOf(cell));
        continue;
      }
      const text: Span[] = [];
      for (const cell of cells) {
        if (descendants(cell, CONTROLS).length > 0) continue;
        const spans = this.#spansOf(cell);
        if (spans.length === 0) continue;
        if (text.length > 0) appendSpan(text, " · ", undefined);
        for (const span of spans) appendSpan(text, span.text, span.style);
      }
      if (text.length > 0) this.#section.blocks.push({ kind: "text", spans: text, heading: false });
      cells.forEach((cell, column) => {
        for (const control of descendants(cell, CONTROLS)) {
          const own = closest(control, "label");
          const spans = own && contains(cell, own) ? this.#spansOf(own) : this.#spansOf(cell);
          this.#control(control, spans.length > 0 ? spans : (header[column] ?? []));
        }
      });
    }
  }

  #detachedLabel(control: DomElement): Span[] {
    const id = attribute(control, "id");
    const label = id ? this.#labelFor.get(id) : undefined;
    if (label) return this.#spansOf(label);
    const text = attribute(control, "aria-label") ?? attribute(control, "title");
    return text ? normalizeSpans([{ text }]) : [];
  }

  #control(control: DomElement, wrapping: Span[] | undefined): void {
    this.#flush(false);
    const label = wrapping && wrapping.length > 0 ? wrapping : this.#detachedLabel(control);
    const name = attribute(control, "name") ?? "";
    const required = hasAttribute(control, "required");
    const tag = control.tagName;
    if (tag === "select") {
      const multi = hasAttribute(control, "multiple");
      const options: ChoiceOption[] = descendants(control, { option: true }).map((option) => {
        const text = oneLine(textContent(option));
        return {
          value: attribute(option, "value") ?? text,
          label: [{ text }],
          checked: hasAttribute(option, "selected"),
          disabled: hasAttribute(option, "disabled"),
        };
      });
      // A single select always has a selection: the first enabled option unless one is marked.
      if (!multi && !options.some((option) => option.checked)) {
        const first = options.find((option) => !option.disabled);
        if (first) first.checked = true;
      }
      this.#addField({
        kind: "choice",
        name,
        multi,
        select: true,
        other: false,
        label,
        options,
        required,
      });
      return;
    }
    if (tag === "textarea") {
      this.#addField({
        kind: "text",
        name,
        type: "textarea",
        label: label.length > 0 ? label : nameLabel(name),
        value: textContent(control).replace(/^\r?\n/, ""),
        placeholder: attribute(control, "placeholder") ?? "",
        required,
        minLength: numberAttribute(control, "minlength"),
        maxLength: numberAttribute(control, "maxlength"),
      });
      return;
    }
    const type = (attribute(control, "type") ?? "text").toLowerCase();
    if (IGNORED_INPUTS[type]) return;
    const value = attribute(control, "value");
    if (type === "hidden") {
      if (name) this.#hidden.push([name, value ?? ""]);
      return;
    }
    if (type === "radio" || type === "checkbox") {
      const option: ChoiceOption = {
        value: value ?? "on",
        label: label.length > 0 ? label : [{ text: value ?? name }],
        checked: hasAttribute(control, "checked"),
        disabled: hasAttribute(control, "disabled"),
      };
      const key = `${type}\0${name}`;
      const group = this.#groups.get(key);
      if (group) {
        group.field.options.push(option);
        group.field.required ||= required;
        if (group.section === this.#section && this.#section.blocks.at(-1) !== group.block) {
          group.block.optionsEnd = this.#section.blocks.length;
        }
        return;
      }
      const field: ChoiceField = {
        kind: "choice",
        name,
        multi: type === "checkbox",
        select: false,
        other: false,
        label: [],
        options: [option],
        required,
      };
      this.#groups.set(key, { field, section: this.#section, block: this.#addField(field) });
      return;
    }
    this.#addField({
      kind: "text",
      name,
      type,
      label: label.length > 0 ? label : nameLabel(name),
      value: value ?? "",
      placeholder: attribute(control, "placeholder") ?? "",
      required,
      min: numberAttribute(control, "min"),
      max: numberAttribute(control, "max"),
      pattern: attribute(control, "pattern") ?? undefined,
      minLength: numberAttribute(control, "minlength"),
      maxLength: numberAttribute(control, "maxlength"),
    });
  }

  #addField(field: FormField): Extract<FormBlock, { kind: "field" }> {
    const block: Extract<FormBlock, { kind: "field" }> = { kind: "field", field };
    this.#fields.push(field);
    this.#section.blocks.push(block);
    return block;
  }
}

function nameLabel(name: string): Span[] {
  return name ? [{ text: name.replace(/[_-]+/g, " ") }] : [];
}

function findForm(node: DomNode): DomElement | undefined {
  for (const child of childNodes(node)) {
    if (!isElement(child)) continue;
    if (child.tagName === "form") return child;
    const nested = findForm(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** Content outside the first `<form>` is ignored when one exists, as omp does. */
function parseHtmlForm(html: string): HtmlForm {
  const document = parse(html);
  return new FormBuilder(findForm(document) ?? document).build();
}

/** A checkbox group or multi-select of 2+ options submits an array; every other choice one value. */
function isArrayChoice(field: ChoiceField): boolean {
  return field.multi && field.options.length > 1;
}

function choiceValue(
  field: ChoiceField,
  checked: ReadonlySet<number>,
  other?: string,
): OmpFormValue | undefined {
  const typed = field.other ? other?.trim() : undefined;
  const values = field.options.flatMap((option, index) =>
    checked.has(index) && !option.disabled ? [option.value] : [],
  );
  if (isArrayChoice(field)) return typed ? [...values, typed] : values;
  return typed || values[0];
}

function textValue(field: TextField, text: string): OmpFormValue {
  if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`, "v");
  } catch {
    return undefined;
  }
}

/** Why omp would reject `value` for `field`, or undefined when it accepts it. */
function fieldError(field: FormField, value: OmpFormValue | undefined): string | undefined {
  if (field.kind === "choice") {
    const empty = value === undefined || (Array.isArray(value) && value.length === 0);
    if (!field.required || !empty) return undefined;
    return isArrayChoice(field) ? "Select at least one" : "An answer is required";
  }
  const text = value === undefined ? "" : String(value);
  if (text.trim() === "") return field.required ? "An answer is required" : undefined;
  if (field.type === "number" || field.type === "range") {
    const number = Number(text);
    if (!Number.isFinite(number)) return "Enter a number";
    if (field.min !== undefined && number < field.min) return `Must be at least ${field.min}`;
    if (field.max !== undefined && number > field.max) return `Must be at most ${field.max}`;
  }
  if (field.minLength !== undefined && text.length < field.minLength) {
    return `Needs at least ${field.minLength} characters`;
  }
  if (field.maxLength !== undefined && text.length > field.maxLength) {
    return `At most ${field.maxLength} characters`;
  }
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return "Enter an email address";
  if (field.type === "url" && !URL.canParse(text)) return "Enter a full URL";
  if (field.pattern && compilePattern(field.pattern)?.test(text) === false) {
    return `Must match the pattern ${field.pattern}`;
  }
  return undefined;
}

// The web and mobile cards render a question as markdown.

function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*_[\]<>|~]/g, "\\$&")
    .replace(
      /^(\s*)([#>+-]|\d+[.)])/gm,
      (_, indent: string, marker: string) =>
        `${indent}${marker.replace(/^(\d+)([.)])$/, "$1\\$2").replace(/^([#>+-])$/, "\\$1")}`,
    );
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function spansMarkdown(spans: ReadonlyArray<Span>): string {
  return spans
    .map((span) => {
      if (span.style === "code") return codeSpan(span.text.replace(/\n/g, " "));
      const text = escapeMarkdown(span.text);
      if (span.style === "strong") return `**${text}**`;
      if (span.style === "em") return `*${text}*`;
      return text;
    })
    .join("");
}

function tableMarkdown(rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Span>>>): string {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const line = (cells: ReadonlyArray<string>) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  const cell = (spans: ReadonlyArray<Span>) => spansMarkdown(spans).replace(/\n/g, " ");
  const [head = [], ...body] = rows;
  return [
    line(head.map(cell)),
    line(Array.from({ length: width }, () => "---")),
    ...body.map((row) => line(row.map(cell))),
  ].join("\n");
}

function blockMarkdown(block: FormBlock): string | undefined {
  switch (block.kind) {
    case "text": {
      const text = spansMarkdown(block.spans);
      return block.heading ? `**${text}**` : text;
    }
    case "list":
      return block.items
        .map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${spansMarkdown(item)}`)
        .join("\n");
    case "pre": {
      const longest = Math.max(
        2,
        ...Array.from(block.text.matchAll(/`+/g), (run) => run[0].length),
      );
      const fence = "`".repeat(longest + 1);
      return `${fence}\n${block.text}\n${fence}`;
    }
    case "table":
      return tableMarkdown(block.rows);
    case "image": {
      const alt = escapeMarkdown(block.alt || "image");
      return /^https?:\/\//i.test(block.src)
        ? `[Image: ${alt}](<${block.src.replace(/[<>\s]/g, encodeURIComponent)}>)`
        : `*[Image: ${alt}]*`;
    }
    case "svg":
      return `*[Diagram${block.alt ? `: ${escapeMarkdown(block.alt)}` : ""}]*`;
    case "field":
      return undefined;
  }
}

/** How a named field is asked: a choice, a yes/no toggle (lone checkbox) or free text. */
type OmpFormEntryKind = "choice" | "toggle" | "text";

export interface OmpFormEntry {
  /** The card question's id. */
  readonly id: string;
  readonly kind: OmpFormEntryKind;
  readonly field: FormField;
  readonly header: string;
  /** Markdown before the question: form text since the previous field. */
  readonly context: string;
  readonly question: string;
  /** Value of the synthetic "No answer"/"None"/"No" option, which submits nothing. */
  readonly noneValue: string;
}

export interface OmpFormCard {
  readonly title: string;
  readonly entries: ReadonlyArray<OmpFormEntry>;
  /** Hidden inputs whose name no field carries; echoed as a browser submits them. */
  readonly hidden: ReadonlyArray<readonly [string, string]>;
}

/** A field answer the form rejects, asked again with the reason. */
export interface OmpFormProblem {
  readonly entry: OmpFormEntry;
  readonly message: string;
  readonly answer: string;
}

const NONE_VALUE = "t3:omp-form:none";
const MAX_HEADER_CHARS = 48;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The question each field answers, as omp words it: its own label, else the text right before it,
 * else its section title, else a lone option's label, else its name. A lone checkbox asks its
 * own label, so it reads as a yes/no question.
 */
function fieldQuestions(form: HtmlForm): Map<FormField, string> {
  const questions = new Map<FormField, string>();
  for (const section of form.sections) {
    const title = spansText(section.title);
    let caption = "";
    for (const block of section.blocks) {
      if (block.kind === "field") {
        const field = block.field;
        const own = spansText(field.label);
        const lone =
          field.kind === "choice" && field.options.length === 1
            ? spansText(field.options[0]!.label)
            : "";
        const toggle = field.kind === "choice" && field.multi && !isArrayChoice(field);
        questions.set(
          field,
          oneLine((toggle ? own || lone : "") || own || caption || title || lone || field.name),
        );
        caption = "";
        continue;
      }
      caption = block.kind === "text" ? spansText(block.spans) : "";
    }
  }
  return questions;
}

/**
 * Markdown context of each named field: section titles and blocks since the previous named
 * field, the text between its own options, and for the last field the text after it. Text that
 * is the field's question is left out so it shows once.
 */
function fieldContexts(
  form: HtmlForm,
  questions: ReadonlyMap<FormField, string>,
): Map<FormField, string> {
  type Part = { readonly plain: string; readonly markdown: string };
  const parts = new Map<FormField, Part[]>();
  let pending: Part[] = [];
  let last: Part[] | undefined;
  for (const section of form.sections) {
    const title = spansText(section.title).trim();
    if (title) pending.push({ plain: title, markdown: `**${spansMarkdown(section.title)}**` });
    let owner: Part[] | undefined;
    let ownerEnd = 0;
    for (const [index, block] of section.blocks.entries()) {
      if (block.kind === "field") {
        if (!block.field.name) continue;
        const question = questions.get(block.field);
        const own = pending.filter((part) => oneLine(part.plain) !== question);
        parts.set(block.field, own);
        pending = [];
        last = own;
        owner = own;
        const end = block.optionsEnd ?? 0;
        const intervening = section.blocks.some(
          (later, at) => at > index && at < end && later.kind === "field" && later.field.name,
        );
        ownerEnd = intervening ? 0 : end;
        continue;
      }
      const markdown = blockMarkdown(block);
      if (!markdown?.trim()) continue;
      const plain =
        block.kind === "text"
          ? spansText(block.spans)
          : block.kind === "pre"
            ? block.text
            : markdown;
      const part = { plain, markdown };
      if (owner && index < ownerEnd) owner.push(part);
      else pending.push(part);
    }
  }
  last?.push(...pending);
  const contexts = new Map<FormField, string>();
  for (const [field, own] of parts) {
    contexts.set(field, own.map((part) => part.markdown).join("\n\n"));
  }
  return contexts;
}

function questionId(name: string, index: number, used: Set<string>): string {
  let id = name.trim() === name && name.length > 0 ? name : `field-${index + 1}`;
  while (used.has(id)) id = `${id}-${index + 1}`;
  used.add(id);
  return id;
}

function uniqueNoneValue(field: FormField): string {
  let value = NONE_VALUE;
  while (field.kind === "choice" && field.options.some((option) => option.value === value)) {
    value = `${value}'`;
  }
  return value;
}

/**
 * The card for an omp `form` request, or why it cannot be asked as one: then the request is
 * cancelled, which omp reports to the model as a dismissed form.
 */
export function ompFormCard(html: string): OmpFormCard | { readonly unsupported: string } {
  let form: HtmlForm;
  try {
    form = parseHtmlForm(html);
  } catch (cause) {
    return { unsupported: `the form HTML did not parse: ${String(cause)}` };
  }
  const named = form.fields.filter((field) => field.name.length > 0);
  const byName = new Map<string, number>();
  for (const field of named) byName.set(field.name, (byName.get(field.name) ?? 0) + 1);
  const shared = [...byName].find(([, count]) => count > 1);
  if (shared !== undefined) {
    return { unsupported: `several controls share the name ${JSON.stringify(shared[0])}` };
  }
  const questions = fieldQuestions(form);
  const contexts = fieldContexts(form, questions);
  const titles = new Map<FormField, string>();
  for (const section of form.sections) {
    const title = oneLine(spansText(section.title));
    for (const block of section.blocks) {
      if (block.kind === "field" && title) titles.set(block.field, title);
    }
  }
  const used = new Set<string>();
  const entries: Array<OmpFormEntry> = [];
  for (const [index, field] of named.entries()) {
    const enabled =
      field.kind === "choice" ? field.options.filter((option) => !option.disabled) : [];
    if (field.kind === "choice" && enabled.length === 0 && !field.other) {
      if (field.required) {
        return {
          unsupported: `${JSON.stringify(field.name)} is required but has no enabled option`,
        };
      }
      continue;
    }
    const question = questions.get(field) ?? field.name;
    const title = titles.get(field);
    entries.push({
      id: questionId(field.name, index, used),
      kind:
        field.kind === "text" ? "text" : field.multi && !isArrayChoice(field) ? "toggle" : "choice",
      field,
      header: truncate(
        title !== undefined && title !== question ? title : "Question",
        MAX_HEADER_CHARS,
      ),
      context: contexts.get(field) ?? "",
      question,
      noneValue: uniqueNoneValue(field),
    });
  }
  if (entries.length === 0) return { unsupported: "the form has no named control to answer" };
  const fieldNames = new Set(named.map((field) => field.name));
  const firstTitle = form.sections
    .map((section) => oneLine(spansText(section.title)))
    .find(Boolean);
  return {
    title: truncate(firstTitle ?? entries[0]!.question, 120),
    entries,
    hidden: form.hidden.filter(([name]) => !fieldNames.has(name)),
  };
}

function textHint(field: TextField): string | undefined {
  const parts: string[] = [];
  const kind: Record<string, string> = {
    number: "A number",
    range: "A number",
    email: "An email address",
    url: "A full URL",
    date: "A date (YYYY-MM-DD)",
    time: "A time (HH:MM)",
    "datetime-local": "A date and time (YYYY-MM-DDTHH:MM)",
    month: "A month (YYYY-MM)",
    week: "A week (YYYY-W##)",
    color: "A color (#rrggbb)",
    tel: "A phone number",
  };
  const described = kind[field.type];
  if (described !== undefined) parts.push(described);
  if (field.min !== undefined && field.max !== undefined) {
    parts.push(`from ${field.min} to ${field.max}`);
  } else if (field.min !== undefined) {
    parts.push(`at least ${field.min}`);
  } else if (field.max !== undefined) {
    parts.push(`at most ${field.max}`);
  }
  if (field.minLength !== undefined && field.maxLength !== undefined) {
    parts.push(`${field.minLength}–${field.maxLength} characters`);
  } else if (field.minLength !== undefined) {
    parts.push(`at least ${field.minLength} characters`);
  } else if (field.maxLength !== undefined) {
    parts.push(`at most ${field.maxLength} characters`);
  }
  if (field.pattern) parts.push(`matching ${codeSpan(field.pattern)}`);
  if (field.placeholder.trim()) parts.push(`e.g. ${escapeMarkdown(oneLine(field.placeholder))}`);
  if (!field.required) parts.push("optional");
  if (parts.length === 0) return undefined;
  const [first = "", ...rest] = parts;
  return `*${first.charAt(0).toUpperCase()}${first.slice(1)}${rest.length > 0 ? `, ${rest.join(", ")}` : ""}*`;
}

function option(label: string, description: string, value: string) {
  const shownLabel = oneLine(label) || value || "(empty)";
  return { label: shownLabel, description: oneLine(description) || shownLabel, value };
}

/** The T3 card question for `entry`; `problem` (a rejected earlier answer) leads its text. */
export function ompFormQuestion(
  entry: OmpFormEntry,
  problem?: Pick<OmpFormProblem, "message" | "answer">,
): OrchestrationV2UserInputQuestion {
  const { field } = entry;
  const warning =
    problem === undefined
      ? undefined
      : `**${escapeMarkdown(problem.message)}.**${problem.answer ? ` You answered: ${codeSpan(problem.answer)}` : ""}`;
  const hint = field.kind === "text" ? textHint(field) : undefined;
  // After context the question is bold, so it stands out from the text above it.
  const question = escapeMarkdown(entry.question);
  const questionText = [
    warning,
    entry.context || undefined,
    entry.context ? `**${question}**` : question,
    hint,
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");
  const base = { id: entry.id, header: entry.header, question: questionText };
  if (field.kind === "text") {
    return {
      ...base,
      options: [],
      allowCustomAnswer: true,
      required: field.required,
      ...(field.value === "" ? {} : { initialAnswer: field.value }),
    };
  }
  const seen = new Set<string>();
  const enabled = field.options.filter((choice) => {
    if (choice.disabled || seen.has(choice.value)) return false;
    seen.add(choice.value);
    return true;
  });
  const describe = (choice: ChoiceOption) =>
    choice.checked ? "Recommended" : spansText(choice.label);
  if (entry.kind === "toggle") {
    const yes = enabled[0]!;
    return {
      ...base,
      allowCustomAnswer: false,
      options: [
        option("Yes", yes.checked ? "Recommended" : "Yes", yes.value),
        ...(field.required ? [] : [option("No", "No", entry.noneValue)]),
      ],
    };
  }
  const array = isArrayChoice(field);
  const noneChoice = array
    ? field.required
      ? undefined
      : option("None", "Select none of these", entry.noneValue)
    : field.required || field.select || enabled.some((choice) => choice.checked)
      ? undefined
      : option("No answer", "Leave this unanswered", entry.noneValue);
  return {
    ...base,
    ...(array ? { multiSelect: true } : {}),
    allowCustomAnswer: field.other,
    options: [
      ...enabled.map((choice) => option(spansText(choice.label), describe(choice), choice.value)),
      ...(noneChoice === undefined ? [] : [noneChoice]),
    ],
  };
}

function answerStrings(answer: unknown): ReadonlyArray<string> {
  if (typeof answer === "string") return [answer];
  if (Array.isArray(answer))
    return answer.filter((entry): entry is string => typeof entry === "string");
  return [];
}

/** The option index `text` names: its exact value, else its value or label typed loosely. */
function optionIndex(field: ChoiceField, text: string): number {
  const exact = field.options.findIndex((choice) => !choice.disabled && choice.value === text);
  if (exact >= 0) return exact;
  const loose = oneLine(text).toLowerCase();
  if (!loose) return -1;
  return field.options.findIndex(
    (choice) =>
      !choice.disabled &&
      (oneLine(choice.value).toLowerCase() === loose ||
        oneLine(spansText(choice.label)).toLowerCase() === loose),
  );
}

/** The value `answer` gives `entry`'s field, or a message when the card's answer cannot be one. */
function entryValue(
  entry: OmpFormEntry,
  answer: unknown,
): { readonly value: OmpFormValue | undefined } | { readonly message: string } {
  const { field } = entry;
  const strings = answerStrings(answer);
  if (field.kind === "text") return { value: textValue(field, strings.join("\n")) };
  const values = strings.filter((value) => value !== entry.noneValue);
  if (entry.kind === "toggle") {
    const picked = values.some(
      (value) => optionIndex(field, value) === 0 || oneLine(value).toLowerCase() === "yes",
    );
    return { value: choiceValue(field, new Set(picked ? [0] : [])) };
  }
  const checked = new Set<number>();
  const typed: string[] = [];
  const array = isArrayChoice(field);
  for (const value of values) {
    const index = optionIndex(field, value);
    if (index >= 0) {
      checked.add(index);
      continue;
    }
    // A typed answer to a checkbox group may also name options: "Apple, Kiwi".
    const parts = array ? value.split(/[,\n]/).map((part) => part.trim()) : [];
    const named = parts.map((part) => optionIndex(field, part));
    if (named.some((index) => index >= 0)) {
      parts.forEach((part, at) => {
        const index = named[at]!;
        if (index >= 0) checked.add(index);
        else if (part) typed.push(part);
      });
    } else if (value.trim()) {
      typed.push(value.trim());
    }
  }
  const other = typed.join(", ");
  if (other && !field.other) return { message: "Pick one of the options" };
  if (!array && checked.size > 0) {
    return { value: choiceValue(field, new Set([Math.min(...checked)])) };
  }
  return { value: choiceValue(field, checked, other || undefined) };
}

/**
 * Encodes the card's answers to `entries` into omp's `data`, keeping `accepted` values from
 * earlier rounds. Answers the form would reject come back as problems to ask again.
 */
export function ompFormSubmission(
  card: OmpFormCard,
  entries: ReadonlyArray<OmpFormEntry>,
  answers: Readonly<Record<string, unknown>>,
  accepted: ReadonlyMap<string, OmpFormValue | undefined>,
):
  | { readonly data: Record<string, OmpFormValue> }
  | {
      readonly problems: ReadonlyArray<OmpFormProblem>;
      readonly accepted: ReadonlyMap<string, OmpFormValue | undefined>;
    } {
  const values = new Map(accepted);
  const problems: Array<OmpFormProblem> = [];
  for (const entry of entries) {
    const answer = Object.hasOwn(answers, entry.id) ? answers[entry.id] : undefined;
    const result = entryValue(entry, answer);
    const message = "message" in result ? result.message : fieldError(entry.field, result.value);
    if (message !== undefined) {
      problems.push({ entry, message, answer: answerStrings(answer).join(", ") });
      continue;
    }
    if ("value" in result) values.set(entry.id, result.value);
  }
  if (problems.length > 0) return { problems, accepted: values };
  const data: Record<string, OmpFormValue> = Object.create(null);
  for (const [name, value] of card.hidden) data[name] = value;
  for (const entry of card.entries) {
    const value = values.get(entry.id);
    if (value !== undefined) data[entry.field.name] = value;
  }
  return { data };
}
