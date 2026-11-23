// Chat text sanitation (DESIGN §8): strip control characters, replace URLs, mask a small,
// intentionally non-exhaustive list of slurs/obscenities. The list is kept short so the cost of
// scanning every chat line stays negligible and so it does not pretend to be a real moderation
// system. Reports + the auto-flag rule cover the rest.

const URL_RE =
  /(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|jp|io|co|dev|app|xyz|info|biz|me|tv|gg|ly)(?:\/[^\s<>"'`]*)?/gi;

/** Japanese words are matched as substrings; English words require word boundaries. */
const NG_WORDS: readonly string[] = [
  // Japanese (non-exhaustive; deliberately short)
  '死ね',
  '殺す',
  '殺せ',
  '消えろ',
  'カス',
  'クソ',
  'バカ',
  'アホ',
  'ブス',
  'チンポ',
  'マンコ',
  'レイプ',
  // English (non-exhaustive)
  'fuck',
  'fucking',
  'shit',
  'bitch',
  'bastard',
  'asshole',
  'cunt',
  'dick',
  'pussy',
  'retard',
  'nigger',
  'faggot',
];

function maskWord(word: string): string {
  // Mask one ＊ per code point so the length of the offending token is still recognisable.
  return '＊'.repeat(Math.max(1, Array.from(word).length));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NG_PATTERNS: readonly { re: RegExp; word: string }[] = NG_WORDS.map((word) => {
  const isAscii = /^[a-z]+$/i.test(word);
  const source = isAscii ? `\\b${escapeRegExp(word)}\\b` : escapeRegExp(word);
  return { re: new RegExp(source, isAscii ? 'gi' : 'g'), word };
});

/** Remove C0/C1 control characters and zero-width / bidi overrides. Keeps ordinary spaces. */
export function stripControlChars(input: string): string {
  return input.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, '');
}

/** NFKC + lowercase + whitespace removal, used for duplicate and moderation matching. */
export function normalizeForMatch(input: string): string {
  return stripControlChars(input)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, '')
    .trim();
}

/** Mask URLs and NG words. Returns already-trimmed NFKC text. */
export function filterText(input: string): string {
  let text = stripControlChars(input).normalize('NFKC').replace(/\s+/g, ' ').trim();
  text = text.replace(URL_RE, '[URL]');
  for (const { re, word } of NG_PATTERNS) {
    text = text.replace(re, () => maskWord(word));
  }
  return text;
}

/** Truncate to `max` Unicode code points. */
export function capText(input: string, max: number): string {
  const chars = Array.from(input);
  return chars.length <= max ? input : chars.slice(0, max).join('');
}

/** Chat-specific pipeline: filter first so `[URL]` / masks count toward the cap. */
export function sanitizeChat(input: string, max: number): string {
  return capText(filterText(input), max);
}