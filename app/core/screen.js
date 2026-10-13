'use strict';

// Reading values off a phone's screen, from the XML of "uiautomator dump". A bank app writes an
// account number with dashes and an amount with commas and a currency; a job has them plain.
// These compare what is meant, not how it is written.

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (text) => String(text).replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (whole, name) => {
  if (name[0] !== '#') return XML_ENTITIES[name.toLowerCase()];
  const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
});

/** Every text on the screen that has a size, top to bottom as the tree lists it. */
function labels(xml) {
  const found = [];
  for (const [node] of String(xml).matchAll(/<node\s[^>]*>/g)) {
    const bounds = (node.match(/\sbounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/) || []).slice(1).map(Number);
    if (bounds.length !== 4 || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) continue;
    const text = unescapeXml((node.match(/\stext="([^"]*)"/) || [])[1] || '').trim();
    if (text) found.push(text);
  }
  return found;
}

/** True when the screen shows this account number, however the app groups its digits. */
function showsAccount(xml, account) {
  const wanted = String(account).replace(/\D/g, '');
  if (wanted.length < 6) return false;
  // Only a label that is a number counts: digits spread through a sentence are not an account.
  return labels(xml).some((label) => /^[\d\s-]+$/.test(label) && label.replace(/\D/g, '') === wanted);
}

/**
 * True when the figure right under the label `under` is this amount. For a page that shows other
 * money too, such as what is left in the paying account.
 */
function showsAmountUnder(xml, amount, under) {
  const wanted = Number(String(amount).replace(/,/g, ''));
  if (!Number.isFinite(wanted) || wanted <= 0) return false;
  const tidy = (label) => label.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, '').toLowerCase();
  const list = labels(xml);
  return list.some((label, index) => {
    if (tidy(label) !== tidy(under)) return false;
    const match = (list[index + 1] || '').match(/^([\d,]+(?:\.\d+)?)\s*(?:THB|บาท|฿)?$/i);
    return Boolean(match) && Number(match[1].replace(/,/g, '')) === wanted;
  });
}

/**
 * Where to drag a "slide to confirm" bar that shows the words `wanted`: from its left end to its
 * right end, as { from: [x, y], to: [x, y] } in pixels; null when the page has no such bar.
 */
function slideOf(xml, wanted) {
  const tidy = (label) => label.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, '').toLowerCase();
  const nodes = [...String(xml).matchAll(/<node\s[^>]*>/g)].map(([node]) => ({
    text: unescapeXml((node.match(/\stext="([^"]*)"/) || [])[1] || ''),
    kind: (node.match(/\sclass="([^"]*)"/) || [])[1] || '',
    box: (node.match(/\sbounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/) || []).slice(1).map(Number),
  })).filter((node) => node.box.length === 4 && node.box[2] > node.box[0] && node.box[3] > node.box[1]);
  const words = nodes.find((node) => node.text && tidy(node.text) === tidy(wanted));
  if (!words) return null;
  const [x, y] = [(words.box[0] + words.box[2]) / 2, Math.round((words.box[1] + words.box[3]) / 2)];
  // The bar is the seek bar the words lie on; the smallest, should one lie in another.
  const bars = nodes.filter((node) => /SeekBar$/.test(node.kind) && node.box[0] <= x && x <= node.box[2] && node.box[1] <= y && y <= node.box[3])
    .sort((a, b) => (a.box[2] - a.box[0]) - (b.box[2] - b.box[0]));
  if (!bars.length) return null;
  const [left, top, right, bottom] = bars[0].box;
  return { from: [left + Math.round((bottom - top) / 2), y], to: [right - 8, y] };
}

/** True when the screen shows this amount of money: "1,500.00 THB" is 1500. */
function showsAmount(xml, amount) {
  const wanted = Number(String(amount).replace(/,/g, ''));
  if (!Number.isFinite(wanted) || wanted <= 0) return false;
  return labels(xml).some((label) => {
    const match = label.match(/^([\d,]+(?:\.\d+)?)\s*(?:THB|บาท|฿)?$/i);
    return Boolean(match) && Number(match[1].replace(/,/g, '')) === wanted;
  });
}

