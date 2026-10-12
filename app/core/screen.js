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

/** True when the screen shows this amount of money: "1,500.00 THB" is 1500. */
function showsAmount(xml, amount) {
  const wanted = Number(String(amount).replace(/,/g, ''));
  if (!Number.isFinite(wanted) || wanted <= 0) return false;
  return labels(xml).some((label) => {
    const match = label.match(/^([\d,]+(?:\.\d+)?)\s*(?:THB|บาท|฿)?$/i);
    return Boolean(match) && Number(match[1].replace(/,/g, '')) === wanted;
  });
}

/** A few words of what the screen says, with its numbers hidden, for saying where a phone is stuck. */
function gist(xml, count = 5) {
  return labels(xml).filter((label) => label.length > 1).slice(0, count).map((label) => label.replace(/\d{3,}/g, '#').slice(0, 40)).join(' | ');
}

module.exports = { labels, showsAccount, showsAmount, gist };
