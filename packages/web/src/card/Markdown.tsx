import type { ReactNode } from 'react';
import { Code } from './ui.js';

/**
 * Long-form writing — a plan's sections, a card's brief, Claude's notes on
 * what it built — rendered as the Markdown it was written in.
 *
 * A deliberately small subset: paragraphs, lists, fenced code, quotes and
 * rules; code, bold, emphasis and links inline. That covers what Claude and a
 * person actually type into these fields, and it builds elements rather than
 * HTML, so nothing written here can smuggle markup into the page.
 *
 * Two departures from CommonMark, both on purpose. A single newline stays a
 * line break, because these fields were shown pre-wrapped before they were
 * Markdown and what people wrote leans on that. And a `#` heading is only a
 * bold line: the section already has its heading, and a second, louder one
 * inside it would outrank the eyebrow.
 */
export function Markdown({ children, className = '' }: { children: string; className?: string }) {
  return <div className={`flex flex-col gap-2 text-sm/5 text-(--color-text) ${className}`}>{blocks(children)}</div>;
}

/** The inline half alone, for a field that sits inside a line of its own. */
export function InlineMarkdown({ children }: { children: string }) {
  return <>{inline(children)}</>;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

const indent = (line: string) => line.length - line.trimStart().length;

const startsBlock = (line: string) =>
  FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || ITEM.test(line) || RULE.test(line);

function blocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const key = out.length;

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith(marker)) code.push(lines[i++] ?? '');
      i++;
      out.push(
        <pre
          key={key}
          className="overflow-x-auto rounded-sm border border-(--color-edge) bg-(--color-ink) p-2 font-mono text-[11px]/4 text-(--color-text)"
        >
          {code.join('\n')}
        </pre>,
      );
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr key={key} className="border-(--color-edge)" />);
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push(<p key={key} className="font-medium">{inline(heading[1] ?? '')}</p>);
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      let m: RegExpExecArray | null;
      while (i < lines.length && (m = QUOTE.exec(lines[i] ?? ''))) {
        quoted.push(m[1] ?? '');
        i++;
      }
      out.push(
        <blockquote key={key} className="flex flex-col gap-2 border-l-2 border-(--color-edge) pl-3 text-(--color-muted)">
          {blocks(quoted.join('\n'))}
        </blockquote>,
      );
      continue;
    }

    const first = ITEM.exec(line);
    if (first) {
      // An item runs until the next one at its own depth. Anything indented
      // past that — a nested list, a fence, a second paragraph — belongs to it
      // and is rendered by these same rules. A blank line between two items
      // does not split the list, or restart its numbering.
      const depth = indent(line);
      const column = line.length - (first[2] ?? '').length;
      const within = (s: string) => s.trim() !== '' && indent(s) > depth;
      const sibling = (s: string) => ITEM.test(s) && indent(s) <= depth;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const last = items.length - 1;
        if (sibling(current)) items.push(ITEM.exec(current)?.[2] ?? '');
        else if (within(current)) items[last] = `${items[last]}\n${current.slice(Math.min(indent(current), column))}`;
        else if (!current.trim() && (sibling(lines[i + 1] ?? '') || within(lines[i + 1] ?? ''))) items[last] = `${items[last]}\n`;
        else break;
        i++;
      }
      const shown = items.map((text, n) => <li key={n} className="space-y-1">{blocks(text)}</li>);
      const list = 'flex flex-col gap-1 pl-5 marker:text-(--color-muted)';
      const start = first[1] ?? '';
      out.push(
        /\d/.test(start) ? (
          <ol key={key} start={Number.parseInt(start, 10)} className={`${list} list-decimal`}>{shown}</ol>
        ) : (
          <ul key={key} className={`${list} list-disc`}>{shown}</ul>
        ),
      );
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() && !(paragraph.length && startsBlock(lines[i] ?? ''))) {
      paragraph.push(lines[i++] ?? '');
    }
    out.push(<p key={key} className="whitespace-pre-wrap">{inline(paragraph.join('\n'))}</p>);
  }

  return out;
}

/**
 * Code, links, bold, emphasis and bare URLs, earliest match first. Code is
 * taken literally; everything else may hold more of the same. An underscore
 * only emphasises at a word's edge, so `snake_case_names` stay as written.
 */
const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|\*\*(?=\S)(.+?)\*\*|__(?=\S)(.+?)__|\*(?=[^\s*])(.+?)\*|(?<!\w)_(?=[^\s_])(.+?)_(?!\w)|(https?:\/\/[^\s<]*[^\s<.,:;!?"')\]])/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;

  for (const m of text.matchAll(INLINE)) {
    const [whole, code, label, href, strong, strongAlt, em, emAlt, url] = m;
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    last = at + whole.length;
    const key = out.length;

    if (code !== undefined) out.push(<Code key={key}>{code}</Code>);
    else if (label !== undefined) out.push(link(key, href ?? '', inline(label)));
    else if (strong !== undefined || strongAlt !== undefined) {
      out.push(<strong key={key} className="font-semibold">{inline(strong ?? strongAlt ?? '')}</strong>);
    } else if (em !== undefined || emAlt !== undefined) {
      out.push(<em key={key}>{inline(em ?? emAlt ?? '')}</em>);
    } else if (url !== undefined) out.push(link(key, url, url));
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Only somewhere a browser should go: a relative path or a `javascript:` URL stays text. */
function link(key: number, href: string, children: ReactNode): ReactNode {
  if (!/^(https?:|mailto:)/i.test(href)) return <span key={key}>{children}</span>;
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:decoration-sky-300"
    >
      {children}
    </a>
  );
}
