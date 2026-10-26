/** Rough text width estimate for auto-sizing pills and buttons before layout. */
export function estimateWidth(text: string, size: number, mono = false): number {
  if (mono) return text.length * size * 0.6;
  let w = 0;
  for (const ch of text) {
    if (/[mwMW@]/.test(ch)) w += 0.85;
    else if (/[A-Z0-9]/.test(ch)) w += 0.66;
    else if (/[iljtf.,:;'|!]/.test(ch)) w += 0.3;
    else if (ch === ' ') w += 0.28;
    else w += 0.54;
  }
  return w * size;
}
