/** Parse `git diff --unified=0 base head` output. Lines are 0-based. */
export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  /** Inclusive [start, end] ranges added/changed at HEAD. */
  added: [number, number][];
  /** Content of removed lines (for deleted-function detection). */
  removedLines: string[];
  addedLines: string[];
}

export function parseUnifiedDiff(text: string): Map<string, FileDiff> {
  const out = new Map<string, FileDiff>();
  let cur: FileDiff | undefined;
  const unq = (p: string) => (p.startsWith('"') ? JSON.parse(p) as string : p);
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { oldPath: null, newPath: null, added: [], removedLines: [], addedLines: [] };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('--- ')) {
      const p = unq(line.slice(4));
      cur.oldPath = p === '/dev/null' ? null : p.replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      const p = unq(line.slice(4));
      cur.newPath = p === '/dev/null' ? null : p.replace(/^b\//, '');
      out.set(cur.newPath ?? cur.oldPath ?? '', cur);
    } else if (line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        if (count > 0) cur.added.push([start - 1, start - 1 + count - 1]);
      }
    } else if (line.startsWith('-')) cur.removedLines.push(line.slice(1));
    else if (line.startsWith('+')) cur.addedLines.push(line.slice(1));
  }
  return out;
}

const FUNC_DECL: RegExp[] = [
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/, // Go
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, // TS/JS function
  /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, // arrow
];

/** Names of functions declared in removed lines. */
export function removedFunctionNames(d: FileDiff): string[] {
  const names: string[] = [];
  for (const l of d.removedLines) {
    for (const re of FUNC_DECL) {
      const m = re.exec(l);
      if (m) {
        names.push(m[1]!);
        break;
      }
    }
  }
  return names;
}

export function overlaps(ranges: [number, number][], start: number, end: number): boolean {
  return ranges.some(([a, b]) => a <= end && b >= start);
}

export function covers(ranges: [number, number][], start: number, end: number): boolean {
  let line = start;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a > line) break;
    if (b >= line) line = b + 1;
    if (line > end) return true;
  }
  return line > end;
}
