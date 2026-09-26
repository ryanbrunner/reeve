import { useEffect, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown.js';
import { Code } from './ui.js';

/**
 * Writing that looks the way it will read: the brief, edited in place as the
 * page shows it rather than as Markdown in a textarea.
 *
 * What is stored is still Markdown. Every stage reads the brief as prompt, and
 * so do the CLI and a handoff, so the field goes in and out as Markdown and is
 * only rich while it is open. It starts from what `Markdown` renders, and is
 * written back to the dialect `Markdown` reads, with its departures: a line
 * break is a single newline, and a heading keeps its `#`s.
 *
 * Built on `contentEditable` and `execCommand` rather than an editor library.
 * The dialect is small enough that the two directions fit in this file, and
 * `Markdown` already hand-rolls one of them. The price is that the browser's
 * own editing decides the markup, so the serializer below reads leniently:
 * `<b>` or `<strong>`, a `<div>` or a `<p>`, a list nested inside an item or
 * beside one.
 *
 * Nothing is written back unless something was changed. The round trip is
 * faithful but not exact — `_this_` comes back as `*this*` — and opening the
 * brief and clicking away must not rewrite what someone typed.
 */
export function RichText({
  initial,
  label,
  placeholder,
  disabled,
  upload,
  onDone,
  onError,
}: {
  /** The Markdown to start from. Read once, when the field opens. */
  initial: string;
  label: string;
  placeholder: string;
  disabled: boolean;
  /** Stores a pasted image, resolving to the `src` the body links it by. */
  upload: (file: File) => Promise<string>;
  /** Leaving the field: the Markdown, or null when nothing was changed. */
  onDone: (markdown: string | null) => void;
  onError: (message: string) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  // A blur while an image is still uploading waits for it, or the saved body
  // would be missing the picture the person just pasted.
  const uploading = useRef(0);
  const leaving = useRef(false);
  const [blank, setBlank] = useState(!initial.trim());
  const [linking, setLinking] = useState<{ range: Range; href: string } | null>(null);

  // Seeded once and never rendered into again: React owns the element, the
  // browser owns what is in it. `initial` is deliberately not a dependency, as
  // a poll of the card landing mid-edit must not put the old body back.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    el.innerHTML = seed(initial);
    // Enter makes a paragraph, which is what a blank line reads back as.
    document.execCommand('defaultParagraphSeparator', false, 'p');
    el.focus();
    const end = document.createRange();
    end.selectNodeContents(el);
    end.collapse(false);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(end);
  }, []);

  const finish = () => {
    if (uploading.current > 0) {
      leaving.current = true;
      return;
    }
    leaving.current = false;
    onDone(dirty.current && root.current ? toMarkdown(root.current) : null);
  };

  const changed = () => {
    dirty.current = true;
    if (root.current) setBlank(isBlank(root.current));
  };

  const exec = (command: string, value?: string) => {
    document.execCommand(command, false, value);
    changed();
  };

  /** The block the caret is in, if it is one of these. */
  const within = (selector: string) => {
    const node = getSelection()?.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement;
    const found = el?.closest(selector);
    return found && root.current?.contains(found) ? found : null;
  };

  const code = () => {
    const inside = within('code');
    if (inside) {
      inside.replaceWith(inside.textContent ?? '');
      changed();
      return;
    }
    const text = getSelection()?.toString();
    if (text) exec('insertHTML', renderToStaticMarkup(<Code>{text}</Code>));
  };

  const startLink = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || !root.current?.contains(selection.anchorNode)) return;
    setLinking({ range: selection.getRangeAt(0).cloneRange(), href: '' });
  };

  const applyLink = () => {
    if (!linking) return;
    const { range } = linking;
    const raw = linking.href.trim();
    setLinking(null);
    root.current?.focus();
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    if (!raw) return;
    // `Markdown` only links somewhere a browser can go, so a bare domain
    // is taken to be on the web rather than left to read back as text.
    const href = /^[a-z][\w+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    if (!range.collapsed) return exec('createLink', href);
    const a = document.createElement('a');
    a.href = href;
    a.textContent = raw;
    exec('insertHTML', a.outerHTML);
  };

  const tools: Array<{ label: string; title: string; run: () => void; className?: string }> = [
    { label: 'B', title: 'Bold (⌘B)', run: () => exec('bold'), className: 'font-bold' },
    { label: 'I', title: 'Italic (⌘I)', run: () => exec('italic'), className: 'italic' },
    { label: 'H', title: 'Heading', run: () => exec('formatBlock', within('h1,h2,h3,h4,h5,h6') ? 'p' : 'h2') },
    { label: 'Code', title: 'Code', run: code },
    { label: 'Link', title: 'Link (⌘K)', run: startLink },
    { label: '•', title: 'Bulleted list', run: () => exec('insertUnorderedList') },
    { label: '1.', title: 'Numbered list', run: () => exec('insertOrderedList') },
    // Out of a quote is an outdent: a paragraph formatted inside one stays in it.
    { label: '❝', title: 'Quote', run: () => (within('blockquote') ? exec('outdent') : exec('formatBlock', 'blockquote')) },
  ];

  const keys = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'k') {
      e.preventDefault();
      startLink();
    } else if (mod && e.key === 'Enter') {
      e.preventDefault();
      root.current?.blur();
    } else if (e.key === 'Tab' && within('li')) {
      // In a list, Tab nests the item rather than leaving the field.
      e.preventDefault();
      exec(e.shiftKey ? 'outdent' : 'indent');
    } else if (e.key === 'Enter' && !e.shiftKey && within('pre')) {
      // A new line of code, not a second code block.
      e.preventDefault();
      exec('insertLineBreak');
    }
  };

  /**
   * An image is stored at once and linked where it was pasted. Anything else
   * goes in as plain text: a web page's markup is not something the Markdown
   * can say, and Markdown pasted as text reads back as itself.
   */
  const paste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const images = [...e.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!images.length) return exec('insertText', e.clipboardData.getData('text/plain'));

    for (const file of images) {
      // Shown from memory while it uploads, and marked, so the serializer
      // leaves it out until it has an address the body can keep.
      const key = crypto.randomUUID();
      const preview = URL.createObjectURL(file);
      const img = document.createElement('img');
      img.src = preview;
      img.alt = /^image\.\w+$/.test(file.name) ? 'Pasted image' : file.name.replace(/\.\w+$/, '');
      img.dataset['pending'] = key;
      exec('insertHTML', img.outerHTML);

      uploading.current++;
      const placed = () => root.current?.querySelector<HTMLImageElement>(`img[data-pending="${key}"]`);
      upload(file)
        .then(
          (src) => {
            const el = placed();
            el?.setAttribute('src', src);
            el?.removeAttribute('data-pending');
            changed();
          },
          (err: Error) => {
            placed()?.remove();
            changed();
            onError(`The image was not saved: ${err.message}`);
          },
        )
        .finally(() => {
          URL.revokeObjectURL(preview);
          uploading.current--;
          if (!uploading.current && leaving.current) finish();
        });
    }
  };

  const tool =
    'rounded-sm px-1.5 py-[3px] font-mono text-[11px]/4 text-(--color-muted) hover:bg-slate-500/15 hover:text-(--color-text) disabled:opacity-40';

  return (
    <div
      ref={wrapper}
      // Focus moving between the text, the toolbar and the link box is still
      // editing. Only leaving all three is done.
      onBlur={(e) => {
        if (!wrapper.current?.contains(e.relatedTarget as Node | null)) finish();
      }}
      onFocus={() => { leaving.current = false; }}
      className="flex max-w-[40rem] flex-col rounded-md border border-(--color-edge) bg-(--color-ink) focus-within:border-sky-600"
    >
      <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b border-(--color-edge) px-1.5 py-1">
        {tools.map((t) => (
          <button
            key={t.title}
            type="button"
            title={t.title}
            aria-label={t.title}
            disabled={disabled}
            // Kept off the button, so the selection it acts on stays where it is.
            onMouseDown={(e) => e.preventDefault()}
            onClick={t.run}
            className={`${tool} ${t.className ?? ''}`}
          >
            {t.label}
          </button>
        ))}
        {linking && (
          <input
            autoFocus
            value={linking.href}
            placeholder="https://…"
            aria-label="Link to"
            onChange={(e) => setLinking({ ...linking, href: e.target.value })}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              applyLink();
            }}
            onBlur={() => setLinking(null)}
            className="ml-1 w-56 rounded-sm border border-(--color-edge) bg-(--color-ink) px-1.5 py-px font-mono text-[11px]/4 outline-none placeholder:text-(--color-muted) focus:border-sky-600"
          />
        )}
        <span className="ml-auto pr-1 font-mono text-[10px]/4 text-(--color-muted)">Paste an image to add it</span>
      </div>
      <div className="relative">
        {blank && (
          <span className="pointer-events-none absolute top-3 left-3 text-sm/5 text-(--color-muted)">{placeholder}</span>
        )}
        <div
          ref={root}
          role="textbox"
          aria-multiline
          aria-label={label}
          contentEditable={!disabled}
          onInput={changed}
          onKeyDown={keys}
          onPaste={paste}
          // The descendants are styled here rather than per element, because
          // the browser makes lists, quotes and links without `Markdown`'s
          // classes. 6.5rem is four rows and their padding, the textarea's
          // size before it.
          className={[
            'min-h-[6.5rem] space-y-2 p-3 text-sm/5 whitespace-pre-wrap text-(--color-text) outline-none',
            '[&_:is(ul,ol)]:pl-5 [&_li]:marker:text-(--color-muted) [&_ol]:list-decimal [&_ul]:list-disc',
            '[&_blockquote]:border-l-2 [&_blockquote]:border-(--color-edge) [&_blockquote]:pl-3 [&_blockquote]:text-(--color-muted)',
            '[&_:is(h1,h2,h3,h4,h5,h6)]:font-medium [&_a]:text-sky-300 [&_a]:underline [&_a]:decoration-sky-300/40',
            '[&_img]:max-h-96 [&_img]:max-w-full [&_img]:rounded-sm [&_img[data-pending]]:opacity-50',
          ].join(' ')}
        />
      </div>
    </div>
  );
}

