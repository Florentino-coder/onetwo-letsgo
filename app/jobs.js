'use strict';

// Web jobs: the operator signs in to the back office in a window of its own, the app reads the
// values of the job on that page and runs a saved workflow with them.
//
// The app never types a user name, password or one-time code and never stores one. Signing in is
// done by hand in the back-office window; only that window's session cookies are kept, by Electron.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, net } = require('electron');
const logic = require('./core/logic');

const DEFAULTS = {
  url: '',
  workflow: '',
  serial: '',
  // CSS selectors recorded by clicking on the page.
  value1: '',
  value2: '',
  value3: '',
  // 'text' reads what the element shows. 'copy' presses it as a copy button and takes what it copies.
  mode1: 'text',
  mode2: 'text',
  mode3: 'text',
  // Keep only the number, so a label, a currency or thousands separators are not typed.
  number1: true,
  number2: true,
  // Value 3 is for words, such as the bank's name that picks which workflow runs.
  number3: false,
  // Type 3001 for 3001.00. A value with satang is refused instead of being cut.
  whole1: true,
  whole2: true,
  whole3: true,
  // After the workflow, read the phone's screen and press "done" only when it shows the job's values.
  verify: true,
  // 'gallery' reads the newest picture the phone app saved while the workflow ran, such as a
  // transfer slip. 'screen' reads what the phone shows when the workflow ends.
  source: 'gallery',
  // Words that must also be on the screen, such as the bank's success message. Empty means not checked.
  expect: '',
  // How a job is closed after the workflow ran. 'macro' replays the recorded clicks. 'profile'
  // fills the site's own close-job form from the slip, by the steps in the site's profile.
  closeBy: 'macro',
  // With 'profile': only outline what would be pressed, and leave the job open.
  closeDry: true,
  // A workflow that gets the phone's app from closed to the screen the main workflow starts on:
  // close the app, open it, sign in. '' means the main workflow does all of that itself.
  enter: '',
  // The app stays signed in for a while. A job that starts within this many seconds of the last
  // one ending well skips `enter`. 0 runs `enter` before every job, which is always right.
  stay: 0,
  // A workflow run before the main one when `enter` is skipped: from the screen the last job
  // ended on, back to the screen the main workflow starts on. '' means those are the same screen.
  again: '',
  // A workflow run once on a phone left on the paying screen for `stay` seconds with no job: it
  // takes the app back to a screen it can be left on. The next job then begins with `enter`.
  rest: '',
  // Take the back-office window to the list of approved withdrawals by itself, once signed in.
  watch: true,
  // Put the phones' amount range into the page's own filter, so the page lists only those rows.
  filter: true,
  // Read each phone's account off the back office's own list of the shop's accounts: what is left
  // in it and whether it is switched on. Off means the balance entered by hand is used.
  balances: true,
  // Read the list of approved withdrawals by the back office's own request, not off the page's
  // table. The page is still searched as before: jobs are closed on it.
  api: false,
  // Where that request goes: the service's address ("https://...api.example.com"), as the F12
  // network tab shows it. The pass itself is typed in each time and kept in memory only.
  apiBase: '',
  // The back office web page's own address ("https://manage.example.com"), sent as the request's
  // origin and referer, as the F12 network tab shows them. Some services refuse a request without it.
  apiOrigin: '',
  // The path of the request that lists the shop's paying accounts with their balances, used to
  // close a job by request (it names the paying account) and to read balances without a window.
  apiSettlementPath: '/bo/withdrawal-settlement-search?%24limit=100&%24skip=0',
  // A "checkname" step of the paying workflow compares the name on the bank app's confirm page
  // with the name of the job. Off, such a step passes without looking.
  // The bank whose app the workflows above drive, as its code ("BBL"). Set, a phone that pays from
  // another bank runs the set `flows` has for that bank, or nothing when there is none. Empty,
  // every phone runs the workflows above.
  bank: '',
  checkName: true,
  // On, a family name the confirm page shows must be checked too: a job that gives none is passed over.
  checkFamily: false,
  interval: 5,
  reload: false,
};
// What a "checkname" step says when it could not compare the two names.
const NAME_UNSURE_RE = /name on the phone's screen cannot be compared/;
const VALUES = [1, 2, 3];
const FIELDS = VALUES.map((number) => `value${number}`);
// Accepting a job and closing it are recordings: clicks on the page, replayed in order.
// 'accept' is played before the values are read, 'done' after the workflow ran.
const RECORDINGS = ['accept', 'done'];
const ACCEPT_SETTLE_MS = 2000;
const LOAD_TIMEOUT_MS = 15000;
const RECORD_MARK = 'adb-onetwo-step:';
const MAX_STEPS = 20;
const MIN_STEP_WAIT_MS = 300;
const MAX_STEP_WAIT_MS = 15000;
const STEP_TIMEOUT_MS = 8000;
// How often a row that is not on the page is looked for again before closing gives up, and the wait before each.
const CLOSE_ROW_RETRIES = 4;
const CLOSE_ROW_RETRY_MS = 1500;

// Closing a job by profile: the engine and the site profiles of ClipSync's browser extension,
// run in the back-office window itself. The engine file is ClipSync's, unchanged.
const CLOSE_DIR = path.join(__dirname, 'closejob');
const ENGINE_FILE = path.join(CLOSE_DIR, 'engine.js');
const PROFILE_DIR = path.join(CLOSE_DIR, 'profiles');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The page is asked for a fresh list no more often than this, and given this long to draw it.
const MIN_SEARCH_MS = 10000;
const SEARCH_SETTLE_MS = 2500;

// The shop's accounts are read no more often than this.
const MIN_ACCOUNTS_MS = 30000;
// What was read of the accounts is trusted for this long; older than that, it is as good as unread.
const ACCOUNTS_FRESH_MS = 180000;

// Every row of the shop's accounts list: the text of its cells and whether its switch is on.
const ACCOUNTS_SCRIPT = `(() => {
  const visible = (el) => el.getClientRects().length > 0;
  const table = [...document.querySelectorAll('table')].filter(visible).sort((a, b) => b.querySelectorAll('tbody tr').length - a.querySelectorAll('tbody tr').length)[0];
  return {
    path: location.pathname,
    signedOut: Boolean(document.querySelector('input[type=password]')),
    rows: table ? [...table.querySelectorAll('tbody tr')].map((tr) => {
      const box = tr.querySelector('input[type=checkbox]');
      return { cells: [...tr.children].map((td) => td.innerText), on: box ? box.checked : null };
    }) : [],
  };
})()`;

// Press the page's own search button, which is how the page brings its figures up to date.
const ACCOUNTS_SEARCH_SCRIPT = `(() => {
  const button = [...document.querySelectorAll('button')].filter((el) => el.getClientRects().length > 0 && !el.disabled).find((el) => /^(ค้นหา|search)$/i.test(el.textContent.trim()));
  if (!button) return false;
  button.click();
  return true;
})()`;

// A box the site puts up to ask "are you sure" or to say "done", and its button that agrees.
const ACCOUNTS_BOX = `(() => {
  const visible = (el) => el.getClientRects().length > 0;
  const box = [...document.querySelectorAll('.swal2-popup, .modal.show .modal-content')].filter(visible).pop();
  if (!box) return { box: null, button: null };
  const button = [...box.querySelectorAll('button')].filter((el) => visible(el) && !el.disabled).find((el) => /^(ตกลง|ยืนยัน|ใช่|ok|yes|confirm)$/i.test(el.textContent.trim()));
  return { box, button: button || null };
})()`;

/**
 * Set the switch of the one row of the shop's accounts list that shows this account number.
 * Resolves with 'same' when it stood that way already, 'pressed' when the switch was pressed,
 * 'missing' when no row shows the number, and 'twice' when more than one does. No other row is touched.
 */
const accountSwitchScript = (account, on) => `(() => {
  const visible = (el) => el.getClientRects().length > 0;
  const table = [...document.querySelectorAll('table')].filter(visible).sort((a, b) => b.querySelectorAll('tbody tr').length - a.querySelectorAll('tbody tr').length)[0];
  const rows = table ? [...table.querySelectorAll('tbody tr')].filter((tr) => [...tr.children].some((td) => td.innerText.split(/[^0-9]+/).includes(${JSON.stringify(account)}))) : [];
  if (!rows.length) return 'missing';
  if (rows.length > 1) return 'twice';
  const box = rows[0].querySelector('input[type=checkbox]');
  if (!box || box.disabled) return 'missing';
  if (box.checked === ${Boolean(on)}) return 'same';
  box.click();
  return 'pressed';
})()`;

// Agree to the box that is up, if it has a button that agrees. Resolves with the box's words, or ''.
const ACCOUNTS_AGREE_SCRIPT = `(() => {
  const { box, button } = ${ACCOUNTS_BOX};
  if (!box || !button) return '';
  const words = box.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120);
  button.click();
  return words || 'box';
})()`;

// The text of every cell of the list on the page, and where the page is. Reads only.
const ORDERS_SCRIPT = `(() => {
  const visible = (el) => el.getClientRects().length > 0;
  const table = [...document.querySelectorAll('table')].filter(visible).sort((a, b) => b.querySelectorAll('tbody tr').length - a.querySelectorAll('tbody tr').length)[0];
  return {
    path: location.pathname,
    tab: [...document.querySelectorAll('.nav-link.active, [role="tab"][aria-selected="true"]')].filter(visible).map((el) => el.textContent.replace(/\\s+/g, ' ').trim()).join(' | '),
    signedOut: Boolean(document.querySelector('input[type=password]')),
    rows: table ? [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.innerText)) : [],
  };
})()`;

// The back office's own request for the list of approved withdrawals, as its page sends it.
const API_LIST_PATH = '/bo/withdrawal-approve-search';
const API_PAGE = 50;
const API_MAX_PAGES = 4;

/** The address of that request: today in Thai time, the amount range when there is one, newest first. */
function apiListUrl(base, range, skip) {
  const day = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const query = [
    ['$skip', skip], ['$limit', API_PAGE], ['username', ''], ['start_date', `${day} 00:00:00`], ['end_date', `${day} 23:59:59`],
    ['member_account', ''], ['member_crypto_token', ''], ['bank_information_id', ''], ['member_bank_account', ''],
    ['approve_start_date', ''], ['approve_end_date', ''], ['amount_from', range ? range[0] : ''], ['amount_to', range ? range[1] : ''],
    ['p', 1 + skip / API_PAGE], ['auto_reload', 'false'], ['tab', 1], ['$sort', '{"withdraw_datetime":"desc"}'],
  ];
  // Only the service's origin is used, so a whole request URL pasted into the setting still works.
  return `${new URL(base).origin}${API_LIST_PATH}?${query.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')}`;
}

// How long one request to the service is waited for before it is given up.
const API_TIMEOUT_MS = 20000;

/**
 * One request to the back office's own service, from this process, carrying the pass the operator
 * typed in. Returns the status and the parsed body. The pass is passed in, never read from a page
 * or kept anywhere but memory. `method` other than GET sends `body` as JSON.
 */
const API_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

async function apiRequest(method, url, pass, { body, origin } = {}) {
  const request = net.request({ method, url });
  request.setHeader('accept', 'application/json, text/plain, */*');
  request.setHeader('authorization', `Bearer ${pass}`);
  request.setHeader('correlationid', crypto.randomUUID());
  request.setHeader('languagecode', 'th');
  request.setHeader('user-agent', API_USER_AGENT);
  // Some services read the web page's origin and refuse, or fail, a request that does not carry it.
  if (origin) {
    request.setHeader('origin', origin);
    request.setHeader('referer', `${origin}/`);
  }
  if (body !== undefined) request.setHeader('content-type', 'application/json;charset=UTF-8');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { request.abort(); reject(new Error('the service did not answer in time')); }, API_TIMEOUT_MS);
    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        resolve({ status: response.statusCode, body: parsed, text });
      });
    });
    request.on('error', (error) => { clearTimeout(timer); reject(error); });
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

/** One page of the approved-withdrawal list: its status, how many rows there are in all, and the rows. */
async function apiListPage(base, pass, range, skip, origin) {
  const url = apiListUrl(base, range, skip);
  const { status, body, text } = await apiRequest('GET', url, pass, { origin });
  return { status, total: Number(body && body.total) || 0, data: body && Array.isArray(body.data) ? body.data : null, text, url };
}

/**
 * Put an amount range into the page's own filter, when one is given and the profile says where the
 * filter is, then press the page's search button. The engine must already be on the page.
 */
