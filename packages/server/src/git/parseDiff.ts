/**
 * Unified diff to rows the Diff tab can render directly.
 *
 * Parsed here rather than in the browser for the same reason the plan document
 * is composed here: the client should receive what it displays, not a format it
 * has to understand. It also means the file list and the file's own diff are
 * counted once, from one pass, and cannot disagree about "+38 −9".
 *
 * This reads `git diff` output specifically, not the whole unified-diff dialect
 * — no combined merge diffs, no `--stat` output.
 */

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the old file; null on an added line. */
  oldLine: number | null;
  /** Line number in the new file; null on a deleted line. */
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  /** The `@@ … @@` line, including any function context git put after it. */
  header: string;
  lines: DiffLine[];
}

export type DiffStatus = 'added' | 'deleted' | 'renamed' | 'modified';

export interface DiffFile {
  path: string;
  /** Set only on a rename, where the design shows the move. */
  oldPath: string | null;
  status: DiffStatus;
  additions: number;
  deletions: number;
  /** True for images and anything else git declines to show as text. */
  binary: boolean;
  hunks: DiffHunk[];
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of raw.split('\n')) {
    const header = FILE_HEADER.exec(line);
    if (header) {
      file = {
        path: header[2]!,
        oldPath: null,
        status: 'modified',
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      };
      hunk = null;
      files.push(file);
      continue;
    }
    if (!file) continue;

    // File-level metadata, before the first hunk.
    if (hunk === null) {
      if (line.startsWith('new file')) { file.status = 'added'; continue; }
      if (line.startsWith('deleted file')) { file.status = 'deleted'; continue; }
      if (line.startsWith('rename from ')) { file.oldPath = line.slice('rename from '.length); file.status = 'renamed'; continue; }
      if (line.startsWith('Binary files')) { file.binary = true; continue; }
    }

    const h = HUNK_HEADER.exec(line);
    if (h) {
      oldLine = Number(h[1]);
      newLine = Number(h[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    // "\ No newline at end of file" annotates the line above; it is not one.
    if (line.startsWith('\\')) continue;

    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', oldLine: null, newLine, text: line.slice(1) });
      newLine++;
      file.additions++;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', oldLine, newLine: null, text: line.slice(1) });
      oldLine++;
      file.deletions++;
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ kind: 'context', oldLine, newLine, text: line.slice(1) });
      oldLine++;
      newLine++;
    }
    // Anything else between hunks (an index line, a trailing blank) is not a row.
  }

  return files;
}
