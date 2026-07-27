// Client-side detection of "sensitive" spans inside a chat message.
//
// Support agents share one department Telegram account and must not casually see
// a customer's raw financial / identity details. We detect the exact character
// RANGES of sensitive substrings so the renderer can redact only those pieces
// (replace them with locked chips) instead of the whole bubble — and, crucially,
// keep the real characters OUT of the DOM until a CRM-superadmin approves the
// reveal (a CSS blur would still expose the text to "Inspect Element"). See the
// redaction + reveal flow in bubbles.ts and the approval workflow in AppCrmManager.
//
// Detection is deliberately conservative-but-not-perfect: a false positive only
// means a harmless chip a superadmin can wave through, so we err toward catching
// more. Patterns tolerate ASCII and Persian/Arabic digits and common separators.

export type SensitiveCategory = 'financial' | 'contact' | 'identity' | 'address';

export type SensitiveRange = {start: number, end: number, category: SensitiveCategory};

// Persian (۰-۹) + Arabic-Indic (٠-٩) digits → ASCII, so one set of numeric
// regexes covers any keyboard. The map is per-character (length- and
// index-preserving), so a range found in the normalized string maps to the SAME
// [start, end) in the original — which is what we redact.
const PERSIAN_ZERO = 0x06f0;
const ARABIC_ZERO = 0x0660;
export function normalizeDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= PERSIAN_ZERO ? PERSIAN_ZERO : ARABIC_ZERO;
    return String(code - base);
  });
}

// A run of `n` digits allowing single space/dash/dot separators between them,
// anchored (via non-consuming lookarounds, so match indices stay exact) so it
// isn't a slice of a longer number.
const digitRun = (n: number) => `(?<![\\d])(?:\\d[ .\\-]?){${n - 1}}\\d(?![\\d])`;

// Structured patterns, matched against digit-normalized text. `g` flag so we can
// walk every occurrence with matchAll and read its index.
const CATEGORY_PATTERNS: {category: SensitiveCategory, re: RegExp}[] = [
  {category: 'financial', re: new RegExp(digitRun(16), 'g')},                 // bank card
  {category: 'financial', re: /(?<![\d])IR\d{24}(?![\d])/gi},                 // SHABA/IBAN with IR prefix
  {category: 'financial', re: new RegExp(digitRun(24), 'g')},                 // bare 24-digit SHABA
  {category: 'contact', re: /(?<![\d])(?:(?:\+|00)98|0)9\d{9}(?![\d])/g},     // Iranian mobile
  {category: 'contact', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi},       // email
  {category: 'contact', re: /(?<![\w@.])@[a-z][a-z0-9_]{4,31}\b/gi},          // telegram @username (5–32 chars)
  {category: 'contact', re: /(?<![\w@.])(?:https?:\/\/)?t\.me\/[a-z0-9_+]{3,}/gi}, // t.me link
  {category: 'identity', re: new RegExp(digitRun(10), 'g')}                   // national id / postal code (both 10 digits)
];

// Address is free text with no distinctive shape, so we redact from a Persian
// address keyword to the end of that line — a coarse but useful heuristic.
const ADDRESS_RE = /(?:خیابان|کوچه|بلوار|پلاک|میدان|منزل|واحد|طبقه|آدرس)[^\n]*/g;

// Merge overlapping/adjacent ranges (keeping the first category) so redaction
// produces one chip per contiguous sensitive region.
function mergeRanges(ranges: SensitiveRange[]): SensitiveRange[] {
  if(ranges.length < 2) return ranges;
  ranges.sort((a, b) => a.start - b.start);
  const merged: SensitiveRange[] = [ranges[0]];
  for(let i = 1; i < ranges.length; ++i) {
    const last = merged[merged.length - 1];
    const cur = ranges[i];
    if(cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

/**
 * The sensitive character ranges in `text` (indices into the ORIGINAL string),
 * merged and sorted. `enabled` optionally restricts categories. Empty when the
 * text carries nothing sensitive.
 */
export function detectSensitiveRanges(
  text: string | undefined,
  enabled?: SensitiveCategory[]
): SensitiveRange[] {
  if(!text) return [];

  const normalized = normalizeDigits(text);
  const ranges: SensitiveRange[] = [];

  for(const {category, re} of CATEGORY_PATTERNS) {
    if(enabled && !enabled.includes(category)) continue;
    for(const m of normalized.matchAll(re)) {
      ranges.push({start: m.index, end: m.index + m[0].length, category});
    }
  }

  if(!enabled || enabled.includes('address')) {
    for(const m of text.matchAll(ADDRESS_RE)) { // keyword scan on the raw text
      ranges.push({start: m.index, end: m.index + m[0].length, category: 'address'});
    }
  }

  return mergeRanges(ranges);
}

export function isSensitive(text: string | undefined, enabled?: SensitiveCategory[]): boolean {
  return detectSensitiveRanges(text, enabled).length > 0;
}
