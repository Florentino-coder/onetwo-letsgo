'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const logic = require('../app/core/logic.js');
const screen = require('../app/core/screen.js');

// A bank app's page that asks the user to check a transfer, as "uiautomator dump" gives it.
const confirmPage = '<?xml version="1.0"?><hierarchy rotation="0">'
  + '<node text="ตรวจสอบการโอนเงิน" bounds="[242,97][478,136]" />'
  + '<node text="จาก" bounds="[30,374][183,408]" />'
  + '<node text="111-7-xxx222" content-desc="1 1 1 dash 7" bounds="[294,413][479,452]" />'
  + '<node text="9,152.95 THB" bounds="[294,452][465,491]" />'
  + '<node text="ไปที่" bounds="[30,536][183,570]" />'
  + '<node text="นาย ทดสอบ ระบบ" bounds="[294,536][512,575]" />'
  + '<node text="333-0-444555" bounds="[294,575][483,614]" />'
  + '<node text="โปรดตรวจสอบข้อมูลผู้รับเงิน 3330444555 ให้แน่ใจ" bounds="[95,697][690,761]" />'
  + '<node text="1,500.00 THB" bounds="[505,853][677,913]" />'
  + '<node text="0.00 THB" bounds="[219,958][677,990]" />'
  + '<node text="7778889990" bounds="[0,0][0,0]" />'
  + '<node text="ยืนยัน" clickable="true" bounds="[60,1315][660,1391]" />'
  + '</hierarchy>';

test('an account number on the screen is the job\'s whatever dashes the app puts in it', () => {
  assert.equal(screen.showsAccount(confirmPage, '3330444555'), true);
  assert.equal(screen.showsAccount(confirmPage, '333-0-444555'), true);
  // One digit off, a hidden account, and digits inside a sentence are not it.
  assert.equal(screen.showsAccount(confirmPage, '3330444556'), false);
  assert.equal(screen.showsAccount(confirmPage, '1117222'), false);
  assert.equal(screen.showsAccount('<hierarchy><node text="โอนไป 3330444555 แล้ว" bounds="[0,0][9,9]" /></hierarchy>', '3330444555'), false);
  // Something with no size is not on the screen.
  assert.equal(screen.showsAccount(confirmPage, '7778889990'), false);
  assert.equal(screen.showsAccount(confirmPage, '12'), false);
});

test('an amount on the screen is the job\'s whatever commas and currency the app writes', () => {
  assert.equal(screen.showsAmount(confirmPage, '1500'), true);
  assert.equal(screen.showsAmount(confirmPage, '1500.00'), true);
  assert.equal(screen.showsAmount(confirmPage, '1,500.00'), true);
  assert.equal(screen.showsAmount(confirmPage, '1500.50'), false);
  assert.equal(screen.showsAmount(confirmPage, '150'), false);
  assert.equal(screen.showsAmount(confirmPage, '15000'), false);
  // A fee of nothing never stands for an amount.
  assert.equal(screen.showsAmount(confirmPage, '0'), false);
  assert.equal(screen.showsAmount(confirmPage, 'abc'), false);
});

test('the gist of a screen hides its numbers', () => {
  const gist = screen.gist(confirmPage, 4);
  assert.match(gist, /ตรวจสอบการโอนเงิน/);
  assert.doesNotMatch(gist, /\d{3}/);
});

test('steps that read the screen parse, need words, and take a job\'s values', () => {
  const steps = logic.parseWorkflow('waittext ตรวจสอบการโอนเงิน\nchecktext {1}\ncheckamount {2}\nstoptext ไม่สามารถทำรายการได้\nscrolltap {3}');
  assert.deepEqual(steps.map((step) => step.command), ['waittext', 'checktext', 'checkamount', 'stoptext', 'scrolltap']);
  for (const command of ['waittext', 'checktext', 'checkamount', 'stoptext', 'scrolltap']) assert.throws(() => logic.parseWorkflow(command), /expects the words/);
  assert.equal(logic.workflowInputs(steps), 3);
  const filled = logic.expandWorkflow(steps, ['3330444555', '1500.00', 'ธนาคารกสิกรไทย'], {}, {}, '');
  assert.deepEqual(filled.map((step) => step.argument).slice(1, 3), ['3330444555', '1500.00']);
  assert.equal(filled[4].argument, 'ธนาคารกสิกรไทย');
});
