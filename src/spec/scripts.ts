/** Writing systems in copy: which CJK fallback font a text needs, and right-to-left text. */
export type CjkScript = 'japanese' | 'chinese-simplified' | 'korean';

const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const HAN = /[㐀-䶿一-鿿豈-﫿]/;
const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;

/** The CJK script a text is in: kana means Japanese (kanji included), Hangul Korean, other Han Chinese. */
export function cjkScript(text: string): CjkScript | null {
  if (KANA.test(text)) return 'japanese';
  if (HANGUL.test(text)) return 'korean';
  if (HAN.test(text)) return 'chinese-simplified';
  return null;
}

/** Whether a text has Hebrew, Arabic or other right-to-left letters. */
export function hasRtl(text: string): boolean {
  return RTL_CHARS.test(text);
}
