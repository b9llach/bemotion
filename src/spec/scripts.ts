/** Writing systems in copy: which CJK fallback font a text needs, and right-to-left text. */
export type CjkScript = 'japanese' | 'chinese-simplified' | 'korean';

const KANA = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const RTL_CHARS = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;

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