const searchScript = (profile, range) => `(() => {
  const E = globalThis.ClipSyncEngine;
  const profile = ${JSON.stringify(profile)};
  const range = ${JSON.stringify(range)};
  // The page is built with Vue, which only notices a value that arrives as typing does.
  const type = (selector, value) => {
    const el = selector ? document.querySelector(selector) : null;
    if (!el || el.value === value) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (range) {
    type(profile.amount_from_selector, range[0]);
    type(profile.amount_to_selector, range[1]);
  }
  return E.maybeClickApprovedSearch(profile, document, {});
})()`;

/** The site profiles that have close-job steps. Read again each time, so a new file is picked up. */
function closeProfiles() {
  let names = [];
  try {
    names = fs.readdirSync(PROFILE_DIR).filter((name) => name.endsWith('.json'));
  } catch {
    // No profiles shipped.
  }
  const profiles = [];
  for (const name of names) {
    try {
      const profile = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, name), 'utf8'));
      if (Array.isArray(profile.close_job_workflow) && profile.close_job_workflow.length && Array.isArray(profile.domain_patterns)) profiles.push(profile);
    } catch {
      // A profile that does not parse is not offered.
    }
  }
  return profiles;
}

/** The profile whose address patterns ("https://site/*") cover `url`, or null. */
function closeProfileFor(url) {
  const covers = (pattern) => new RegExp(`^${String(pattern).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(url);
  return closeProfiles().find((profile) => profile.domain_patterns.some(covers)) || null;
}

/**
 * Find the job's row on the page and run the profile's close-job steps on it. Resolves with the
 * engine's result as plain values. The engine must already be on the page.
 */
const closeScript = (profile, keys, slip, hints) => `(async () => {
  const E = globalThis.ClipSyncEngine;
  const profile = ${JSON.stringify(profile)};
  const slip = ${JSON.stringify(slip)};
  // The site's own alert library has to be told to confirm; a click on its button is the fallback.
  E.setMainWorldClicker(() => {
    try {
      if (window.Swal && typeof window.Swal.clickConfirm === 'function') return window.Swal.clickConfirm();
    } catch {
      // Fall through to the button.
    }
    const button = document.querySelector('button.swal2-confirm');
    if (button) button.click();
  });
  if (E.isLoggedOut(profile)) return { ok: false, reason: 'session_expired' };
  let found = { status: 'row_not_found' };
  let used = '';
  for (const key of ${JSON.stringify(keys)}) {
    found = E.findRow(profile, key, document, ${JSON.stringify(hints)});
    if (found.status === 'ok') {
      used = key;
      break;
    }
    if (found.status === 'ambiguous') return { ok: false, reason: 'ambiguous', key };
  }
  if (found.status !== 'ok') return { ok: false, reason: found.status };
  const steps = [];
  const told = console.error;
  console.error = (...said) => {
    if (said[0] === '[ClipSync WF]' && said[1] === 'step') steps[said[2]] = { action: String(said[3] || ''), from: Date.now(), ms: null };
    if (said[0] === '[ClipSync WF]' && said[1] === 'step_done' && steps[said[2]]) steps[said[2]].ms = Date.now() - steps[said[2]].from;
    told.apply(console, said);
  };
  let result;
  try {
    result = await E.runWorkflow(profile, profile.close_job_workflow, { row: found.row, slip, matchKey: used }, { dry_run: profile.dry_run, outline_only: profile.dry_run });
  } finally {
    console.error = told;
  }
  const plain = { key: used, steps: steps.map((step) => (step ? [step.action, step.ms] : ['', null])) };
  for (const name of ['ok', 'reason', 'failed_step', 'failed_reason', 'field', 'tried_value', 'hint', 'via', 'verified']) {
    if (['string', 'number', 'boolean'].includes(typeof result[name])) plain[name] = result[name];
  }
  return plain;
})()`;

/** The text a person sees in the element: a form field's value, otherwise its visible text. */
const readScript = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const typed = typeof el.value === 'string' ? el.value : '';
  return String(typed || el.innerText || el.textContent || '').trim();
})()`;

// SVG icons have no click() of their own, so fall back to a click event.
const PRESS = `const press = (el) => (typeof el.click === 'function' ? el.click() : el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })));`;

// The words on a button. A box a person types in has none, so what was typed is never taken.
const LABEL = `const label = (el) => String(el.innerText || el.textContent || (/^(button|submit|reset)$/.test(el.type) ? el.value : '') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);`;

/**
 * Press the element of a recorded click. It must be where it was recorded and still say the same
 * words, numbers aside; failing that, the first element of the same kind that says them. False
 * when there is none, so a different button that moved into the old place is never pressed.
 */
const stepScript = (step) => `(() => {
  ${PRESS}
  ${LABEL}
  const wanted = ${JSON.stringify(step.text)}.replace(/\\d+/g, '#');
  const alike = (el) => !wanted || label(el).replace(/\\d+/g, '#') === wanted;
  const usable = (el) => !el.disabled && el.getClientRects().length > 0;
  let el = document.querySelector(${JSON.stringify(step.selector)});
  if (el && !(alike(el) && usable(el))) el = null;
  if (!el && wanted && ${JSON.stringify(step.tag)}) el = [...document.getElementsByTagName(${JSON.stringify(step.tag)})].find((other) => alike(other) && usable(other)) || null;
  if (!el) return false;
  press(el);
  return true;
})()`;

/**
 * Press a copy button and return what the page tried to copy, or null when the button is missing.
 * The page's copy calls are caught for the length of the press, so the value comes straight from
 * the page: the computer's clipboard is not read or changed, and the window need not be in front.
 */
const copyScript = (selector) => `(async () => {
  ${PRESS}
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  let copied = null;
  const selected = () => {
    const box = document.activeElement;
    if (box && typeof box.value === 'string' && box.selectionStart != null && box.selectionEnd > box.selectionStart) return box.value.slice(box.selectionStart, box.selectionEnd);
    return String(document.getSelection() || '');
  };
  const board = navigator.clipboard;
  const writeText = board && board.writeText;
  const execCommand = document.execCommand;
  if (board) board.writeText = (value) => { copied = String(value); return Promise.resolve(); };
  document.execCommand = function (command, ...rest) {
    if (String(command).toLowerCase() !== 'copy') return execCommand.call(document, command, ...rest);
    copied = selected();
    return true;
  };
  try {
    press(el);
    await new Promise((resolve) => setTimeout(resolve, 400));
  } finally {
    if (board) board.writeText = writeText;
    document.execCommand = execCommand;
  }
  return copied === null ? '' : copied.trim();
})()`;

// The selector for an element, built from what the page's author named: an id, a test attribute,
// class names. A position among siblings is added only where siblings look the same, and the path
// stops as soon as it names one element, so a change elsewhere on the page does not break it.
const CSS_PATH = `const cssPath = (el) => {
    // Names with long numbers are usually made per record or per build.
    const plain = (name) => /^[A-Za-z][\\w-]*$/.test(name) && !/\\d{3,}/.test(name);
    // Classes that come and go with the pointer or the page's state are not there on replay.
    const state = /^(is-|has-)?(active|hover|hovered|focus|focused|selected|checked|disabled|open|opened|show|shown|visible|loading|pressed|current)$/i;
    const named = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'name', 'aria-label'];
    const describe = (node) => {
      const tag = node.tagName.toLowerCase();
      for (const attribute of named) {
        const value = node.getAttribute(attribute);
        if (value && value.length <= 60 && !/["\\\\\\r\\n]/.test(value) && !/\\d{3,}/.test(value)) return tag + '[' + attribute + '="' + value + '"]';
      }
      return tag + [...node.classList].filter((name) => plain(name) && !state.test(name)).slice(0, 3).map((name) => '.' + name).join('');
    };
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node.id && plain(node.id) && document.querySelectorAll('#' + node.id).length === 1) {
        parts.unshift('#' + node.id);
        break;
      }
      let part = describe(node);
      const named = part !== node.tagName.toLowerCase();
      const siblings = node.parentElement ? [...node.parentElement.children] : [node];
      if (siblings.filter((child) => child.matches(part)).length > 1) {
        part += ':nth-of-type(' + (siblings.filter((child) => child.tagName === node.tagName).indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      // A bare tag that happens to be the only one now is not a name; keep going up.
      if (named && document.querySelectorAll(parts.join(' > ')).length === 1) break;
    }
    return parts.join(' > ');
  };`;

// Resolves with the element the user clicks next, or null on Escape. The click itself is swallowed,
// so recording a button does not press it.
const PICK_SCRIPT = `new Promise((resolve) => {
  if (window.__adbPickCancel) window.__adbPickCancel();
  ${CSS_PATH}
  let marked = null;
  let outline = '';
  const mark = (el) => {
    if (marked) marked.style.outline = outline;
    marked = el;
    if (el) {
      outline = el.style.outline;
      el.style.outline = '3px solid #f5a300';
    }
  };
  const swallow = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const finish = (answer) => {
    mark(null);
    document.removeEventListener('mouseover', over, true);
    document.removeEventListener('click', click, true);
    document.removeEventListener('mousedown', swallow, true);
    document.removeEventListener('mouseup', swallow, true);
    document.removeEventListener('keydown', key, true);
    window.__adbPickCancel = null;
    resolve(answer);
  };
  const over = (event) => mark(event.target);
  const click = (event) => {
    swallow(event);
    // An icon is drawn from several shapes; the whole icon is the thing to press.
    const el = event.target.closest('svg') || event.target;
    const typed = typeof el.value === 'string' ? el.value : '';
    const text = String(typed || el.innerText || el.textContent || '').trim().slice(0, 80);
    const button = Boolean(el.closest('button, a, [role="button"], svg, i, img')) || getComputedStyle(el).cursor === 'pointer';
    finish({ selector: cssPath(el), text, button });
  };
  const key = (event) => {
    if (event.key === 'Escape') finish(null);
  };
  window.__adbPickCancel = () => finish(null);
  document.addEventListener('mouseover', over, true);
  document.addEventListener('click', click, true);
  document.addEventListener('mousedown', swallow, true);
  document.addEventListener('mouseup', swallow, true);
  document.addEventListener('keydown', key, true);
})`;

// Reports every real click to the app until stopped. The clicks go through, so the page moves on
// to the next step of what is being recorded.
const recordScript = (token) => `(() => {
  if (window.__adbRecordStop) window.__adbRecordStop();
  ${CSS_PATH}
  ${LABEL}
  const click = (event) => {
    if (!event.isTrusted) return;
    // The thing to press is the whole button, not the word or icon inside it.
    const el = event.target.closest('button, a, [role="button"], input, summary') || event.target.closest('svg') || event.target;
    console.log(${JSON.stringify(RECORD_MARK + token)} + JSON.stringify({ selector: cssPath(el), text: label(el), tag: el.tagName.toLowerCase() }));
  };
  document.addEventListener('click', click, true);
  window.__adbRecordStop = () => {
    document.removeEventListener('click', click, true);
    window.__adbRecordStop = null;
  };
})()`;

const STOP_RECORD_SCRIPT = 'window.__adbRecordStop && window.__adbRecordStop()';

/** Recorded clicks as { selector, text, tag, wait }. `text` and `tag` are '' for a click with no words. */
/**
 * The workflows of other banks' apps, as saved, cleaned: { GSB: { workflow, enter, again, expect, stay } }.
 * A set names its paying workflow; the rest may be left out.
 */
function cleanFlows(raw) {
  const flows = {};
  for (const [code, flow] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (!logic.BANKS.some((bank) => bank.code === code) || !flow || typeof flow !== 'object') continue;
    const word = (key) => (typeof flow[key] === 'string' ? flow[key].trim().slice(0, 500) : '');
    if (!word('workflow')) continue;
    flows[code] = { workflow: word('workflow'), enter: word('enter'), again: word('again'), expect: word('expect'), stay: Math.min(3600, Math.max(0, Math.round(flow.stay) || 0)) };
  }
  return flows;
}

function cleanSteps(steps) {
  return steps
    .filter((step) => step && typeof step.selector === 'string' && step.selector.trim())
    .slice(0, MAX_STEPS)
    .map((step) => ({
      selector: step.selector.trim().slice(0, 500),
      text: typeof step.text === 'string' ? step.text.trim().slice(0, 80) : '',
      tag: typeof step.tag === 'string' && /^[a-z][a-z0-9-]*$/.test(step.tag) ? step.tag : '',
      wait: Math.min(MAX_STEP_WAIT_MS, Math.max(0, Math.round(step.wait) || 0)),
    }));
}

/**
 * @param {object} host
 * @param {import('./core/store').Store} host.store
 * @param {(channel: string, payload: object) => void} host.send
 * @param {(message: string, level?: string) => void} host.log
 * @param {(request: object) => Promise<object>} host.runWorkflow
 * @param {() => string[]} host.onlineSerials
 * @param {() => string|null} host.busy  label of the fleet job that is running, if any
 * @param {(steps: string) => number} host.inputsOf  how many values a workflow text asks for
 * @param {string} host.appName
 * @param {(serial: string) => Promise<{text: string, file: string, notes: string[]}>} host.readScreen
 * @param {(serial: string, since: number) => Promise<{text: string, file: string, notes: string[]}>} host.readSlip
 * @param {(serial: string) => Promise<number>} host.phoneClock  seconds, by the phone's own clock
 * @param {() => {serial: string, label: string, min: number|null, max: number|null, bank: string, account: string, cap: number|null, balance: number|null}[]} host.phones  online phones, the amounts each may pay and the account each pays from
 * @param {(serial: string, amount: string) => void} host.spend  take a paid amount off the phone's balance
 */
function createJobs(host) {
  // The user program runs from a pack, which brings the close-job steps for its own back office.
  const profileFor = (url) => (host.closeProfile && host.closeProfile(url)) || closeProfileFor(url);
  let window = null;
  let auto = false;
  let timer = null;
  let working = false;
  let lastKey = '';
  // When each phone last finished a job's workflow well, by serial. A phone not in here is taken
  // to be signed out, as after a failure or a restart of this app.
  const lastGood = new Map();
  let status = { code: 'idle', detail: '', at: Date.now() };
  // The recording in progress: { which, token, steps, at }.
  let recording = null;

  function config() {
    const saved = host.store.config.jobs && typeof host.store.config.jobs === 'object' ? host.store.config.jobs : {};
    const merged = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof saved[key] === typeof DEFAULTS[key]) merged[key] = saved[key];
    }
    merged.interval = Math.min(600, Math.max(2, Math.round(merged.interval) || DEFAULTS.interval));
    merged.stay = Math.min(3600, Math.max(0, Math.round(merged.stay) || 0));
    merged.flows = cleanFlows(saved.flows);
    for (const which of RECORDINGS) {
      // A single button recorded by an older version is a recording of one click.
      const legacy = typeof saved[which] === 'string' && saved[which] ? [{ selector: saved[which] }] : [];
      merged[`${which}Steps`] = cleanSteps(Array.isArray(saved[`${which}Steps`]) ? saved[`${which}Steps`] : legacy);
    }
    return merged;
  }

  function view() {
    return {
      config: config(),
      auto,
      open: Boolean(window),
      hidden: Boolean(window) && !window.isVisible(),
      url: window ? window.webContents.getURL() : '',
      status,
      // The close-job profile for the back-office address, '' when there is none for it.
      profile: (profileFor(window ? window.webContents.getURL() : config().url) || { profile_id: '' }).profile_id,
      // Which recording is in progress and how many clicks it has, or null.
      recording: recording ? { which: recording.which, count: recording.steps.length } : null,
      orders: { ...ordersView(), error: orders.error || '', via: orders.via || 'page' },
      // Reading the list by the back office's own request: whether a pass is held, and whether a
      // row has been seen to agree with the page. The pass itself never leaves this process.
      api: { pass: Boolean(apiPass), proven: apiProven, wrong: apiWrong },
      payAuto,
      halt: halted(),
      // The phones that are stopped, and the phones that are paying or resting now, by serial.
      stops: stops(),
      paying: Object.fromEntries(paying),
      phones: host.phones().map((phone) => ({ ...phone, spent: spentToday(phone.serial) })),
      // What each phone has paid since its bank's day began, to its own bank and to others, for its daily caps.
      caps: Object.fromEntries([...new Set(Object.values(ledger).map((entry) => entry.serial).filter(Boolean))].map((serial) => [serial, spentBy(serial, host.payBank ? host.payBank(serial) : '')])),
      // The phones whose account has not been read from the back office since they came online.
      checking: host.watched().filter(checking).map((phone) => phone.serial),
      // The banks no phone pays to for now, by code.
      skipBanks: host.skipBanks(),
      // Each bank's pause as set, and the phones in one now with the time it ends.
      pauses: host.bankPauses ? host.bankPauses() : {},
      pauseLead: logic.PAUSE_LEAD_MIN,
      paused: Object.fromEntries(host.phones().map((phone) => [phone.serial, pausedUntil(phone)]).filter(([, until]) => until)),
      // The banks whose app there are workflows for, by code: the one the main workflows drive first.
      payBanks: [config().bank, ...Object.keys(config().flows)].filter(Boolean),
      // The phones that pay from a bank whose app there are no workflows for.
      noFlow: host.watched().filter((phone) => noFlow(config(), phone)).map((phone) => phone.serial),
      // The shop's accounts as the back office lists them, by account number.
      accounts: { at: accounts.at, note: accounts.note, error: accounts.error || '', fresh: accounts.note === 'ok' && Date.now() - accounts.at <= ACCOUNTS_FRESH_MS, map: accounts.map },
      // What each phone began to pay today, online or not.
      spent: Object.fromEntries([...new Set(Object.values(ledger).map((entry) => entry.serial).filter(Boolean))].map((serial) => [serial, spentToday(serial)])),
      audits: audits.slice(-80).reverse().map((entry) => ({ at: entry.at, event: entry.event, key: entry.key, serial: entry.serial || '', message: entry.message || entry.was || (entry.wrong && entry.wrong.length ? entry.wrong.join(', ') : '') || (entry.file ? `สลิป ${path.basename(entry.file)}` : '') })),
      // Every row the app ever began, newest first.
      history: Object.entries(ledger).map(([key, entry]) => ({ key, ...entry, slip: slipOf(entry), bankCode: logic.bankCode(entry.bank) })).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200),
    };
  }

  function publish() {
    host.send('jobs', view());
  }

  function setStatus(code, detail = '') {
    status = { code, detail, at: Date.now() };
    publish();
  }

  function save(patch) {
    const next = config();
    for (const [key, value] of Object.entries(patch || {})) {
      if (!(key in DEFAULTS)) continue;
      if (typeof DEFAULTS[key] === 'string') next[key] = String(value || '').trim().slice(0, 500);
      else if (typeof DEFAULTS[key] === 'boolean') next[key] = Boolean(value);
      else next[key] = Number(value) || DEFAULTS[key];
    }
    host.store.config.jobs = next;
    host.store.saveConfig();
    if (auto) schedule();
    return view();
  }

  /**
   * Keep the pass for the list request, in memory only, for as long as the back office stays open.
   * A new pass lets the request be tried again after it was refused. Empty clears it.
   */
  function setApiToken(token) {
    apiPass = String(token || '').replace(/^\s*Bearer\s+/i, '').trim();
    apiWrong = false;
    apiSaid = '';
    // A pass with no window set up starts the turn; losing the pass with no window stops it.
    if (apiReadable(config()) && !window && !payTimer) startWatching();
    else if (!apiPass && !window) stopWatching();
    publish();
    return view();
  }

  function open() {
    const { url } = config();
    if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('Enter the back-office address first, starting with https://');
    if (window) {
      window.show();
      window.focus();
      publish();
      return view();
    }
    window = new BrowserWindow({
      width: 1180,
      height: 820,
      title: `${host.appName} - back office`,
      autoHideMenuBar: true,
      // A page from the internet: no Node, no preload, and a session kept apart from the app's own.
      // Out of sight the page must go on as before: it is read and searched all the same.
      webPreferences: { partition: 'persist:backoffice', sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    const contents = window.webContents;
    // Links that want a new window open in this one, so the recorder and reader keep seeing them.
    contents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) contents.loadURL(target);
      return { action: 'deny' };
    });
    contents.session.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
    contents.on('did-navigate', publish);
    contents.on('did-navigate-in-page', publish);
    contents.on('console-message', (event) => noteStep(event.message));
    // A click that loads a new page takes the recorder with it; put it back.
    contents.on('dom-ready', () => {
      if (recording) contents.executeJavaScript(recordScript(recording.token), true).catch(() => {});
    });
    // Closing the window only puts it out of sight: the work goes on, and the app's own window
    // brings it back. It is closed for good with the app.
    window.on('close', (event) => {
      event.preventDefault();
      window.hide();
      publish();
    });
    window.on('closed', () => {
      window = null;
      recording = null;
      // The page cross-check is gone with the window; the pass stays, so reading by request goes on.
      apiProven = false;
      apiWrong = false;
      stopAuto();
      stopWatching();
      // With reading by request set up, keep the turn running without the window.
      if (apiReadable(config())) startWatching();
      else setStatus('closed');
    });
    window.loadURL(url);
    startWatching();
    publish();
    return view();
  }

  function requireWindow() {
    if (!window) throw new Error('Open the back office and sign in first.');
    return window.webContents;
  }

  async function settle(contents) {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (contents.isLoading() && Date.now() < deadline) await sleep(200);
  }

  async function pick(field) {
    if (!FIELDS.includes(field)) throw new Error('Unknown field.');
    const contents = requireWindow();
    window.focus();
    const answer = await contents.executeJavaScript(PICK_SCRIPT, true);
    if (!answer) return { ...view(), picked: null };
    const patch = { [field]: answer.selector };
    // A value recorded on a button with no text of its own is a copy button.
    if (field.startsWith('value')) patch[`mode${field.slice(5)}`] = answer.button && !answer.text ? 'copy' : 'text';
    const next = save(patch);
    host.log(`Recorded ${field} on the back-office page: ${answer.selector}`);
    return { ...next, picked: answer };
  }

  /** The values on the page for {1}, {2}… of the chosen workflow. An entry is '' when not found. */
  async function read() {
    const contents = requireWindow();
    const current = config();
    const values = [];
    for (const number of VALUES) {
      const selector = current[`value${number}`];
      const script = current[`mode${number}`] === 'copy' ? copyScript(selector) : readScript(selector);
      const seen = selector ? (await contents.executeJavaScript(script, true)) || '' : '';
      if (!current[`number${number}`]) values.push(seen);
      else values.push(current[`whole${number}`] ? logic.wholeNumber(logic.cleanNumber(seen)) : logic.cleanNumber(seen));
    }
    return values;
  }

  function target(current) {
    if (current.serial) return [current.serial];
    const online = host.onlineSerials();
    if (online.length !== 1) throw new Error(`Choose a device: ${online.length} devices are online.`);
    return online;
  }

  /**
   * Handle the job on the page, if there is one. `byHand` skips the accept button and the
   * "already done" check, because the operator has looked at the values and asked for this run.
   */
  async function handle(byHand) {
    const contents = requireWindow();
    const current = config();
    const text = host.store.state.workflows[current.workflow];
    if (!text) throw new Error('Choose a saved workflow for web jobs.');
    const needed = host.inputsOf(text);
    if (needed > VALUES.length) throw new Error(`A web job can fill at most {1} to {${VALUES.length}}.`);
    // Value 1 is also how a job is told apart from the one before, so it is always needed.
    if (VALUES.some((number) => (number === 1 || number <= needed) && !current[`value${number}`])) throw new Error('Record where each value is on the page first.');
    if (contents.isLoading()) {
      setStatus('loading');
      return;
    }

    let accepted = false;
    if (!byHand) {
      // No accept button on the page means no job to take, not a fault.
      accepted = await play(contents, current.acceptSteps, 'accepting the job', true);
      if (accepted) {
        await sleep(ACCEPT_SETTLE_MS);
        await settle(contents);
      }
    }
    // Every recorded value must be on the page, even one the workflow does not type.
    const all = await read();
    const recorded = VALUES.filter((number) => current[`value${number}`]);
    const seen = recorded.map((number) => all[number - 1]);
    const values = all.slice(0, needed);
    // A slip prints the numbers of a job. Words, such as a bank's name, it may shorten or leave out.
    const proven = recorded.filter((number) => current[`number${number}`]).map((number) => all[number - 1]);
    if (seen.some((value) => !value)) {
      // Taking a job and then finding no values means the page is not what was recorded.
      if (accepted) throw new Error('The job was accepted, but its values were not found on the page.');
      setStatus('waiting');
      if (!byHand && current.reload) contents.reload();
      return;
    }
    const key = seen.join(' | ');
    if (!byHand && key === lastKey) {
      setStatus('same', key);
      if (current.reload) contents.reload();
      return;
    }

    setStatus('running', key);
    host.log(`Web job: running ${current.workflow} with ${key}.`);
    const serials = target(current);
    const byProfile = current.closeBy === 'profile';
    // Closing by profile fills the form from the slip, so the slip is read even when it is not checked.
    const reading = current.verify || byProfile;
    const fromGallery = reading && current.source === 'gallery';
    // Only a picture saved after this moment can be this job's slip.
    const since = new Map();
    if (fromGallery) {
      for (const serial of serials) since.set(serial, await host.phoneClock(serial));
    }
    // The phone's app signs itself out when left alone, so it is signed in only for a short while
    // after a job. Past that, or after anything went wrong, the job begins with the way in.
    await runWithEntry(current, text, serials, values, key);
    // The same values must not run twice, whatever the check below says.
    lastKey = key;
    let proof = '';
    if (reading) {
      setStatus('checking', key);
      for (const serial of serials) {
        const screen = fromGallery ? await host.readSlip(serial, since.get(serial)) : await host.readScreen(serial);
        const where = fromGallery ? 'slip picture' : 'phone screen';
        if (fromGallery && !screen.file) throw new Error('The phone saved no new picture, so there is no slip to check. The job was left open.');
        proof = screen.text;
        const missing = current.verify ? logic.verifyScreen(screen.text, proven, current.expect) : [];
        if (missing.length) {
          host.log(`Web job ${key}: the ${where} does not show ${missing.join(', ')}. Picture: ${screen.file || 'none'}. ${screen.notes.join('; ')}`, 'error');
          throw new Error(`The ${where} does not show ${missing.join(', ')}. The job was left open.`);
        }
        if (current.verify) host.log(`Web job ${key}: the ${where} agrees. Picture: ${screen.file || 'none'}.`);
      }
    }
    if (byProfile) await closeByProfile(contents, current, proof, seen, key);
    else await play(contents, current.doneSteps, 'closing the job after the workflow ran', false);
    setStatus('done', key);
  }

  /** Run the paying workflow on the phones, with the workflow that enters the app first when it is needed. */
  async function runWithEntry(current, text, serials, values, key) {
    const entering = host.store.state.workflows[current.enter];
    if (current.enter && !entering) throw new Error(`The workflow for entering the app, "${current.enter}", is not saved.`);
    const fresh = (serial) => lastGood.has(serial) && Date.now() - lastGood.get(serial) < current.stay * 1000;
    const signIn = Boolean(entering) && !serials.every(fresh);
    // Signed in still, the phone is on the screen the last job ended on: `again` takes it from there.
    const going = !signIn && entering && current.again ? host.store.state.workflows[current.again] : '';
    if (!signIn && entering && current.again && !going) throw new Error(`The workflow for going on to the next job, "${current.again}", is not saved.`);
    for (const serial of serials) lastGood.delete(serial);
    if (entering) host.log(`Web job ${key}: ${signIn ? `entering the app with ${current.enter} first` : `the app is taken to be signed in still${going ? `, going on with ${current.again}` : ''}`}.`);
    const outcome = await host.runWorkflow({ name: current.workflow, text: signIn ? `${entering}\n${text}` : going ? `${going}\n${text}` : text, serials, values });
    const failure = outcome.results.find((result) => !result.ok);
    if (failure) throw new Error(`${failure.label}: ${failure.detail}`);
    for (const serial of serials) lastGood.set(serial, Date.now());
  }

  /**
   * Run the paying workflow on one phone, apart from what other phones are doing, with the
   * workflow that enters the app or the one that goes on from the last job put before it.
   */
  async function runOnPhone(current, text, serial, values, key) {
    const entering = host.store.state.workflows[current.enter];
    if (current.enter && !entering) throw new Error(`The workflow for entering the app, "${current.enter}", is not saved.`);
    const signIn = Boolean(entering) && !(lastGood.has(serial) && Date.now() - lastGood.get(serial) < current.stay * 1000);
    const going = !signIn && entering && current.again ? host.store.state.workflows[current.again] : '';
    if (!signIn && entering && current.again && !going) throw new Error(`The workflow for going on to the next job, "${current.again}", is not saved.`);
    lastGood.delete(serial);
    if (entering) host.log(`Withdrawal ${key} on ${serial}: ${signIn ? `entering the app with ${current.enter} first` : `the app is taken to be signed in still${going ? `, going on with ${current.again}` : ''}`}.`);
    const outcome = await host.runWorkflowOne({ name: current.workflow, text: signIn ? `${entering}\n${text}` : going ? `${going}\n${text}` : text, serial, values });
    const failure = outcome.results.find((result) => !result.ok);
    if (failure) throw new Error(`${failure.label}: ${failure.detail}`);
    lastGood.set(serial, Date.now());
  }

  /**
   * Put to rest each phone that ended a job well and has had none since for `stay` seconds. A
   * workflow that fails here moved no money, so it is logged and nothing is stopped.
   */
  async function restTick() {
    const current = config();
    if (!current.rest || !current.enter || !current.stay || working || host.busy()) return;
    const text = host.store.state.workflows[current.rest];
    if (!text) return;
    // A phone that runs another bank's set has no rest among these workflows.
    const others = new Set(host.phones().filter((phone) => current.flows[logic.bankCode(phone.bank)]).map((phone) => phone.serial));
    const idle = [...lastGood.keys()].filter((serial) => !others.has(serial) && !paying.has(serial) && Date.now() - lastGood.get(serial) >= current.stay * 1000);
    if (!idle.length) return;
    // Rested or not, these phones are no longer taken to be on the paying screen.
    for (const serial of idle) lastGood.delete(serial);
    const online = idle.filter((serial) => host.onlineSerials().includes(serial));
    if (!online.length) return;
    // A phone at rest takes no row until its rest is over.
    for (const serial of online) paying.set(serial, { key: '', amount: '', state: 'resting', at: Date.now() });
    publish();
    await Promise.all(online.map(async (serial) => {
      try {
        const outcome = await host.runWorkflowOne({ name: current.rest, text, serial, values: [] });
        const failure = outcome.results.find((result) => !result.ok);
        audit('rest', '', { serial, message: failure ? `${failure.label}: ${failure.detail}` : serial });
        if (failure) host.log(`Resting with ${current.rest} failed on ${failure.label}: ${failure.detail}`, 'error');
      } catch (error) {
        host.log(`Resting with ${current.rest} failed on ${serial}: ${error.message}`, 'error');
      } finally {
        paying.delete(serial);
      }
    }));
    publish();
  }

  async function loadEngine(contents) {
    if (!fs.existsSync(ENGINE_FILE)) throw new Error('The close-job engine file (app/closejob/engine.js) is missing.');
    if (await contents.executeJavaScript('Boolean(globalThis.ClipSyncEngine)', true)) return;
    await contents.executeJavaScript(`${fs.readFileSync(ENGINE_FILE, 'utf8')}\n;true`, true);
  }

  /**
   * Close the job with the site's profile: find the job's row by the slip's amount, then choose
   * the status, the paying bank and the paying account on the site's form and save it.
   */
  async function closeByProfile(contents, current, proof, seen, key, rowKeys) {
    const profile = profileFor(contents.getURL());
    if (!profile) throw new Error('The workflow ran, but there is no close-job profile for this back-office address. The job was left open.');
    if (!fs.existsSync(ENGINE_FILE)) throw new Error('The workflow ran, but the close-job engine file (app/closejob/engine.js) is missing. The job was left open.');
    const slip = logic.parseSlip(proof);
    if (!slip.amount || !slip.sender_account_masked) throw new Error('The workflow ran, but the slip\'s amount and paying account could not be read. The job was left open.');
    // A job value that is a whole account number tells same-amount rows apart better than the slip's hidden digits.
    const account = seen.find((value) => /^\d{8,}$/.test(value)) || '';
    const hints = { account_last4: account.slice(-4) || slip.receiver_account_last4, bank: slip.receiver_bank_name_th };
    await settle(contents);
    await loadEngine(contents);
    const began = Date.now();
    const script = closeScript({ ...profile, dry_run: current.closeDry }, [...(rowKeys || []), slip.amount], slip, hints);
    let result = await contents.executeJavaScript(script, true);
    // Phones finish close to each other, and the page draws its list again after each job that
    // is closed: a row looked for in that moment is not there yet. Nothing was pressed, so the
    // list is read again and the row looked for again.
    for (let attempt = 0; attempt < CLOSE_ROW_RETRIES && !result.ok && result.reason === 'row_not_found'; attempt += 1) {
      await sleep(CLOSE_ROW_RETRY_MS);
      await readOrdersNow(true).catch(() => {});
      await settle(contents);
      await loadEngine(contents);
      result = await contents.executeJavaScript(script, true);
    }
    // How long closing took, and the steps that took a second or more: this is where to look when it is slow.
    const slow = (result.steps || []).map(([action, ms], index) => ({ step: index + 1, action, ms })).filter((step) => step.ms === null || step.ms >= 1000);
    audit('close', key, { ms: Date.now() - began, slow, message: `${((Date.now() - began) / 1000).toFixed(1)}s${slow.length ? ` · ${slow.map((step) => `ขั้น ${step.step} ${step.action} ${step.ms === null ? 'ไม่จบ' : `${(step.ms / 1000).toFixed(1)}s`}`).join(', ')}` : ''}` });
    const detail = ['reason', 'failed_step', 'field', 'tried_value', 'hint'].filter((name) => name in result).map((name) => `${name}=${result[name]}`).join(', ');
    if (result.reason === 'dry_run') throw new Error(`Trial mode: the row for ${result.key} was found and the first button was only outlined. Nothing was pressed and the job was left open.`);
    if (!result.ok) {
      host.log(`Web job ${key}: closing by profile ${profile.profile_id} failed. ${detail}. Slip: ${JSON.stringify(slip)}`, 'error');
      throw new Error(`The workflow ran, but closing the job failed (${detail}). Check the job on the page by hand.`);
    }
    host.log(`Web job ${key}: closed by profile ${profile.profile_id}${result.via ? ` (${result.via})` : ''}. Paid from ${slip.bank || '?'} ${slip.sender_account_masked}.`);
  }

  /**
   * Replay recorded clicks in order, waiting between them as long as when they were recorded.
   * Resolves with whether anything was pressed. With `firstMayBeMissing`, a first click that is
   * not on the page ends the replay with false; any other missing click is an error.
   */
  async function play(contents, steps, what, firstMayBeMissing) {
    for (const [index, step] of steps.entries()) {
      if (index) await sleep(Math.max(MIN_STEP_WAIT_MS, step.wait));
      await settle(contents);
      // What a click opens, such as a confirm box, can take a moment to appear.
      const deadline = Date.now() + (index || !firstMayBeMissing ? STEP_TIMEOUT_MS : 0);
      let pressed = await contents.executeJavaScript(stepScript(step), true);
      while (!pressed && Date.now() < deadline) {
        await sleep(250);
        pressed = await contents.executeJavaScript(stepScript(step), true);
      }
      if (pressed) continue;
      if (!index && firstMayBeMissing) return false;
      throw new Error(`Click ${index + 1} of ${steps.length} for ${what} was not found on the page: ${step.text ? `"${step.text}" ` : ''}${step.selector}`);
    }
    return steps.length > 0;
  }

  function noteStep(message) {
    if (!recording || typeof message !== 'string' || !message.startsWith(RECORD_MARK + recording.token)) return;
    if (recording.steps.length >= MAX_STEPS) return;
    let step = null;
    try {
      step = JSON.parse(message.slice(RECORD_MARK.length + recording.token.length));
    } catch {
      return;
    }
    const now = Date.now();
    recording.steps.push({ ...step, wait: recording.steps.length ? now - recording.at : 0 });
    recording.at = now;
    publish();
  }

  /**
   * Start or stop recording clicks for accepting ('accept') or closing ('done') a job. The clicks
   * are real while recording. Stopping with no click recorded keeps the recording there was.
   */
  async function record(on, which) {
    if (on) {
      if (!RECORDINGS.includes(which)) throw new Error('Unknown recording.');
      if (auto || working) throw new Error('Turn automatic mode off before recording.');
      if (recording) throw new Error('Stop the other recording first.');
      const contents = requireWindow();
      recording = { which, token: crypto.randomBytes(8).toString('hex'), steps: [], at: Date.now() };
      await contents.executeJavaScript(recordScript(recording.token), true);
      window.focus();
    } else if (recording) {
      const steps = cleanSteps(recording.steps);
      const kept = recording.which;
      recording = null;
      if (window) await window.webContents.executeJavaScript(STOP_RECORD_SCRIPT, true).catch(() => {});
      if (steps.length) {
        host.store.config.jobs = { ...config(), [`${kept}Steps`]: steps };
        host.store.saveConfig();
        host.log(`Recorded ${steps.length} click(s) for "${kept}" on the back-office page: ${steps.map((step) => step.selector).join(' , ')}`);
      }
    }
    publish();
    return view();
  }

  /** Forget the recording for accepting ('accept') or closing ('done') a job. */
  function clear(which) {
    if (!RECORDINGS.includes(which)) throw new Error('Unknown recording.');
    const next = { ...config(), [`${which}Steps`]: [] };
    host.store.config.jobs = next;
    host.store.saveConfig();
    publish();
    return view();
  }


  // ── withdrawals ──────────────────────────────────────────────────────────
  // The back office lists the withdrawals that are approved and waiting to be paid. The app reads
  // that list, pays a row from the phone whose amount range holds it, reads the slip the phone
  // saved, and closes the row on the page only when the slip agrees.
  //
  // Money cannot be taken back, so two files keep what was done, whatever happens to the app:
  // - the ledger: one entry per row the app ever began to pay. A row in the ledger is never begun
  //   again, so a crash or a restart cannot pay twice.
  // - the audit log: one line for every step taken, with what was read and decided.

  const ledgerFile = path.join(host.store.baseDir, 'withdraw_ledger.json');
  const auditFile = path.join(host.store.baseDir, 'withdraw_audit.jsonl');
  let ledger = {};
  try {
    const kept = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    if (kept && typeof kept === 'object' && !Array.isArray(kept)) ledger = kept;
  } catch {
    // No ledger yet.
  }
  // What the page lists now. `note` says why the list is empty when it is: 'closed', 'signedOut',
  // 'opening', 'wrongTab', 'noProfile' or 'ok'.
  let orders = { at: 0, note: 'closed', list: [] };
  const audits = [];
  try {
    for (const line of fs.readFileSync(auditFile, 'utf8').trim().split(/\r?\n/).slice(-200)) audits.push(JSON.parse(line));
  } catch {
    // No audit log yet.
  }
  let payAuto = false;
  let payTimer = null;
  let lastSearch = 0;
  let lastOpened = 0;
  // Reading the list by request: the pass the operator typed in (kept in memory only, never on
  // disk, cleared when the back office is closed), whether a row was seen to get the same key by
  // request as off the page, whether one was seen to get another, and the last thing said of it.
  let apiPass = '';
  let apiProven = false;
  let apiWrong = false;
  let apiSaid = '';

  function audit(event, key, detail = {}) {
    const entry = { at: new Date().toISOString(), event, key: key || '', ...detail };
    audits.push(entry);
    if (audits.length > 200) audits.shift();
    try {
      fs.appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      // An audit that cannot be written must not go unnoticed.
      host.log(`The withdrawal audit log could not be written: ${error.message}`, 'error');
    }
  }

  function mark(order, state, detail = {}) {
    ledger[order.key] = { ...ledger[order.key], state, at: new Date().toISOString(), account: order.account, holder: order.holder || (ledger[order.key] || {}).holder || '', amount: order.amount, bank: order.bank, requested: order.requested, ...detail };
    const temp = `${ledgerFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(ledger, null, 2), 'utf8');
    fs.renameSync(temp, ledgerFile);
  }

  /** Why everything is stopped, or null. Kept in the settings, so a restart does not clear it. */
  const halted = () => (host.store.config.withdraw_halt && typeof host.store.config.withdraw_halt === 'object' ? host.store.config.withdraw_halt : null);
  /** The phones that are stopped, by serial: { key, message, at }. Kept in the settings too. */
  const stops = () => (host.store.config.withdraw_stops && typeof host.store.config.withdraw_stops === 'object' ? host.store.config.withdraw_stops : {});

  // Phones that are paying or resting now: serial → { key, amount, state, at }. A phone in here takes no other row.
  const paying = new Map();
  // When each phone last began a row, so rows go round the phones and not always to the first.
  const lastTaken = new Map();
  // One thing at a time uses the back-office page: reading and searching the list, or closing a job.
  let pageQueue = Promise.resolve();
  const withPage = (work) => {
    const next = pageQueue.then(work, work);
    pageQueue = next.catch(() => {});
    return next;
  };

  /** Stop everything: a fault of the back office, which is the same for every phone. */
  function halt(key, message) {
    payAuto = false;
    stopAuto();
    // After a fault nobody knows which screen a phone is on; the next job enters the app afresh.
    lastGood.clear();
    host.store.config.withdraw_halt = { key: key || '', message, at: new Date().toISOString() };
    host.store.saveConfig();
    audit('halt', key, { message });
    host.log(`Withdrawals stopped: ${message}`, 'error');
    if (host.notify) host.notify('หยุดทำงานทั้งหมด: ปิดงานในหลังบ้านไม่สำเร็จ ตรวจรายการก่อนรีเซ็ต');
  }

  /** Stop one phone: a fault on that phone. The others go on paying. */
  function stopPhone(serial, key, message) {
    lastGood.delete(serial);
    host.store.config.withdraw_stops = { ...stops(), [serial]: { key: key || '', message, at: new Date().toISOString() } };
    host.store.saveConfig();
    audit('halt', key, { serial, message });
    host.log(`Withdrawals stopped on ${serial}: ${message}`, 'error');
    if (host.notify) host.notify(`${serial}: หยุดทำงาน ตรวจรายการก่อนรีเซ็ต`);
  }

  // The bank starts every account's daily limit again at midnight, and so does a phone's daily cap
  // here: only rows of today count (see spentToday). This turn of the clock just says so and
  // draws the window again, so a phone at its cap is seen to be free without waiting for a job.
  let dayNow = new Date().toDateString();
  // The hours at which some bank starts its day apart from midnight, and the one each was last seen in.
  const turns = Object.fromEntries(Object.keys(logic.DAY_TURN_HOUR).map((code) => [code, logic.dayStart(code)]));
  setInterval(() => {
    for (const code of Object.keys(turns)) {
      if (logic.dayStart(code) === turns[code]) continue;
      turns[code] = logic.dayStart(code);
      audit('newday', '', { message: `เพดานต่อวันของเครื่อง ${code} เริ่มนับใหม่` });
      host.log(`The daily caps of ${code} phones count from zero again.`);
      publish();
    }
    const day = new Date().toDateString();
    if (day === dayNow) return;
    dayNow = day;
    audit('newday', '', { message: 'เริ่มวันใหม่ เพดานต่อวันของทุกเครื่องเริ่มนับใหม่' });
    host.log('A new day: the daily cap of every phone counts from zero again.');
    publish();
  }, 20000).unref();

  /** Reset the stop of one phone, or with no serial the stop of everything. */
  function unhalt(serial) {
    if (serial) {
      const was = stops()[serial];
      if (was) audit('reset', was.key, { serial, was: was.message });
      const rest = { ...stops() };
      delete rest[serial];
      host.store.config.withdraw_stops = rest;
      host.store.saveConfig();
      lastGood.delete(serial);
      host.log(`Withdrawals: the stop on ${serial} was reset.`);
    } else {
      if (halted()) audit('reset', halted().key, { was: halted().message });
      delete host.store.config.withdraw_halt;
      host.store.saveConfig();
      lastGood.clear();
      host.log('Withdrawals: the stop was reset.');
    }
    publish();
    return view();
  }

  /** Whether a phone is told to pass over rows to this bank: by the list for every phone, or by its own. */
  function skips(phone, code) {
    return Boolean(code) && (host.skipBanks().includes(code) || (phone.skip || []).includes(code));
  }

  /** Whether a row's bank is one the phones' app does not list, where only those are paid to. */
  function unlistedBank(order) {
    return Boolean(host.knownBanksOnly) && !logic.bankCode(order.bank);
  }

  /**
   * The online phone whose amount range holds this row's amount and which pays to its bank, or
   * null. A phone with no range takes nothing.
   */
  function phoneFor(order, free = false) {
    const value = Number(order.amount);
    const code = logic.bankCode(order.bank);
    if (unlistedBank(order)) return null;
    const able = host.phones().filter((phone) => phone.min !== null && phone.max !== null && value >= phone.min && value <= phone.max && !skips(phone, code) && !shortOf(phone, value, code) && !(free && paying.has(phone.serial)));
    // A row to a bank that limits transfers within itself apart goes first to a phone of that
    // bank with a cap of its own for them: what the phones may send to other banks is spared.
    const within = (phone) => (logic.OWN_LIMIT_BANKS.includes(code) && logic.bankCode(phone.bank) === code && phone.capOwn !== null ? 0 : 1);
    // Then the phone that has waited longest takes the row, so the work is shared out.
    able.sort((a, b) => within(a) - within(b) || (lastTaken.get(a.serial) || 0) - (lastTaken.get(b.serial) || 0));
    return able[0] || null;
  }

  /** Why no phone takes a row, as a short word for the window, or '' when that is not known. */
  function whyNot(order) {
    if (unlistedBank(order)) return 'nobank';
    const value = Number(order.amount);
    const code = logic.bankCode(order.bank);
    const inRange = host.phones().filter((each) => each.min !== null && value >= each.min && value <= each.max);
    const willing = inRange.find((each) => !skips(each, code));
    // A phone that could take the row but for a cap is not the answer when another one takes it without.
    if (willing) return shortOf(willing, value, code);
    // Every phone that takes this amount passes over the bank, or the bank is passed over by all.
    return inRange.length || host.skipBanks().includes(code) ? 'skipbank' : '';
  }

  // ── the shop's accounts ──
  // A second window, never shown, holds the back office's list of the shop's own accounts. It is
  // signed in the same way as the first, and only its search button is ever pressed.
  let ledgerWindow = null;
  let lastAccounts = 0;
  // What the list said: { at, note, map: { account: { balance, on, updated, holder } } }.
  let accounts = { at: 0, note: 'off', map: {} };

  function closeAccounts() {
    if (ledgerWindow) ledgerWindow.destroy();
    ledgerWindow = null;
    accounts = { at: 0, note: 'off', map: {} };
  }

  /** Bring what is known of the shop's accounts up to date, when it is due. Reads only. */
  async function readAccounts(force = false) {
    const at = Date.now();
    const current = config();
    if (!window || !current.balances) {
      if (ledgerWindow) closeAccounts();
      return;
    }
    const profile = profileFor(window.webContents.getURL());
    if (!profile || !profile.settlement_page_path) return;
    if (!force && (switching || at - lastAccounts < MIN_ACCOUNTS_MS)) return;
    lastAccounts = at;
    if (!ledgerWindow) {
      ledgerWindow = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: { partition: 'persist:backoffice', sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      ledgerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      ledgerWindow.on('closed', () => { ledgerWindow = null; });
      ledgerWindow.loadURL(new URL(profile.settlement_page_path, window.webContents.getURL()).href);
      // The page is read as soon as it has loaded, not a whole turn later.
      lastAccounts = 0;
      return;
    }
    const contents = ledgerWindow.webContents;
    if (contents.isLoading()) {
      lastAccounts = 0;
      return;
    }
    let page = await contents.executeJavaScript(ACCOUNTS_SCRIPT, true);
    if (page.signedOut || page.path !== profile.settlement_page_path) {
      accounts = { at, note: page.signedOut ? 'signedOut' : 'elsewhere', map: {} };
      // Signed out, or sent elsewhere by the site: ask for the page again next time.
      contents.loadURL(new URL(profile.settlement_page_path, window.webContents.getURL()).href);
      return;
    }
    if (await contents.executeJavaScript(ACCOUNTS_SEARCH_SCRIPT, true)) {
      await sleep(SEARCH_SETTLE_MS);
      await settle(contents);
      // The list is filled in a moment after the search: read it once two looks agree and it has rows.
      let before = '';
      for (let look = 0; look < 16; look += 1) {
        page = await contents.executeJavaScript(ACCOUNTS_SCRIPT, true);
        const now = JSON.stringify(page.rows || []);
        if ((page.rows || []).length && now === before) break;
        before = now;
        await sleep(500);
      }
    }
    const map = {};
    for (const row of page.rows || []) {
      const account = logic.parseSettlementRow(row.cells, row.on);
      // An account listed twice cannot be told apart, so neither listing is used.
      if (account) map[account.account] = account.account in map ? null : account;
    }
    for (const key of Object.keys(map)) if (!map[key]) delete map[key];
    // A list with no account in it, where there were some, is a page caught half drawn: keep what was read.
    if (!Object.keys(map).length && Object.keys(accounts.map).length && accounts.note === 'ok' && at - accounts.at <= ACCOUNTS_FRESH_MS) return;
    accounts = { at, note: 'ok', map };
  }

  // When the shop's paying accounts were last read by request, so they are not asked for too often.
  let lastApiAccounts = 0;

  /**
   * Read the shop's paying accounts by the back office's own request: each account number, its id
   * for closing, what is left in it, and whether it is on. Fills the same map the page fills, so
   * everything that reads balances and account state works the same. Needs no window.
   */
  async function readApiAccounts(force = false) {
    const current = config();
    if (!apiReadable(current) || !current.apiSettlementPath) return;
    const at = Date.now();
    if (!force && at - lastApiAccounts < MIN_ACCOUNTS_MS) return;
    lastApiAccounts = at;
    try {
      const { status, body, text } = await apiRequest('GET', new URL(current.apiSettlementPath, current.apiBase).href, apiPass, { origin: current.apiOrigin });
      if (status === 401 || status === 403) {
        apiPass = '';
        apiSay(`Reading the shop's accounts by request stopped: the pass was refused (${status}). Type it in again.`, 'error');
        accounts = { at, note: 'signedOut', map: {} };
        return;
      }
      if (status !== 200) throw new Error(`the service answered ${status}${text ? ` (${String(text).replace(/\s+/g, ' ').slice(0, 200)})` : ''}`);
      const rows = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : []);
      const map = {};
      for (const row of rows) {
        const account = logic.settlementFromApi(row);
        // An account listed twice cannot be told apart, so neither listing is used.
        if (account) map[account.account] = account.account in map ? null : account;
      }
      for (const key of Object.keys(map)) if (!map[key]) delete map[key];
      accounts = { at, note: 'ok', map };
    } catch (error) {
      accounts = { at, note: 'error', map: accounts.map, error: error.message };
    }
  }

  /**
   * Close one approved withdrawal by the back office's own request: find the paying account by the
   * phone's own account number, then mark the withdrawal paid from it. Trial mode only outlines it.
   * Throws when the paying account is not found, is off, or the service does not agree.
   */
  async function closeByApi(current, order, phone, key) {
    if (!order.id) throw new Error('The workflow ran, but the withdrawal has no id read by request, so it cannot be closed by request. The job was left open.');
    await readApiAccounts(true);
    const payFrom = accounts.map[phone.account];
    if (!payFrom || payFrom.account !== phone.account) throw new Error(`The workflow ran, but the paying account ${phone.account} is not in the shop's accounts read by request, so the job was left open.`);
    if (payFrom.on === false) throw new Error(`The workflow ran, but the paying account ${phone.account} is switched off in the back office, so the job was left open.`);
    if (current.closeDry) throw new Error(`Trial mode: withdrawal ${order.id} would be closed as paid from ${phone.account} (${payFrom.id}). Nothing was sent and the job was left open.`);
    const began = Date.now();
    const { status, body } = await apiRequest('PATCH', new URL(logic.apiClosePath(order.id), current.apiBase).href, apiPass, { body: logic.closeApproveBody(payFrom.id), origin: current.apiOrigin });
    audit('close', key, { ms: Date.now() - began, message: `by request · ${((Date.now() - began) / 1000).toFixed(1)}s · ${status}` });
    if (status === 401 || status === 403) {
      apiPass = '';
      throw new Error(`Closing the job by request failed: the pass was refused (${status}). Type it in again, then check the job by hand.`);
    }
    if (status !== 200 || !logic.closeApproved(body)) throw new Error(`Closing the job by request failed (the service answered ${status}). Check the job on the page by hand.`);
    host.log(`Withdrawal ${order.amount} closed by request, paid from ${phone.account}.`);
  }

  // True while an account's switch is being set, so the list is not searched under it.
  let switching = false;

  /** Whether the back office can be reached: by request in link mode, or the signed-in window. */
  async function signedIn() {
    if (apiReadable(config())) return true;
    if (!window || window.webContents.isLoading()) return false;
    return window.webContents.executeJavaScript('!document.querySelector("input[type=password]") && !/login/i.test(location.pathname)', true).catch(() => false);
  }

  /**
   * Set a phone's account on or off in the back office; on, the close-job form offers it. Resolves
   * with true when the switch was pressed, false when it stood that way already or accounts are
   * not read. Throws when the switch could not be seen to stand that way afterwards.
   */
  async function switchAccount(account, on) {
    if (!account || !config().balances) return false;
    const current = config();
    // With the account list read by request, the account is switched by request too: no window needed.
    if (apiReadable(current)) return switchAccountByApi(current, account, on);
    if (!window) return false;
    const profile = profileFor(window.webContents.getURL());
    if (!profile || !profile.settlement_page_path) return false;
    if (switching) throw new Error('Another account is being switched in the back office. Try again in a moment.');
    switching = true;
    try {
      // The list has to be on screen in the hidden window first.
      for (let wait = 0; wait < 40 && accounts.note !== 'ok'; wait += 1) {
        await readAccounts(true);
        if (accounts.note !== 'ok') await sleep(500);
      }
      if (accounts.note !== 'ok' || !ledgerWindow) throw new Error('The back office\'s list of accounts could not be read, so the account was not switched there. Sign in to the back office and try again.');
      const contents = ledgerWindow.webContents;
      const pressed = await contents.executeJavaScript(accountSwitchScript(account, on), true);
      if (pressed === 'same') return false;
      if (pressed === 'missing') throw new Error(`Account ${account} is not in the back office's list of accounts, so it was not switched there.`);
      if (pressed === 'twice') throw new Error(`Account ${account} is listed more than once in the back office, so it was not switched there. Switch it by hand.`);
      // The site may ask to confirm, and then say it is done: agree to at most two boxes.
      const said = [];
      for (let wait = 0; wait < 12 && said.length < 2; wait += 1) {
        await sleep(500);
        const words = await contents.executeJavaScript(ACCOUNTS_AGREE_SCRIPT, true);
        if (words) said.push(words);
      }
      await sleep(SEARCH_SETTLE_MS);
      await readAccounts(true);
      const listed = accounts.map[account];
      audit(on ? 'account-on' : 'account-off', account, { said, on: listed ? listed.on : null });
      if (!listed || listed.on !== Boolean(on)) throw new Error(`Account ${account} was pressed ${on ? 'on' : 'off'} in the back office, but the list does not show it ${on ? 'on' : 'off'}. Check it on the page by hand.`);
      host.log(`Account ${account} was switched ${on ? 'on' : 'off'} in the back office.`);
      return true;
    } finally {
      switching = false;
    }
  }

  /**
   * Switch a phone's account on or off by the back office's own request. Resolves true when the
   * switch was sent, false when it stood that way already. Throws when the account is not known or
   * the service does not agree. Needs no window.
   */
  async function switchAccountByApi(current, account, on) {
    if (switching) throw new Error('Another account is being switched. Try again in a moment.');
    switching = true;
    try {
      await readApiAccounts(true);
      const listed = accounts.map[account];
      if (!listed) throw new Error(`Account ${account} is not in the shop's accounts read by request, so it was not switched.`);
      if (listed.on === Boolean(on)) return false;
      const { status, text } = await apiRequest('PATCH', new URL(logic.settlementTogglePath(listed.id), current.apiBase).href, apiPass, { body: logic.settlementToggleBody(on), origin: current.apiOrigin });
      if (status === 401 || status === 403) {
        apiPass = '';
        throw new Error(`Switching the account failed: the pass was refused (${status}). Type it in again.`);
      }
      if (status !== 200) throw new Error(`Switching account ${account} ${on ? 'on' : 'off'} by request failed (the service answered ${status}${text ? ` (${String(text).replace(/\s+/g, ' ').slice(0, 160)})` : ''}).`);
      if (accounts.map[account]) accounts.map[account].on = Boolean(on);
      audit(on ? 'account-on' : 'account-off', account, { on: Boolean(on), via: 'request' });
      host.log(`Account ${account} was switched ${on ? 'on' : 'off'} by request.`);
      publish();
      return true;
    } finally {
      switching = false;
    }
  }

  /** What the back office says of a phone's account now, or null when that is not known or not fresh. */
  function accountOf(phone) {
    if (!phone.account || accounts.note !== 'ok' || Date.now() - accounts.at > ACCOUNTS_FRESH_MS) return null;
    return accounts.map[phone.account] || null;
  }

  /**
   * The slip picture of a row the app began, or ''. Rows written before slips were kept with the
   * row have theirs named in the fault they stopped on.
   */
  function slipOf(entry) {
    if (entry.slip) return entry.slip;
    const named = /Picture: (.*slip_[^\\/]*\.(?:jpe?g|png))/i.exec(`${entry.detail || ''} ${entry.was || ''}`);
    return named ? named[1] : '';
  }

  /** What a phone paid today: only rows with a slip, which is the proof that money left the account. */
  function spentToday(serial) {
    const today = new Date().toDateString();
    return Object.values(ledger).filter((entry) => entry.serial === serial && slipOf(entry) && new Date(entry.at).toDateString() === today).reduce((sum, entry) => sum + Number(entry.amount), 0);
  }

  /**
   * What a phone has paid since its bank's day began, apart for its own bank and for other banks:
   * { own, other, since }. Only rows with a slip count. A daily cap is measured against this.
   */
  function spentBy(serial, bank) {
    const code = logic.bankCode(bank);
    const since = logic.dayStart(code);
    const spent = { own: 0, other: 0, since };
    for (const entry of Object.values(ledger)) {
      if (entry.serial !== serial || !slipOf(entry) || Date.parse(entry.at) < since) continue;
      spent[code && logic.bankCode(entry.bank) === code ? 'own' : 'other'] += Number(entry.amount) || 0;
    }
    return spent;
  }

  /** Which of a phone's daily caps a payment to the bank `toCode` would go over, or ''. */
  function capOf(phone, value, toCode) {
    return logic.capShort({ bankCode: logic.bankCode(phone.bank), cap: phone.cap, capOwn: phone.capOwn }, spentBy(phone.serial, phone.bank), value, toCode);
  }

  /** What a phone's account holds, as far as is known: the back office's figure, else the one entered by hand. */
  function balanceOf(phone) {
    const listed = accountOf(phone);
    return listed && listed.balance !== null ? listed.balance : phone.balance;
  }

  // Phones already told to be out of money, so each is told once until it has money again.
  const broke = new Set();

  /** Tell the operator, once, of each phone whose account holds less than its smallest amount. */
  function checkFunds() {
    for (const phone of host.phones()) {
      const balance = balanceOf(phone);
      const out = phone.min !== null && balance !== null && balance < phone.min;
      if (!out) broke.delete(phone.serial);
      else if (!broke.has(phone.serial)) {
        broke.add(phone.serial);
        const message = `${phone.label}: เงินในบัญชีหมด คงเหลือ ${balance.toFixed(2)} ต่ำกว่ายอดต่ำสุด ${phone.min}`;
        audit('broke', '', { serial: phone.serial, phone: phone.label, message });
        host.log(message, 'error');
        if (host.notify) host.notify(message);
        publish();
      }
    }
  }

  /** Whether the back office's list of the shop's accounts is read at all here: off its page, or by request. */
  function accountsRead(current) {
    if (!window) return apiReadable(current) && Boolean(current.apiSettlementPath);
    if (!current.balances) return false;
    const profile = profileFor(window.webContents.getURL());
    return Boolean(profile && profile.settlement_page_path);
  }

  /**
   * Whether a phone is still being checked: it came online, and the back office has not been read
   * since for whether its account is on and what is left in it. It takes no row until then.
   */
  function checking(phone) {
    return Boolean(phone.account) && accounts.at < phone.since && accountsRead(config());
  }

  /** Whether the back office's list was read just now and a phone's account is not in it. */
  function unlisted(phone) {
    return Boolean(phone.account) && accounts.note === 'ok' && Date.now() - accounts.at <= ACCOUNTS_FRESH_MS && !accounts.map[phone.account] && accountsRead(config());
  }

  /** Make every phone stand the way its account stands in the back office, once that has been read. */
  function syncPhones() {
    if (accounts.note === 'ok' && Date.now() - accounts.at <= ACCOUNTS_FRESH_MS) host.accountStates(accounts.map);
  }

  /** Why a phone in range cannot pay this amount now, or '' when it can. */
  /** The job settings as they are for one phone: with the workflows of its bank's app, when that bank has a set. */
  function flowOf(current, phone) {
    const own = current.flows[logic.bankCode(phone.bank)];
    return own ? { ...current, ...own } : current;
  }

  /** True when a phone pays from a bank whose app no workflows are held for. */
  function noFlow(current, phone) {
    const code = logic.bankCode(phone.bank);
    return Boolean(current.bank) && Boolean(code) && code !== current.bank && !current.flows[code];
  }

  /** The time a phone's bank's pause ends ("03:00") while it holds, or ''. A phone with no bank set pays from the first bank. */
  function pausedUntil(phone) {
    if (!host.bankPauses) return '';
    const code = logic.bankCode(host.payBank ? host.payBank(phone.serial) : '') || config().bank;
    return logic.pauseUntil(host.bankPauses()[code]);
  }

  function shortOf(phone, value, toCode) {
    if (stops()[phone.serial]) return 'stopped';
    if (checking(phone)) return 'checking';
    if (noFlow(config(), phone)) return 'noflow';
    // In its bank's pause a phone starts nothing; a row it is paying already goes on.
    if (pausedUntil(phone)) return 'paused';
    // An account the back office does not list cannot be seen to be on, and a row paid from it could not be closed.
    if (unlisted(phone)) return 'missing';
    const over = capOf(phone, value, toCode);
    if (over) return over;
    const listed = accountOf(phone);
    // Switched off in the back office, an account is not offered on the close-job form: a row paid from it could not be closed.
    if (listed && listed.on === false) return 'off';
    // The back office's figure is the one to go by; the figure entered by hand stands in when it is not known.
    const balance = balanceOf(phone);
    if (balance !== null && value > balance) return 'balance';
    return '';
  }

  // An amount as a person types it: 739 for 739.00, 739.50 as it is.
  const typedAmount = (amount) => (Number.isInteger(Number(amount)) ? String(Number(amount)) : Number(amount).toFixed(2));

  /**
   * The amounts the queue shows, as [smallest, largest]: from the smallest amount set on any phone
   * to the largest set on any phone, online or not. Null when no phone has a range.
   */
  function shownRange() {
    const ranges = host.ranges();
    return ranges.length ? [Math.min(...ranges.map((range) => range.min)), Math.max(...ranges.map((range) => range.max))] : null;
  }

  /** The amount range to ask for: the one the queue shows. Null when no range is to be asked for. */
  function askedRange(current) {
    const shown = shownRange();
    if (!current.filter || !shown) return null;
    // A row that is being paid stays asked for, whatever the range is now: it is closed on this page.
    const flying = [...paying.values()].map((each) => Number(each.amount)).filter((amount) => amount > 0);
    return [String(Math.min(shown[0], ...flying)), String(Math.max(shown[1], ...flying))];
  }

  /** Whether reading the withdrawal list by request is set up: switched on, a pass held, a base address. */
  function apiReadable(current) {
    return Boolean(current.api && apiPass && !apiWrong && /^https?:\/\/\S+$/i.test(current.apiBase));
  }

  function apiSay(message, level) {
    if (message === apiSaid) return;
    apiSaid = message;
    host.log(message, level);
  }

  /**
   * The rows the queue shows: those whose amount falls in the range the phones are set to, taken
   * together. With no phone range set, every row is kept. This hides rows no phone is meant to pay,
   * as the page filter did.
   */
  function byConfiguredRange(list) {
    const shown = shownRange();
    if (!shown) return list;
    return list.filter((order) => Number(order.amount) >= shown[0] && Number(order.amount) <= shown[1]);
  }

  /**
   * The list by the back office's own request. `pageRead` says a logged-in page was read too, and
   * `fromPage` is what it showed. With a page, a row shown on both must get the same key by request,
   * or the request is not trusted at all and the page's list is used: the ledger knows rows by that
   * key, so a request that gives another key would let the same row be paid twice. Without a page
   * the request's list is used as is; the ledger still stops any row from being begun twice.
   */
  async function listByRequest(current, fromPage, pageRead) {
    if (!apiReadable(current)) return fromPage;
    let list = [];
    try {
      const range = askedRange(current);
      const items = [];
      for (let page = 0; page < API_MAX_PAGES; page += 1) {
        const answer = await apiListPage(current.apiBase, apiPass, range, page * API_PAGE, current.apiOrigin);
        if (answer.status === 401 || answer.status === 403) {
          apiPass = '';
          apiSay(`Reading the withdrawal list by request stopped: the pass was refused (${answer.status}). Type it in again.`, 'error');
          return fromPage;
        }
        if (answer.status !== 200 || !answer.data) throw new Error(`the service answered ${answer.status} for ${answer.url}${answer.text ? ` (${String(answer.text).replace(/\s+/g, ' ').slice(0, 800)})` : ''}`);
        items.push(...answer.data);
        if (!answer.data.length || items.length >= answer.total) break;
      }
      list = items.map((item) => logic.withdrawFromApi(item)).filter(Boolean);
    } catch (error) {
      apiSay(`Reading the withdrawal list by request failed: ${error.message}.${pageRead ? ' The list is read off the page.' : ''}`, 'error');
      return fromPage;
    }
    if (!pageRead) {
      apiSay('The withdrawal list is read by the back office\'s own request.');
      return list;
    }
    // A row the page shows too must get the same key by request, or the request is not trusted at all.
    for (const row of fromPage) {
      const same = list.filter((each) => each.account === row.account && Number(each.amount) === Number(row.amount));
      if (same.some((each) => each.key === row.key)) apiProven = true;
      else if (same.length) {
        apiWrong = true;
        apiSay('Reading the withdrawal list by request is switched off until the back office is opened again: a row has one key by request and another on the page.', 'error');
        return fromPage;
      }
    }
    if (!apiProven) return fromPage;
    apiSay('The withdrawal list is read by the back office\'s own request: a row was seen to agree with the page.');
    return list;
  }

  /**
   * Read the withdrawal list off the page. With `refresh`, first ask the page for the newest list,
   * with the phones' amount range in the page's own filter. Nothing on the page is changed
   * except its filter.
   */
  function readOrders(refresh) {
    return withPage(() => readOrdersNow(refresh));
  }

  async function readOrdersNow(refresh) {
    const at = Date.now();
    const current = config();
    // Reading by request carries its own pass, so it needs no back-office window. Without a window
    // the list comes from the request alone; paying still needs a window, which also closes jobs,
    // unless closing by request is set up too.
    if (!window) {
      if (!apiReadable(current)) {
        orders = { at, note: 'closed', list: [] };
        return orders;
      }
      const list = await listByRequest(current, [], false);
      orders = { at, note: 'ok', list: byConfiguredRange(list), via: 'request' };
      return orders;
    }
    const contents = window.webContents;
    if (contents.isLoading()) return orders;
    const profile = profileFor(contents.getURL());
    let page = await contents.executeJavaScript(ORDERS_SCRIPT, true);
    let note = 'ok';
    const onTab = (text) => profile && (profile.withdraw_notify_tab_hints || []).some((hint) => String(text).toLowerCase().includes(String(hint).toLowerCase()));
    if (page.signedOut) {
      note = 'signedOut';
      // Signed out while out of sight: show the window, so the operator can sign in.
      if (!window.isVisible()) window.show();
    } else if (!profile) note = 'noProfile';
    else if (page.path !== profile.order_page_url_hint || !onTab(page.tab)) {
      note = page.path === profile.order_page_url_hint ? 'wrongTab' : 'opening';
      // Take the window to the list of approved withdrawals, but not over and over.
      if (current.watch && !working && !paying.size && at - lastOpened > 15000) {
        lastOpened = at;
        contents.loadURL(new URL(`${profile.order_page_url_hint}?${profile.withdraw_notify_tab_query || ''}`, contents.getURL()).href);
        note = 'opening';
      }
    } else if (refresh && at - lastSearch >= MIN_SEARCH_MS) {
      lastSearch = at;
      const range = askedRange(current);
      await loadEngine(contents);
      await contents.executeJavaScript(searchScript(profile, range), true);
      await sleep(SEARCH_SETTLE_MS);
      await settle(contents);
      page = await contents.executeJavaScript(ORDERS_SCRIPT, true);
    }
    const fromPage = note === 'ok' ? (page.rows || []).map((cells) => logic.parseWithdrawRow(cells)).filter(Boolean) : [];
    const list = current.api && note === 'ok' ? await listByRequest(current, fromPage, true) : fromPage;
    orders = { at, note, list: note === 'ok' ? byConfiguredRange(list) : list, via: list === fromPage ? 'page' : 'request' };
    return orders;
  }

  /** The list for the window: each row with what the ledger says of it and the phone that would pay it. */
  function ordersView() {
    return {
      at: orders.at,
      note: orders.note,
      // Shown in the order they are paid: the oldest asked for at the top.
      list: logic.oldestFirst(orders.list).map((order) => {
        const phone = phoneFor(order);
        const entry = ledger[order.key];
        // Say why no phone takes a row whose amount is in a phone's range.
        return { ...order, state: entry ? entry.state : '', detail: entry ? entry.detail || '' : '', serial: phone ? phone.serial : '', phone: phone ? phone.label : '', short: phone ? '' : whyNot(order), bankCode: logic.bankCode(order.bank) };
      }),
    };
  }

  /**
   * Pay one row and close it. Rows are paid at the same time on different phones; a phone pays one
   * row at a time, and a row goes to one phone. Anything that goes wrong once a phone has been
   * touched stops that phone until the operator has looked and reset it: the app cannot know by
   * itself whether money moved. A fault in closing on the page stops everything.
   */
  async function pay(key) {
    if (working) throw new Error('A job is already running.');
    if (halted()) throw new Error('Withdrawals are stopped. Check the row in red, then reset the stop.');
    const current = config();
    // With reading-and-closing by request set up, paying needs no back-office window: the job is
    // read and closed by the back office's own requests. Otherwise the window closes it on the page.
    const byApi = apiReadable(current);
    const contents = window ? window.webContents : null;
    if (!byApi && !contents) throw new Error('Open the back office and sign in first.');
    const text = host.store.state.workflows[current.workflow];
    if (!text) throw new Error('Choose a saved workflow for paying first.');
    if (host.busy()) throw new Error(`Wait for "${host.busy()}" to finish first.`);
    if (!byApi && !profileFor(contents.getURL())) throw new Error('There is no close-job profile for this back-office address.');
    const listed = orders.list.find((each) => each.key === key);
    if (!listed) throw new Error('That withdrawal is no longer on the page.');
    if (ledger[key] || [...paying.values()].some((each) => each.key === key)) throw new Error('That withdrawal was already begun by this app, so it is not begun again.');
    const phone = phoneFor(listed, true);
    if (!phone) {
      if (phoneFor(listed)) throw new Error(`Every phone that can pay ${listed.amount} is busy. Try again in a moment.`);
      const why = whyNot(listed);
      if (why === 'stopped') throw new Error(`The phone that takes ${listed.amount} is stopped. Check its row in red, then reset that phone.`);
      if (why === 'checking') throw new Error(`The phone that takes ${listed.amount} is still being checked. Try again in a moment.`);
      if (why === 'skipbank') throw new Error(`Withdrawals to ${listed.bank} are passed over for now.`);
      if (why === 'nobank') throw new Error(`The bank "${listed.bank}" is not one the phones' app lists, so it is not paid to.`);
      throw new Error(`No online phone can pay ${listed.amount} now.`);
    }
    const serial = phone.serial;
    // The workflows of this phone's bank.
    const flow = flowOf(current, phone);
    const flowText = host.store.state.workflows[flow.workflow];
    if (!flowText) throw new Error(`The workflow "${flow.workflow}" that ${phone.label} pays with is not saved.`);
    // The row and the phone are taken from here on, before anything is waited for.
    const mine = { key, amount: listed.amount, bank: listed.bank, state: 'running', at: Date.now() };
    paying.set(serial, mine);
    lastTaken.set(serial, Date.now());
    const stage = (state) => {
      mine.state = state;
      setStatus(state, `${phone.label} · ${listed.amount} · ${listed.bank}`);
    };
    let order = null;
    let begun = false;
    let closing = false;
    try {
      // The row must still be on the page: somebody may have closed it by hand since the list was read.
      await readOrders(false);
      order = orders.list.find((each) => each.key === key);
      if (!order) throw new Error('That withdrawal is no longer on the page.');
      if (ledger[key]) throw new Error('That withdrawal was already begun by this app, so it is not begun again.');

      // From here on the phone is touched: every fault is a stop.
      begun = true;
      mark(order, 'started', { serial, phone: phone.label });
      audit('start', key, { ...order, serial, phone: phone.label, workflow: flow.workflow });
      stage('running');
      const since = await host.phoneClock(serial);
      // What a "checktext?" step saw before this run is not this run's.
      if (host.screenSaw) host.screenSaw(serial);
      // The fourth value is the name of the account's holder, for a workflow that checks it; a job without one sends a dash.
      await runOnPhone(flow, flowText, serial, [order.account, typedAmount(order.amount), order.bank, order.holder || '-'], key);
      audit('workflow', key, { serial });

      stage('checking');
      const read = await host.readSlip(serial, since);
      if (!read.file) throw new Error('The workflow ran, but the phone saved no new picture, so there is no slip to check.');
      // A slip is proof that money left the account, whatever the checks below make of it.
      mark(order, 'started', { slip: read.file });
      const slip = logic.parseSlip(read.text);
      const wrong = [];
      if (!slip.amount || Number(slip.amount) !== Number(order.amount)) wrong.push(`the amount (slip ${slip.amount || 'unread'}, row ${order.amount})`);
      // An account whose hidden digits the reader misread, or where it added a digit, is known by its ends only.
      const accountOnSlip = logic.screenShows(logic.slipDigits(read.text), order.account) || logic.endsAgree(slip.receiver_account_masked, order.account);
      // A workflow may look for the account on the bank app's own success page ("checktext? {1}"), read
      // from its words, not a picture: when that page showed it, a misread slip is noted, not a stop.
      const shownOnPage = host.screenSaw ? host.screenSaw(serial).has(String(order.account)) : false;
      if (!accountOnSlip && !shownOnPage) wrong.push('the account paid to');
      // The slip must come from this phone's own account: another account means another phone or app paid.
      if (phone.account && !logic.maskAgrees(slip.sender_account_masked, phone.account)) wrong.push(`the paying account (slip ${slip.sender_account_masked || 'unread'})`);
      if (phone.bank && logic.bankCode(phone.bank) && slip.bank && logic.bankCode(phone.bank) !== slip.bank) wrong.push(`the paying bank (slip ${slip.bank})`);
      wrong.push(...logic.verifyScreen(read.text, [], flow.expect));
      audit('slip', key, { serial, file: read.file, slip, agrees: !wrong.length, wrong, ...(shownOnPage ? { page: accountOnSlip ? 'shown' : 'shown, slip misread' } : {}) });
      if (wrong.length) throw new Error(`The slip does not agree on ${wrong.join(', ')}. Picture: ${read.file}`);
      mark(order, 'paid', { slip: read.file });
      host.spend(serial, order.amount);
      // Until the list is read again, what it said is too high by what was just paid.
      const account = accounts.map[phone.account];
      if (account && account.balance !== null) account.balance = Math.round((account.balance - Number(order.amount)) * 100) / 100;

      try {
        stage('closing');
        closing = true;
        // Closing by request names the paying account by its id; closing on the page waits its turn
        // and tells this row from the others by the account, the amount as a fallback.
        if (byApi) await closeByApi(current, order, phone, key);
        else await withPage(() => closeByProfile(contents, current, read.text, [order.account], key, [order.account]));
      } catch (error) {
        if (!/^Trial mode/.test(error.message)) throw error;
        // Paid, and left open on purpose: the operator closes this one by hand.
        mark(order, 'trial');
        audit('trial', key, { serial });
        payAuto = false;
        setStatus('done', `${phone.label} · ${order.amount} · paid, not closed (trial)`);
        return view();
      }
      mark(order, 'done');
      audit('done', key, { serial });
      host.log(`Withdrawal ${order.amount} to ${order.bank} paid from ${phone.label} and closed.`);
      setStatus('done', `${phone.label} · ${order.amount} · ${order.bank}`);
      return view();
    } catch (error) {
      if (begun && !closing && NAME_UNSURE_RE.test(error.message)) {
        // The names could not be compared, and nothing was confirmed: no money moved. The row is
        // left for the operator and never begun again; the phone goes on, entering its app afresh.
        mark(order, 'name', { detail: error.message });
        audit('name', key, { serial, message: error.message });
        host.log(`Withdrawal ${order.amount} to ${order.bank} was passed over on ${phone.label}: ${error.message}`, 'error');
        if (host.notify) host.notify(`${phone.label}: ข้ามรายการ ${order.amount} เทียบชื่อบัญชีไม่ได้ เงินยังไม่ออก`);
      } else if (begun) {
        mark(order, 'failed', { detail: error.message });
        audit('error', key, { serial, message: error.message });
        // The phone did its part when the fault is in closing: that is the page's fault, and every phone's.
        if (closing) halt(key, error.message);
        else stopPhone(serial, key, error.message);
      }
      setStatus('error', `${phone.label}: ${error.message}`);
      throw error;
    } finally {
      paying.delete(serial);
      await readOrders(false).catch(() => {});
      // Read the shop's balances again now the job is done, so the next job starts from the real
      // figure, not the one lowered by hand above. By request in link mode, off the page otherwise.
      if (apiReadable(config())) await readApiAccounts(true).catch(() => {});
      else await readAccounts(true).catch(() => {});
      syncPhones();
      publish();
    }
  }

  /** Each turn: bring the list up to date, and in automatic mode give every free phone a row to pay. */
  async function payTick() {
    if (working || auto || recording) return;
    const current = config();
    // With reading by request set up, the turn runs without a back-office window.
    if (!window && !apiReadable(current)) return;
    try {
      const before = JSON.stringify(orders);
      // With the watch switched off the page is only read, never searched or moved.
      await readOrders((window ? current.watch : true) && !host.busy());
      const known = JSON.stringify(accounts);
      // A phone that has just come online is checked now, not when the accounts are next due.
      if (host.watched().some(checking)) {
        lastAccounts = 0;
        lastApiAccounts = 0;
      }
      if (window) await readAccounts().catch((error) => { accounts = { at: Date.now(), note: 'error', map: {}, error: error.message }; });
      else await readApiAccounts().catch((error) => { accounts = { at: Date.now(), note: 'error', map: accounts.map, error: error.message }; });
      if (JSON.stringify(orders) !== before || JSON.stringify(accounts) !== known) publish();
      syncPhones();
      checkFunds();
      if (host.busy()) return;
      let began = 0;
      if (payAuto && !halted() && orders.note === 'ok') {
        // The row asked for first is paid first. A row no phone can take now does not hold up the next.
        for (const order of logic.oldestFirst(orders.list)) {
          if (ledger[order.key] || [...paying.values()].some((each) => each.key === order.key)) continue;
          if (!phoneFor(order, true)) continue;
          // Not waited for: the phones pay side by side. A fault stops its own phone.
          pay(order.key).catch(() => {});
          began += 1;
        }
      }
      // A phone left waiting too long with nothing to pay is put to rest.
      if (!began) await restTick();
    } catch (error) {
      // Reading the page failed: say so, and try again next turn. Nothing was paid.
      orders = { at: Date.now(), note: 'ok', list: [], error: error.message };
      publish();
    }
  }

  /**
   * The operator has dealt with a row that did not finish: closed it by hand, or found that no
   * money moved. It stays in the ledger, so it is still never begun again, but no longer shows as
   * a fault.
   */
  function resolve(key, note) {
    const entry = ledger[key];
    if (!entry) throw new Error('That row is not in the history.');
    if (entry.state === 'done' || entry.state === 'resolved') return view();
    mark({ key, account: entry.account, amount: entry.amount, bank: entry.bank, requested: entry.requested }, 'resolved', { was: entry.state, note: String(note || '').trim().slice(0, 200) });
    audit('resolved', key, { was: entry.state, message: String(note || '').trim().slice(0, 200) });
    publish();
    return view();
  }

  function setPayAuto(on) {
    if (on) {
      // Paying needs a back-office window, unless reading and closing by request are set up.
      if (!window && !apiReadable(config())) throw new Error('Open the back office and sign in first.');
      if (halted()) throw new Error('Withdrawals are stopped. Check the row in red, then reset the stop.');
      if (config().closeDry) throw new Error('Turn trial mode off before automatic mode: a trial pays a row and leaves it open.');
      if (!host.store.state.workflows[config().workflow]) throw new Error('Choose a saved workflow for paying first.');
      payAuto = true;
      audit('auto', '', { on: true });
      host.log('Withdrawals: automatic mode on.');
      payTick();
    } else {
      payAuto = false;
      audit('auto', '', { on: false });
      host.log('Withdrawals: automatic mode off.');
    }
    publish();
    return view();
  }

  async function refreshOrders() {
    if (working) return view();
    // While a phone pays, the turn of the clock keeps the list up to date; it is not searched out of turn.
    if (paying.size) {
      await readOrders(false);
      publish();
      return view();
    }
    lastSearch = 0;
    await readOrders(true);
    lastAccounts = 0;
    await readAccounts().catch((error) => { accounts = { at: Date.now(), note: 'error', map: {}, error: error.message }; });
    syncPhones();
    checkFunds();
    publish();
    return view();
  }

  function startWatching() {
    clearInterval(payTimer);
    payTimer = setInterval(payTick, Math.max(MIN_SEARCH_MS, config().interval * 1000));
  }

  function stopWatching() {
    closeAccounts();
    clearInterval(payTimer);
    payTimer = null;
    payAuto = false;
    orders = { at: Date.now(), note: 'closed', list: [] };
  }

  async function tick() {
    // A fleet job started by hand has the phones; try again on the next tick.
    if (working || !auto || host.busy()) return;
    working = true;
    try {
      await handle(false);
    } catch (error) {
      // Anything unexpected ends automatic mode: a wrong run is worse than a late one.
      stopAuto();
      // After a fault nobody knows which screen a phone is on; the next job enters the app afresh.
      lastGood.clear();
      host.log(`Web jobs stopped: ${error.message}`, 'error');
      setStatus('error', error.message);
    } finally {
      working = false;
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(tick, config().interval * 1000);
  }

  function stopAuto() {
    auto = false;
    clearInterval(timer);
    timer = null;
  }

  function setAuto(on) {
    if (on) {
      requireWindow();
      if (recording) throw new Error('Stop recording first.');
      auto = true;
      schedule();
      host.log('Web jobs: automatic mode on.');
      setStatus('waiting');
      tick();
    } else {
      stopAuto();
      host.log('Web jobs: automatic mode off.');
      setStatus('idle');
    }
    return view();
  }

  async function runOnce() {
    if (working) throw new Error('A web job is already running.');
    working = true;
    try {
      await handle(true);
    } catch (error) {
      lastGood.clear();
      setStatus('error', error.message);
      throw error;
    } finally {
      working = false;
    }
    return view();
  }

  /** What the app can read on the job phone right now, for setting the check up. */
  async function screen() {
    const current = config();
    const [serial] = target(current);
    // For a try-out, the newest picture of the last day stands in for a slip.
    const seen = current.source === 'gallery'
      ? await host.readSlip(serial, (await host.phoneClock(serial)) - 86400)
      : await host.readScreen(serial);
    return { ...seen, slip: logic.parseSlip(seen.text), values: window ? await read().catch(() => []) : [] };
  }

  function close() {
    recording = null;
    stopAuto();
    if (window) window.destroy();
  }

  /** The picture of the slip kept for a row, as a file path; '' when there is none. */
  function slipFile(key) {
    return ledger[key] ? slipOf(ledger[key]) : '';
  }

  /**
   * Rows of the whole history, newest first: `text` is looked for in the account number, the
   * account's name, the bank and the amount; `state` is a row's state; `day` is YYYY-MM-DD by
   * this computer's clock. At most 500 come back.
   *
   * With `page` (from 1) it answers one page of `size` rows instead, with how many rows there are
   * in all and, for the same words and day whatever the state, how many rows and how much money
   * each state has: { rows, total, page, pages, tally: { done: { count, sum } } }.
   */
  function search({ text, state, day, page, size } = {}) {
    const wanted = String(text || '').trim().toLowerCase();
    const digits = wanted.replace(/[\s,-]/g, '');
    const local = (at) => {
      const date = new Date(at);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    };
    if (page !== undefined) {
      const matches = ([, entry]) => !wanted || [entry.holder, entry.bank, entry.phone].some((field) => String(field || '').toLowerCase().includes(wanted))
        || (digits && [entry.account, String(entry.amount).replace(/,/g, '')].some((field) => String(field || '').includes(digits)));
      const ofDay = Object.entries(ledger).filter(([, entry]) => !day || local(entry.at) === day).filter(matches);
      const tally = {};
      for (const [, entry] of ofDay) {
        const one = tally[entry.state] || (tally[entry.state] = { count: 0, sum: 0 });
        one.count += 1;
        one.sum += Number(entry.amount) || 0;
      }
      const found = ofDay.filter(([, entry]) => !state || entry.state === state).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
      const each = Math.min(200, Math.max(1, Math.round(size) || 20));
      const pages = Math.max(1, Math.ceil(found.length / each));
      const at = Math.min(pages, Math.max(1, Math.round(page) || 1));
      return {
        rows: found.slice((at - 1) * each, at * each).map(([key, entry]) => ({ key, ...entry, slip: slipOf(entry), bankCode: logic.bankCode(entry.bank) })),
        total: found.length, page: at, pages, tally,
      };
    }
    return Object.entries(ledger)
      .filter(([, entry]) => (!state || entry.state === state) && (!day || local(entry.at) === day))
      .filter(([, entry]) => !wanted || [entry.holder, entry.bank, entry.phone].some((field) => String(field || '').toLowerCase().includes(wanted))
        || (digits && [entry.account, String(entry.amount).replace(/,/g, '')].some((field) => String(field || '').includes(digits))))
      .map(([key, entry]) => ({ key, ...entry, slip: slipOf(entry), bankCode: logic.bankCode(entry.bank) }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 500);
  }

  return { view, save, setApiToken, open, pick, record, clear, read, runOnce, setAuto, screen, close, refreshOrders, pay, setPayAuto, unhalt, resolve, switchAccount, signedIn, slipFile, search };
}

module.exports = { createJobs };
