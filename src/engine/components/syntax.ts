export interface Token {
  text: string;
  color: string;
}

const COLORS = {
  keyword: '#C792EA',
  string: '#C3E88D',
  number: '#F78C6C',
  comment: '#5C6370',
  fn: '#82AAFF',
  punct: '#89DDFF',
  type: '#FFCB6B',
  plain: '#D6DEEB',
};

const KEYWORDS = new Set(
  (
    'const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of yield ' +
    'def lambda pass with as elif None True False and or not is self print ' +
    'fn pub struct enum impl use mod match mut ' +
    'true false null undefined this interface type public private protected static readonly'
  ).split(' '),
);

const PATTERNS: [RegExp, keyof typeof COLORS | 'ident'][] = [
  [/^(\/\/.*|#.*)/, 'comment'],
  [/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/, 'string'],
  [/^(0x[0-9a-fA-F]+|\d+(?:\.\d+)?)/, 'number'],
  [/^([A-Za-z_$][\w$]*)/, 'ident'],
  [/^(\s+)/, 'plain'],
  [/^([{}()[\];,.:=<>+\-*/%!&|?^~@]+)/, 'punct'],
  [/^(.)/, 'plain'],
];

/** Tiny regex highlighter good enough for marketing shots of JS/TS/Python/Rust/shell. */
export function highlightCode(line: string, language?: string): Token[] {
  const out: Token[] = [];
  let rest = line;
  const isShell = language === 'bash' || language === 'sh' || language === 'shell';
  if (isShell && /^\s*\$\s/.test(rest)) {
    const m = /^(\s*\$\s)/.exec(rest)!;
    out.push({ text: m[1], color: COLORS.punct });
    rest = rest.slice(m[1].length);
  }
  while (rest.length) {
    for (const [re, kind] of PATTERNS) {
      if (kind === 'comment' && language !== 'python' && !isShell && rest.startsWith('#')) continue;
      const m = re.exec(rest);
      if (!m) continue;
      const text = m[1];
      let color: string = COLORS.plain;
      if (kind === 'ident') {
        const after = rest.slice(text.length);
        if (KEYWORDS.has(text)) color = COLORS.keyword;
        else if (/^\s*\(/.test(after)) color = COLORS.fn;
        else if (/^[A-Z]/.test(text)) color = COLORS.type;
        else if (isShell && out.length === 0) color = COLORS.fn;
      } else {
        color = COLORS[kind];
      }
      const prev = out[out.length - 1];
      if (prev && prev.color === color) prev.text += text;
      else out.push({ text, color });
      rest = rest.slice(text.length);
      break;
    }
  }
  return out;
}