/**
 * The editor's starting markup: the brief exactly as the page shows it, but
 * with its headings made headings again. `Markdown` draws them as bold
 * paragraphs, and Enter at the end of one would copy the paragraph, level and
 * all, onto the next line.
 */
function seed(markdown: string): string {
  const html = renderToStaticMarkup(<Markdown>{markdown}</Markdown>);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const shown = doc.body.firstElementChild;
  if (!shown) return '<p><br></p>';
  for (const p of shown.querySelectorAll<HTMLElement>('p[data-heading]')) {
    const h = doc.createElement(`h${p.dataset['heading']}`);
    h.append(...p.childNodes);
    p.replaceWith(h);
  }
  return shown.innerHTML || '<p><br></p>';
}

function isBlank(el: HTMLElement): boolean {
  return !el.textContent?.trim() && !el.querySelector('img');
}

// --- back to Markdown --------------------------------------------------------

const BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'HR']);
const LIST_LINE = /^([-*+]|\d{1,9}[.)])\s/;

const isElement = (node: Node): node is HTMLElement => node.nodeType === Node.ELEMENT_NODE;
const isBlock = (node: Node): node is HTMLElement => isElement(node) && BLOCKS.has(node.tagName);

function toMarkdown(root: HTMLElement): string {
  return blocksOf(root).join('\n\n').trim();
}