// Words before a person's name that are not part of it. A back office and a bank write them differently.
const NAME_TITLES = ['นางสาว', 'น.ส.', 'นส.', 'นาย', 'นาง', 'เด็กชาย', 'เด็กหญิง', 'ด.ช.', 'ด.ญ.', 'คุณ', 'mister', 'mrs.', 'mrs', 'miss', 'mr.', 'mr', 'ms.', 'ms'];
// The label a bank app puts before the account a transfer goes to.
const RECEIVER_LABELS = ['ไปที่', 'ไปยัง', 'to'];
// Looked for only on a page with none of those: another bank app's word for the same.
const RECEIVER_LABELS_ALSO = ['ถึง'];

/** A name as its words, without a title before it, written one way: no marks apart, no capitals. */
function nameWords(name) {
  const tidy = (word) => word.normalize('NFKD').replace(/[\u200b-\u200d\ufeff]/g, '').toLowerCase();
  let words = String(name || '').trim().split(/\s+/).filter(Boolean).map(tidy);
  const titles = NAME_TITLES.map(tidy);
  // A title stands by itself ("นาย สมชาย") or is written against the name ("น.ส.สมหญิง").
  while (words.length > 1 && titles.includes(words[0])) words = words.slice(1);
  const joined = titles.filter((title) => title.includes('.')).find((title) => words.length && words[0].startsWith(title) && words[0].length > title.length);
  if (joined) words = [words[0].slice(joined.length), ...words.slice(1)];
  return words;
}

/** The name of the person a transfer goes to, as the page shows it after its "to" label; '' when it shows none. */
function receiverName(xml) {
  const list = labels(xml);
  const tidy = (label) => label.replace(/[\u200b-\u200d\ufeff]/g, '').trim().toLowerCase();
  const first = list.findIndex((label) => RECEIVER_LABELS.includes(label.toLowerCase()));
  const at = first >= 0 ? first : list.findIndex((label) => RECEIVER_LABELS_ALSO.includes(tidy(label)));
  const name = at < 0 ? '' : list[at + 1] || '';
  // A number there is an account, not a name.
  return /\p{L}/u.test(name) && !/^[\d\s-]+$/.test(name) ? name : '';
}

/**
 * Whether two names are one person's: 'same', 'other', or 'unknown' when they cannot be compared,
 * because one is missing or one is in Thai letters and the other is not. The first names must be
 * the same; the family names too when both sides give one. With `needFamily`, a family name the
 * screen shows and the job does not give makes the names 'unknown' rather than the same.
 */
function compareNames(shown, wanted, needFamily = false) {
  const [a, b] = [nameWords(shown), nameWords(wanted)];
  if (!a.length || !b.length || !/\p{L}/u.test(a.join('')) || !/\p{L}/u.test(b.join(''))) return 'unknown';
  const thai = (words) => /[\u0e00-\u0e7f]/.test(words.join(''));
  if (thai(a) !== thai(b)) return 'unknown';
  if (a[0] !== b[0]) {
    // A title written against the name with no dot ("นายสมชาย") cannot be told from a name; allow it on either side.
    const titles = NAME_TITLES.map((title) => title.normalize('NFKD').toLowerCase());
    if (!titles.some((title) => a[0] === title + b[0] || b[0] === title + a[0])) return 'other';
  }
  if (a.length > 1 && b.length > 1 && a.slice(1).join('') !== b.slice(1).join('')) return 'other';
  if (needFamily && a.length > 1 && b.length === 1) return 'unknown';
  return 'same';
}

/** A few words of what the screen says, with its numbers hidden, for saying where a phone is stuck. */
function gist(xml, count = 5) {
  return labels(xml).filter((label) => label.length > 1).slice(0, count).map((label) => label.replace(/\d{3,}/g, '#').slice(0, 40)).join(' | ');
}

module.exports = { labels, showsAccount, showsAmount, showsAmountUnder, slideOf, gist, receiverName, compareNames };
