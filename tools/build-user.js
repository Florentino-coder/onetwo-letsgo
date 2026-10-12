'use strict';

// Owner-only tool. Builds the Windows installer of OneTwo ADB, the program handed to other people:
//   node tools/build-user.js
// The installer brings everything a fresh computer needs: the program without the studio's
// window, ADB, the text reader (Tesseract) with Thai, and the work pack in app/packs/ when there
// is one. Nothing of the owner's data goes in: no settings, no PIN, no history, no private key.
const fs = require('node:fs');
const path = require('node:path');
const { LEFT_OUT } = require('./release-user.js');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, 'dist');
const stage = path.join(out, 'user-stage');
const tools = path.join(out, 'user-tools');

function copyApp(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) copyApp(rel);
    // The pack that comes with the program is the one thing under app/packs/ that does go in.
    else if (!LEFT_OUT.some((pattern) => pattern.test(rel)) || rel === 'app/packs/default.onetwopack') {
      fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
      fs.copyFileSync(path.join(root, rel), path.join(stage, rel));
    }
  }
}

/** Where ADB is on this computer: the studio's own setting first, then the usual places. */
function findAdb() {
  const candidates = [];
  try {
    candidates.push(JSON.parse(fs.readFileSync(path.join(root, 'farm_manager_config.json'), 'utf8')).adb_path);
  } catch {
    // No settings here.
  }
  for (const env of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) if (process.env[env]) candidates.push(path.join(process.env[env], 'platform-tools', 'adb.exe'));
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
  return candidates.find((file) => file && fs.existsSync(file)) || null;
}

function findTesseract() {
  const folders = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
  return folders.filter(Boolean).map((folder) => path.join(folder, 'Tesseract-OCR')).find((folder) => fs.existsSync(path.join(folder, 'tesseract.exe'))) || null;
}

function copyTools() {
  const adb = findAdb();
  if (!adb) throw new Error('ADB was not found on this computer. Set its location in the studio\'s Settings first.');
  fs.mkdirSync(path.join(tools, 'adb'), { recursive: true });
  for (const name of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'NOTICE.txt']) {
    const from = path.join(path.dirname(adb), name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(tools, 'adb', name));
    else if (name !== 'NOTICE.txt') throw new Error(`${name} is missing beside adb.exe.`);
  }
  const tesseract = findTesseract();
  if (!tesseract) throw new Error('Tesseract OCR was not found on this computer. The program cannot read slips without it.');
  fs.mkdirSync(path.join(tools, 'tesseract', 'tessdata'), { recursive: true });
  // The reader itself and the libraries it loads; not the training tools nor their manuals.
  for (const name of fs.readdirSync(tesseract)) {
    if (name === 'tesseract.exe' || /\.dll$/i.test(name)) fs.copyFileSync(path.join(tesseract, name), path.join(tools, 'tesseract', name));
  }
  for (const language of ['tha', 'eng']) {
    const from = path.join(tesseract, 'tessdata', `${language}.traineddata`);
    if (!fs.existsSync(from)) throw new Error(`Tesseract on this computer has no ${language}.traineddata.`);
    fs.copyFileSync(from, path.join(tools, 'tesseract', 'tessdata', `${language}.traineddata`));
  }
}

async function main() {
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(tools, { recursive: true, force: true });
  copyApp('app');
  copyTools();
  const hasPack = fs.existsSync(path.join(stage, 'app', 'packs', 'default.onetwopack'));
  fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify({
    name: 'onetwo-adb',
    productName: 'OneTwo ADB',
    version: pkg.version,
    private: true,
    description: 'OneTwo ADB',
    author: 'Florentino356',
    main: 'app/boot.js',
    edition: 'user',
    userUpdateUrl: pkg.userUpdateUrl || '',
  }, null, 2)}\n`);

  const builder = require('electron-builder');
  const made = await builder.build({
    projectDir: stage,
    targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
    config: {
      appId: 'com.onetwoadb.user',
      productName: 'OneTwo ADB',
      copyright: 'Florentino356',
      directories: { output: path.join(out, 'user'), buildResources: path.join(root, 'build') },
      // The Electron already in node_modules is the one the program was tested with.
      electronDist: path.join(root, 'node_modules', 'electron', 'dist'),
      electronVersion: require('electron/package.json').version,
      files: ['app/**/*', 'package.json'],
      extraResources: [{ from: tools, to: 'tools' }],
      asar: false,
      npmRebuild: false,
      win: { icon: path.join(root, 'build', 'icon.ico'), artifactName: 'OneTwo-ADB-Setup-${version}.${ext}' },
      nsis: { oneClick: true, perMachine: false, shortcutName: 'OneTwo ADB', deleteAppDataOnUninstall: false },
      publish: null,
    },
  });
  console.log(`ตัวติดตั้ง: ${made.filter((file) => file.endsWith('.exe')).join(', ')}`);
  console.log(hasPack ? 'มีชุดงานมากับตัวติดตั้ง (app/packs/default.onetwopack)' : 'ไม่มีชุดงานมากับตัวติดตั้ง: ผู้ใช้งานต้องนำเข้าชุดงานเองที่หน้าตั้งค่า');
  if (!pkg.userUpdateUrl) console.log('ยังไม่ได้ตั้ง userUpdateUrl ใน package.json: โปรแกรมนี้จะไม่ตรวจอัปเดตและไม่ตรวจรหัสที่ยกเลิก');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
