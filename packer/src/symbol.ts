/** Parsing of SCIP symbol strings: "<scheme> <manager> <package> <version> <descriptors>" or "local <id>". */

export interface Descriptor {
  name: string;
  /** '/' namespace, '#' type, '.' term, '().' method, ':' meta, '!' macro, '[]' type param, '()' param */
  suffix: '/' | '#' | '.' | '().' | ':' | '!' | '[]' | '()';
  disambiguator?: string;
}

export interface ParsedSymbol {
  local: boolean;
  scheme: string;
  manager: string;
  pkg: string;
  version: string;
  /** Raw descriptor text (everything after the version). */
  raw: string;
  descriptors: Descriptor[];
}

function splitHeader(s: string): [string[], string] {
  const parts: string[] = [];
  let i = 0;
  while (parts.length < 4 && i < s.length) {
    let cur = '';
    while (i < s.length) {
      if (s[i] === ' ') {
        if (s[i + 1] === ' ') {
          cur += ' ';
          i += 2;
          continue;
        }
        i++;
        break;
      }
      cur += s[i++];
    }
    parts.push(cur === '.' ? '' : cur);
  }
  return [parts, s.slice(i)];
}

export function parseDescriptors(raw: string): Descriptor[] {
  const out: Descriptor[] = [];
  let i = 0;
  const readName = (): string => {
    if (raw[i] === '`') {
      let name = '';
      i++;
      while (i < raw.length) {
        if (raw[i] === '`') {
          if (raw[i + 1] === '`') {
            name += '`';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        name += raw[i++];
      }
      return name;
    }
    const start = i;
    while (i < raw.length && /[\w+\-$]/.test(raw[i]!)) i++;
    return raw.slice(start, i);
  };
  while (i < raw.length) {
    if (raw[i] === '[') {
      i++;
      const name = readName();
      i++; // ]
      out.push({ name, suffix: '[]' });
      continue;
    }
    if (raw[i] === '(') {
      i++;
      const name = readName();
      i++; // )
      out.push({ name, suffix: '()' });
      continue;
    }
    const name = readName();
    const c = raw[i];
    if (c === '(') {
      const close = raw.indexOf(')', i);
      const dis = raw.slice(i + 1, close);
      i = close + 1;
      if (raw[i] === '.') i++;
      out.push({ name, suffix: '().', ...(dis ? { disambiguator: dis } : {}) });
    } else if (c === '/' || c === '#' || c === '.' || c === ':' || c === '!') {
      i++;
      out.push({ name, suffix: c });
    } else {
      // Malformed; stop rather than loop forever.
      if (name) out.push({ name, suffix: '.' });
      break;
    }
  }
  return out;
}

export function parseSymbol(s: string): ParsedSymbol {
  if (s.startsWith('local ')) {
    return { local: true, scheme: 'local', manager: '', pkg: '', version: '', raw: s.slice(6), descriptors: [] };
  }
  const [[scheme = '', manager = '', pkg = '', version = ''], raw] = splitHeader(s);
  return { local: false, scheme, manager, pkg, version, raw, descriptors: parseDescriptors(raw) };
}

/** Namespace path (e.g. Go import path, TS file path) and the non-namespace descriptors. */
export function splitNamespace(p: ParsedSymbol): { ns: string; rest: Descriptor[]; restRaw: string } {
  const ns: string[] = [];
  let k = 0;
  while (k < p.descriptors.length && p.descriptors[k]!.suffix === '/') ns.push(p.descriptors[k++]!.name);
  // Recompute the raw text after the namespace descriptors.
  let restRaw = p.raw;
  for (let n = 0; n < k; n++) {
    restRaw = restRaw.startsWith('`') ? restRaw.slice(restRaw.indexOf('`/', 1) + 2) : restRaw.slice(restRaw.indexOf('/') + 1);
  }
  return { ns: ns.join('/'), rest: p.descriptors.slice(k), restRaw };
}

/** Human label like "OrderService.Create" or "service.validate". */
export function labelOf(p: ParsedSymbol, displayName?: string): { name: string; label: string; pkg: string } {
  if (p.local) return { name: displayName || 'local', label: displayName || 'local', pkg: '' };
  const { ns, rest } = splitNamespace(p);
  const named = rest.filter((d) => d.suffix !== '()' && d.suffix !== '[]');
  const name = displayName || named.at(-1)?.name || ns.split('/').at(-1) || p.pkg;
  if (named.length === 0) return { name, label: name, pkg: ns };
  if (named.length === 1) {
    const short = ns.split('/').at(-1)?.replace(/(\.d)?\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '');
    return { name, label: short ? `${short}.${name}` : name, pkg: ns };
  }
  return { name, label: named.map((d) => d.name).join('.'), pkg: ns };
}

/** Link target for symbols outside the repository. */
export function externalUrl(p: ParsedSymbol): string | undefined {
  if (p.local) return undefined;
  const { ns, rest } = splitNamespace(p);
  if (p.manager === 'gomod') {
    const anchor = rest
      .filter((d) => d.suffix === '#' || d.suffix === '().' || d.suffix === '.')
      .map((d) => d.name)
      .join('.');
    const std = p.pkg === 'github.com/golang/go/src' || p.pkg === 'std';
    const path = ns || p.pkg;
    const ver = !std && p.version && p.version !== '.' ? `@${p.version}` : '';
    return `https://pkg.go.dev/${path}${ver}${anchor ? '#' + anchor : ''}`;
  }
  if (p.manager === 'npm' && p.pkg) {
    return `https://www.npmjs.com/package/${p.pkg}${p.version ? '/v/' + p.version : ''}`;
  }
  return undefined;
}
