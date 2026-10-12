'use strict';

// Text recognition for phone screenshots, using Tesseract installed on this computer. No picture
// leaves the computer. Thai needs Tesseract's Thai data (tha.traineddata) in its tessdata folder.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TIMEOUT_MS = 30000;
const LANGUAGES = ['tha', 'eng'];
// Where Tesseract is and which of the wanted languages it has; undefined until first looked for.
let tesseract;

function run(file, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split(/\r?\n/)[0]));
      else resolve(stdout);
    });
  });
}

/** Resolves with { file, languages } for the installed Tesseract, or null when there is none. */
async function findTesseract() {
  if (tesseract) return tesseract;
  const folders = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
  const installed = folders.filter(Boolean).map((folder) => path.join(folder, 'Tesseract-OCR', 'tesseract.exe')).find((file) => fs.existsSync(file));
  // An installed copy of the program brings its own reader, with its language data beside it.
  const own = process.resourcesPath ? path.join(process.resourcesPath, 'tools', 'tesseract', 'tesseract.exe') : '';
  const bundled = own && fs.existsSync(own) ? own : '';
  try {
    const file = bundled || installed || 'tesseract';
    const data = bundled ? ['--tessdata-dir', path.join(path.dirname(bundled), 'tessdata')] : [];
    const listed = (await run(file, [...data, '--list-langs'])).split(/\r?\n/).map((line) => line.trim());
    const languages = LANGUAGES.filter((language) => listed.includes(language));
    // Kept only when found, so installing Tesseract while the app is open is picked up.
    if (languages.length) tesseract = { file, languages, data };
  } catch {
    // Not installed.
  }
  return tesseract || null;
}

/** Resolves with the text found in the picture, one line per line of text. */
async function recognize(imagePath) {
  const found = await findTesseract();
  if (!found) throw new Error('Could not read the picture: Tesseract OCR is not installed on this computer.');
  try {
    return (await run(found.file, [imagePath, 'stdout', ...found.data, '-l', found.languages.join('+')])).trim();
  } catch (error) {
    throw new Error(`Could not read the picture: ${error.message}`);
  }
}

module.exports = { recognize };
