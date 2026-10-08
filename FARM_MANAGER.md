# Farm Manager

Local Phone Farm Manager is a desktop-first controller for real Android phones.
It uses USB ADB by default and avoids cloud dependencies.

## Phase 1

Implemented:

- Scan devices with `adb devices -l`
- Show online/offline/unauthorized status
- Read model, Android version, SDK, battery, charging, and temperature
- Run quick actions: Back, Home, Recent, Wake, Sleep, Reboot
- Send text through ADB input
- Install APK to a selected device
- Take screenshot to the system temp folder
- Open `scrcpy` on demand for manual live control

## Phase 2

Implemented:

- Center thumbnail grid for all discovered devices
- One-click manual thumbnail refresh
- Optional auto refresh, defaulting to every 8 seconds
- Low-overhead screenshot thumbnails instead of full-time streaming
- Click a thumbnail card to select that device
- Per-device thumbnail error state when capture fails

## Phase 3

Implemented:

- Multi-select device list
- Local device groups stored in `farm_manager_devices.json`
- Batch tab for selected online devices
- Batch Back, Home, Recent, Wake, Sleep, Open App, Install APK, and Reboot
- Sequential per-device execution with progress and per-device success/failure logs

## Phase 4

Implemented:

- Optional auto scan for ADB devices
- One-shot ADB server restart when a scan fails
- Persistent device name, group, and slot mapping
- Local SQLite event log in `farm_manager_events.sqlite3`
- Battery and temperature health warnings
- Device discovered, disappeared, and status-change logging

## Phase 5

Implemented:

- Policy tab for app package rules
- Detect current foreground package from a selected device
- Package modes: assisted allowed, manual only, and blocked/protected
- Optional screenshot/thumbnail blocking per package
- Batch actions check current app policy before running
- Screenshots, thumbnails, and scrcpy respect package capture policy

## Phase 6

Implemented:

- Workflow preset tab with saved local workflows
- Default presets: `Wake Home` and `Settings Screenshot`
- Explicit user-run only through `Run Selected`
- Supported steps: `wait`, `keyevent`, `open`, `text`, `screenshot`, `back`, `home`, `recent`, `wake`, `sleep`
- Sequential execution per selected online device with progress and logs
- Workflow steps respect app policy before ADB input or capture

Example workflow:

```text
wake
wait 500
home
wait 500
screenshot
```

## Phase 7

Implemented:

- Minimal light theme with cleaner spacing and typography
- Compact header with fleet status and version
- Status-colored device rows
- Cleaner thumbnail cards with selected state
- More readable log and workflow editors
- Footer keeps long ADB path out of the main toolbar

## Phase 8

Implemented:

- Live tab for `scrcpy` control
- `scrcpy.exe` locate flow with saved local config
- Live status and selected profile preview
- Profiles: `Low bandwidth`, `Balanced`, and `Quality`
- `Open Live` action uses selected profile
- Live control respects app screenshot/capture policy

## Phase 9

Implemented:

- Setup tab for onboarding real devices
- Read-only diagnostics for selected online device
- Optional setup actions: stay awake while charging, disable animations, screen timeout, brightness, and wake
- Apply setup to selected online devices with progress and logs
- Setup actions only run after explicit user confirmation

## Phase 10

Implemented:

- Apps tab for the selected online device
- User app package list with optional system package toggle
- Search/filter packages locally
- Package details from `dumpsys package`
- Open selected package
- Install APK from the Apps tab
- Clear app data and uninstall with explicit confirmation prompts

## Phase 11

Implemented:

- Wider default window and stable three-pane layout
- Compact Inspector tab labels to avoid cramped text
- Better `scrcpy` missing flow that can open Locate immediately
- Selected-device thumbnail refresh
- Thumbnail updated-at time in each card
- Double-click thumbnail card to open live control

## Phase 12

Implemented:

- Live session status inside the Live tab
- Refresh live session state and prune closed `scrcpy` processes
- Close live session for the selected device
- Close all live sessions from the app
- Live status updates after open, close, and launch failure
- Local `scrcpy` setup verified with `scrcpy 3.3.4` on this Windows PC

## Phase 13

Implemented:

- APK tab for multi-device app management
- Local APK library folder at `apk-library`
- Library scan and selected APK install to selected online devices
- Choose any APK file and install it to selected online devices
- Compare package version across selected online devices
- Batch clear app data with confirmation
- Batch uninstall with confirmation

## Phase 14

Implemented:

- Live profile defaults per selected device
- Live profile defaults per selected group
- Open selected online devices with their default live profiles
- Reopen the last live device set
- Live watchdog to prune closed `scrcpy` sessions from the UI
- Persist last live set and watchdog preference in config
- Low, Balanced, and Quality profiles now use their built-in settings unless custom overrides are explicitly enabled

## Phase 15

Implemented:

- Workflow import/export as JSON
- Workflow preview without running commands
- Dry-run workflow mode that does not send ADB commands
- Per-step confirmation mode before each workflow action
- Persist workflow dry-run and confirmation preferences in config

## Phase 16

Implemented:

- Node identity with persistent node name and node ID
- Node tab for local multi-node preparation
- Local backup archive creation in `backups`
- Restore config and device state from a backup archive
- Export node inventory snapshots to `node-snapshots`
- View node snapshot files from another controller
- Backup archives and snapshot exports are ignored by git

## Phase 17

Implemented:

- Larger default window and clearer minimum layout size
- Inspector navigation changed from crowded horizontal tabs to a compact view selector
- Inspector views now use the full right pane width
- Better initial pane sizing for Devices, Grid, and Inspector
- Device table columns tightened so the important fields fit better
- Slightly cleaner typography and spacing for section headers

## Phase 18

Implemented:

- Dashboard view in the Inspector
- Add the current node snapshot to a local dashboard
- Import node snapshot JSON files from other controllers
- View multiple node snapshots in one screen
- Compare online/total device counts across snapshots
- Show duplicate serials seen in multiple snapshots
- Dashboard imports are stored in `dashboard` and ignored by git

## Phase 19

Implemented:

- Dark theme with amber accent
- Left navigation rail grouped by scope: Device, Fleet, System
- Header fleet counters for online, inactive, and total devices
- Inspector title and one-line hint for the current view
- Danger styling for Reboot, Clear Data, Uninstall, Delete, and Restore
- Primary styling for Refresh and workflow Run

## Phase 20

Implemented:

- Dark and light themes, switched from the header and saved as `theme` in config
- Rounded card layout for the header, Devices pane, and Inspector pane
- Devices pane merges the old device table and Live Grid: `Cards` or `List` view, saved as `device_view`
- Device cards show name, status badge, serial, screen thumbnail, group, and battery
- Ctrl+click a card to add or remove it from the selection
- Header status line with online and inactive counts and last scan time
- Rare actions moved to the `More` menu: refresh selected screen, restart ADB, config folder, event log

## Setup

1. Install Android platform-tools and make sure `adb` is available in `PATH`.
   This repo also auto-detects `tools/android-sdk/platform-tools/adb.exe`
   when that bundled SDK folder exists.
2. Optional: install `scrcpy` and make sure it is available in `PATH`.
   The app also auto-detects `tools/scrcpy/scrcpy.exe`, or you can select
   `scrcpy.exe` from the Live tab with the Locate button.
   On this machine, `farm_manager_config.json` points to
   `tools/scrcpy-v3.3.4/scrcpy.exe` because `scrcpy 4.0` connected to the
   phone but crashed during rendering.
3. Enable Developer options and USB debugging on each phone.
4. Connect phones through a powered USB hub.
5. Run:

```powershell
cd farm-phone-manager
py -3 farm_manager.py
```

Run a non-GUI tool check:

```powershell
py -3 farm_manager.py --check
```

If `adb` or `scrcpy` is not in `PATH`, copy `farm_manager_config.example.json`
to `farm_manager_config.json` and set absolute paths:

```json
{
  "node_id": "",
  "node_name": "Local Node",
  "adb_path": "C:\\Android\\platform-tools\\adb.exe",
  "scrcpy_path": "C:\\scrcpy\\scrcpy.exe",
  "apk_library_dir": "C:\\FarmManager\\apk-library",
  "auto_scan_enabled": false,
  "auto_scan_interval_seconds": 15,
  "auto_restart_adb": true,
  "thumbnail_interval_seconds": 8,
  "low_battery_percent": 20,
  "high_temp_c": 42.0,
  "live_watchdog_enabled": true,
  "last_live_serials": [],
  "scrcpy_override_profiles": false,
  "workflow_confirm_each_step": false,
  "workflow_dry_run": false
}
```

## Recommended Hardware

- Powered USB hub with enough current for all devices
- Short, reliable USB data cables
- Cooling fan or open rack spacing
- Windows PC or mini PC with stable USB ports

## Roadmap

### Phase 19 - Local Network Dashboard

- Central local dashboard
- Local network only by default
- Optional local API for trusted controller nodes
- Read-only web dashboard for snapshot status

## Electron app (v0.19)

The UI is being rebuilt on Electron in `app/`. The Python app (`farm_manager.py`) still works and reads the same
`farm_manager_config.json` and `farm_manager_devices.json`.

```powershell
npm install
npm start
npm test
```

- `app/main.js`: window, IPC, scanning, fleet jobs, scrcpy sessions
- `app/core/`: ADB client, JSON store, and pure parsing/policy/workflow logic (covered by `test/`)
- `app/ui/`: renderer (plain HTML/CSS/JS), dark and light themes, bundled Sarabun font (OFL)

Ported: devices (cards/table, multi-select), device info, actions on all selected devices, live control,
apps, APK library, workflows, app policy, log, settings.

Not ported yet: Setup tab, node backup/restore, node snapshots and dashboard, workflow import/export,
workflow dry-run and confirm-each-step, package version compare.

Changes from the Python app: events go to `farm_manager_events.jsonl` instead of SQLite, screenshots go to
`captures/` instead of the temp folder, fleet jobs run on up to 4 devices in parallel, and package names,
key codes, and typed text are validated or quoted before they reach `adb shell`.

## Updates (v0.20)

The app checks for an update when it starts and then once every 24 hours (it polls hourly and runs a check when
24 hours have passed since the last completed one). An update is a signed bundle of the `app/` folder. The app
downloads it, verifies the Ed25519 signature against `app/update-public.pem`, unpacks it under
`installed-updates/` in the data folder, shows a Windows notification plus a button in the header, and starts
using it after a restart. `app/boot.js` falls back to the installed copy if an update fails to load.

Setup, once:

1. Put the HTTPS address that will serve the `updates/` folder in `package.json` as `"updateUrl"`. It must end
   with `/`. For a public GitHub repo: `https://raw.githubusercontent.com/<owner>/<repo>/main/updates/`.
2. Keep `update-private.pem` secret and backed up. It is git-ignored. Anyone who has it can ship code to every
   installed copy; if it is lost, installed copies can no longer be updated.

Release:

```powershell
node tools/release.js 0.20.1
```

This writes `updates/app-0.20.1.bin` and `updates/latest.json` and bumps `package.json`. Publish the `updates/`
folder at the update URL.

Updates replace app code only. A new Electron version, or a change to `package.json` itself, needs a new
installer.

The logo source is `app/ui/logo.svg`. `npm run icons` renders `build/icon.ico` and `app/assets/icon.png` from it.