/**
 * The blocks under an element, in order. Loose inline content between them —
 * text typed straight into the field, before the browser wrapped it — is a
 * paragraph of its own.
 */
function blocksOf(parent: Node): string[] {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    // A block's last `<br>` is the browser holding an empty line open.
    const text = inlineOf(run).replace(/\n+$/, '');
    if (text.trim()) out.push(text);
    run = [];
  };
  for (const node of parent.childNodes) {
    if (!isBlock(node)) {
      run.push(node);
      continue;
    }
    flush();
    const block = blockOf(node);
    if (block.trim()) out.push(block);
  }
  flush();
  return out;
}

function blockOf(el: HTMLElement): string {
  switch (el.tagName) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      const text = inlineOf(el.childNodes).replace(/\s*\n\s*/g, ' ').trim();
      return text ? `${'#'.repeat(Number(el.tagName[1]))} ${text}` : '';
    }
    case 'UL': case 'OL':
      return listOf(el);
    case 'BLOCKQUOTE':
      return blocksOf(el).join('\n\n').split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
    case 'PRE':
      return `\`\`\`\n${literal(el).replace(/\n$/, '')}\n\`\`\``;
    case 'HR':
      return '---';
    default:
      return blocksOf(el).join('\n\n');
  }
}

/**
 * One line per item, with whatever else is in an item indented under its
 * marker. A list the browser nested beside an item, rather than inside it,
 * belongs to the item before.
 */
