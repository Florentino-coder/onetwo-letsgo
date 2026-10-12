'use strict';

// Keeps a short secret, such as a phone's app PIN, so that only this Windows user account can read
// it back. Windows does the encrypting (its Data Protection API), so there is no key file of the
// app's own to lose: the same account reads the secret back after any restart, and no other
// account or computer can.

const childProcess = require('node:child_process');

const MARK = 'dp1:';
const TIMEOUT_MS = 15000;
// Not a secret: it only keeps what this app protects apart from what other programs protect.
const PURPOSE = Buffer.from('adb-onetwo device secret', 'utf8').toString('base64');

// Windows PowerShell 5.1. The value comes in and goes out as base64 on the pipes, so it is never
// part of a command line, which other programs can see.
const script = (direction) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$purpose = [Convert]::FromBase64String('${PURPOSE}')
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${direction}($bytes, $purpose, $scope)))
`;

function windows(direction, bytes) {
  if (process.platform !== 'win32') throw new Error('Keeping a secret needs Windows.');
  const encoded = Buffer.from(script(direction), 'utf16le').toString('base64');
  const out = childProcess.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    input: bytes.toString('base64'), encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  return Buffer.from(out.trim(), 'base64');
}

/** The text, encrypted for this Windows account, as a string to save. Throws when it cannot be read back. */
function protect(text) {
  const kept = MARK + windows('Protect', Buffer.from(String(text), 'utf8')).toString('base64');
  // A secret that cannot be read back is worse than an error now.
  if (reveal(kept) !== String(text)) throw new Error('Windows did not give the secret back unchanged.');
  return kept;
}

/** True for a string made by `protect`. */
const isProtected = (kept) => typeof kept === 'string' && kept.startsWith(MARK);

/** The text of a string made by `protect`. Throws when this account cannot read it. */
function reveal(kept) {
  if (!isProtected(kept)) throw new Error('Not a kept secret.');
  return windows('Unprotect', Buffer.from(kept.slice(MARK.length), 'base64')).toString('utf8');
}

module.exports = { protect, reveal, isProtected };