function listOf(el: HTMLElement): string {
  const ordered = el.tagName === 'OL';
  let n = Number(el.getAttribute('start') ?? 1) || 1;
  const items: string[][] = [];
  for (const child of el.childNodes) {
    if (isElement(child) && (child.tagName === 'UL' || child.tagName === 'OL')) {
      const last = items.at(-1);
      if (last) last.push(listOf(child));
      else items.push([listOf(child)]);
    } else if (isElement(child) && child.tagName === 'LI') {
      items.push(blocksOf(child));
    } else if (child.textContent?.trim()) {
      items.push([inlineOf([child])]);
    }
  }
  return items
    .filter((blocks) => blocks.length)
    .map((blocks) => {
      const marker = ordered ? `${n++}. ` : '- ';
      const pad = ' '.repeat(marker.length);
      // A nested list sits on the next line; a second paragraph after a blank one.
      const body = blocks.reduce((acc, b, i) =>
        i === 0 ? b : `${acc}${LIST_LINE.test(b) || LIST_LINE.test(blocks[i - 1] ?? '') ? '\n' : '\n\n'}${b}`,
      '');
      return marker + body.split('\n').map((line, i) => (i === 0 || !line ? line : pad + line)).join('\n');
    })
    .join('\n');
}

function inlineOf(nodes: Iterable<Node>): string {
  let out = '';
  for (const node of nodes) out += inlineNode(node);
  return out;
}

function inlineNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/ /g, ' ');
  if (!isElement(node)) return '';
  switch (node.tagName) {
    case 'BR':
      return '\n';
    case 'IMG': {
      if (node.dataset['pending']) return '';
      const alt = (node.getAttribute('alt') ?? '').replace(/[[\]\n]/g, '');
      return `![${alt}](${node.getAttribute('src') ?? ''})`;
    }
    case 'CODE': {
      // The dialect has no way to put a backtick inside code.
      const text = (node.textContent ?? '').replace(/[`\n]/g, '');
      return text ? `\`${text}\`` : '';
    }
    case 'B': case 'STRONG':
      return wrap('**', inlineOf(node.childNodes));
    case 'I': case 'EM':
      return wrap('*', inlineOf(node.childNodes));
    case 'A': {
      const text = inlineOf(node.childNodes);
      const href = (node.getAttribute('href') ?? '').replace(/ /g, '%20');
      // A bare URL was written bare, and `Markdown` links it on its own.
      if (!href || text === href) return text || href;
      return text.trim() ? `[${text.replace(/[[\]\n]/g, '')}](${href})` : '';
    }
    default:
      // A block the browser left inside an inline element is still a new line.
      return BLOCKS.has(node.tagName) ? `\n${blocksOf(node).join('\n')}\n` : inlineOf(node.childNodes);
  }
}

/**
 * Emphasis hugs its text: `** bold**` is not bold to `Markdown`, so the
 * spaces a selection took with it go outside the markers.
 */
function wrap(marker: string, text: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const [, before = '', inner = '', after = ''] = m ?? [];
  return inner ? `${before}${marker}${inner}${marker}${after}` : text;
}

/** A code block's text, with the line breaks the browser made as `<br>`s. */
function literal(el: HTMLElement): string {
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? '';
    else if (isElement(node)) out += node.tagName === 'BR' ? '\n' : `${isBlock(node) ? '\n' : ''}${literal(node)}`;
  }
  return out;
}
