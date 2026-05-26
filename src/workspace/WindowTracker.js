import { execFile, spawn } from 'child_process';
import { setTimeout as wait } from 'timers/promises';
import path from 'path';
import fs from 'fs';

function toFiniteInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/**
 * @typedef {import('./SnapshotManager').AppWindowSnapshot} AppWindowSnapshot
 */

/**
 * @typedef {Object} RunningWindowInfo
 * @property {number} pid
 * @property {string} processName
 * @property {string} executablePath
 * @property {string} windowTitle
 * @property {{x:number,y:number,width:number,height:number}} bounds
 */

export class WindowTracker {
  /**
   * @returns {RunningWindowInfo[]}
   */
  getRunningWindows() {
    // This method is async under the hood; kept sync-shaped for callers by throwing if used directly.
    // Use getRunningWindowsAsync() instead.
    throw new Error('Use getRunningWindowsAsync()');
  }

  /**
   * Windows-first: enumerate top-level windows via PowerShell + user32.dll.
   * @returns {Promise<(RunningWindowInfo & { hwnd: number })[]>}
   */
  async getRunningWindowsAsync() {
    if (process.platform !== 'win32') {
      console.warn('[WindowTracker] Non-Windows platform: window enumeration stubbed');
      return [];
    }

    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  // Extended window styles — needed to filter tool/overlay windows.
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
  public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
  public static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
  public static long GetWindowLong(IntPtr hWnd, int nIndex) {
    if (IntPtr.Size == 8) return GetWindowLongPtr64(hWnd, nIndex).ToInt64();
    return (long)GetWindowLong32(hWnd, nIndex);
  }

  // DwmGetWindowAttribute — needed to detect "cloaked" windows (UWP host
  // frames like ApplicationFrameHost that pass IsWindowVisible but the user
  // can't actually see them).
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

  // Process APIs for accurate executable path resolution
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool QueryFullProcessImageName(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref uint lpdwSize);
}
"@

# Win32 constants
$GWL_EXSTYLE      = -20
$WS_EX_TOOLWINDOW = 0x00000080
$WS_EX_APPWINDOW  = 0x00040000
$DWMWA_CLOAKED    = 14

# Processes that have visible top-level windows but aren't real user apps:
# UWP host frames, IME/input hosts, audio/GPU tray overlays, shell helpers.
# Lowercase, matched against the process name (sans .exe).
$blocklist = @(
  'applicationframehost', 'textinputhost', 'systemsettings',
  'startmenuexperiencehost', 'shellexperiencehost', 'searchhost',
  'searchui', 'lockapp', 'runtimebroker', 'sechealthui',
  'widgetservice', 'crashhandler', 'crashpad_handler',
  'nvidia overlay', 'nahimic3', 'logioptionsplus_agent'
)

$results = New-Object System.Collections.Generic.List[Object]
$seenPids = New-Object System.Collections.Generic.HashSet[uint32]
[Win32]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [Win32]::IsWindowVisible($hWnd)) { return $true }

  # Cloaked check: DWM marks UWP host frames as cloaked. IsWindowVisible
  # returns true for them but the user never sees them. Excluding catches
  # ApplicationFrameHost, TextInputHost, and similar invisible parents.
  [int]$cloaked = 0
  [void][Win32]::DwmGetWindowAttribute($hWnd, $DWMWA_CLOAKED, [ref]$cloaked, 4)
  if ($cloaked -ne 0) { return $true }

  # Tool-window check: WS_EX_TOOLWINDOW means "floating utility, not for
  # alt-tab" — overlays, tray menus, NVIDIA HUD, etc. Skip unless the window
  # also sets WS_EX_APPWINDOW (rare but explicit "I am a real app" opt-in).
  $ex = [Win32]::GetWindowLong($hWnd, $GWL_EXSTYLE)
  if ((($ex -band $WS_EX_TOOLWINDOW) -ne 0) -and (($ex -band $WS_EX_APPWINDOW) -eq 0)) {
    return $true
  }

  $len = [Win32]::GetWindowTextLength($hWnd)
  if ($len -le 0) { return $true }

  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [void][Win32]::GetWindowText($hWnd, $sb, $sb.Capacity)
  $title = $sb.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }

  # Get the real PID for this window
  [uint32]$pidOut = 0
  [void][Win32]::GetWindowThreadProcessId($hWnd, [ref]$pidOut)
  if ($pidOut -eq 0) { return $true }

  # Deduplicate by PID – one entry per process
  if ($seenPids.Contains($pidOut)) { return $true }
  [void]$seenPids.Add($pidOut)

  $rect = New-Object Win32+RECT
  [void][Win32]::GetWindowRect($hWnd, [ref]$rect)

  # Skip windows that are absurdly small — likely off-screen helpers, not real
  # alt-tab apps (real apps render at least a captionbar's worth of pixels).
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -lt 100 -or $h -lt 80) { return $true }

  $exePath = $null
  $pname = $null

  # First try QueryFullProcessImageName via OpenProcess
  $PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
  $hProcess = [Win32]::OpenProcess($PROCESS_QUERY_LIMITED_INFORMATION, $false, $pidOut)
  if ($hProcess -ne [IntPtr]::Zero) {
    $capacity = 1024
    $sbExe = New-Object System.Text.StringBuilder($capacity)
    [uint32]$lenExe = $capacity
    $ok = [Win32]::QueryFullProcessImageName($hProcess, 0, $sbExe, [ref]$lenExe)
    [void][Win32]::CloseHandle($hProcess)
    if ($ok) {
      $exePath = $sbExe.ToString()
    }
  }

  # Fallback to Get-Process if needed
  if (-not $exePath) {
    $proc = Get-Process -Id $pidOut -ErrorAction SilentlyContinue
    if ($proc) { $exePath = $proc.Path }
  }

  if ($exePath) {
    $pname = [System.IO.Path]::GetFileNameWithoutExtension($exePath)
  }

  # Skip processes we don't want to track
  if (-not $exePath) { return $true }
  $lowerExe = $exePath.ToLowerInvariant()
  $lowerName = if ($pname) { $pname.ToLowerInvariant() } else { '' }

  # Skip this Electron app and dev tooling:
  if ($lowerExe -like '*\\node.exe' -or
      $lowerExe -like '*\\electron.exe' -or
      $lowerExe -like '*\\dockshift.exe') {
    return $true
  }

  # Skip powershell hosts (dev shell); adjust later if you want to include real terminals
  if ($lowerExe -like '*\\powershell.exe' -or
      $lowerExe -like '*\\pwsh.exe') {
    return $true
  }

  # Process name blocklist for well-known background hosts that slip past
  # the cloaked/tool-window filters above (some shell helpers fly under both).
  if ($blocklist -contains $lowerName) { return $true }

  $results.Add([pscustomobject]@{
    hwnd = $hWnd.ToInt64()
    pid = [int]$pidOut
    processName = $pname
    executablePath = $exePath
    windowTitle = $title
    bounds = [pscustomobject]@{
      x = $rect.Left
      y = $rect.Top
      width = $w
      height = $h
    }
  }) | Out-Null
  return $true
}, [IntPtr]::Zero) | Out-Null

$results | ConvertTo-Json -Depth 6 -Compress
`;

    const raw = await this.execPowerShell(psScript);
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .filter(Boolean)
        .map((w) => ({
          hwnd: Number(w.hwnd),
          pid: Number(w.pid),
          processName: w.processName || '',
          executablePath: w.executablePath || '',
          windowTitle: w.windowTitle || '',
          bounds: {
            x: Number(w.bounds?.x ?? 0),
            y: Number(w.bounds?.y ?? 0),
            width: Number(w.bounds?.width ?? 0),
            height: Number(w.bounds?.height ?? 0),
          },
        }))
        .filter((w) => w.executablePath);
    } catch (err) {
      console.warn('[WindowTracker] Failed to parse PowerShell JSON', err, raw);
      return [];
    }
  }

  /**
   * @returns {AppWindowSnapshot[]}
   */
  captureAppSnapshots() {
    throw new Error('Use captureAppSnapshotsAsync()');
  }

  /**
   * @returns {Promise<AppWindowSnapshot[]>}
   */
  async captureAppSnapshotsAsync() {
    const running = await this.getRunningWindowsAsync();
    const snapshots = running.map((r) => ({
      pid: r.pid,
      processName: r.processName,
      executablePath: r.executablePath,
      launchArgs: [],
      windowTitle: r.windowTitle,
      bounds: r.bounds,
    }));

    return snapshots;
  }

  /**
   * Restore apps from snapshots.
   * Only launches apps that are not already running with a matching executable path.
   * @param {AppWindowSnapshot[]} snapshots
   */
  async restoreFromSnapshots(snapshots) {
    const current = await this.getRunningWindowsAsync();
    /** @type {Map<string, RunningWindowInfo[]>} */
    const currentByExe = new Map();

    for (const win of current) {
      const key = win.executablePath.toLowerCase();
      if (!currentByExe.has(key)) currentByExe.set(key, []);
      currentByExe.get(key).push(win);
    }

    for (const snap of snapshots) {
      if (!snap.executablePath) {
        console.warn('[WindowTracker] Missing executablePath for snapshot; skipping', snap);
        continue;
      }

      const key = snap.executablePath.toLowerCase();
      const alreadyRunning = currentByExe.get(key);

      if (alreadyRunning && alreadyRunning.length > 0) {
        const target = alreadyRunning[0];
        // eslint-disable-next-line no-await-in-loop
        await this.setWindowBoundsByPid(target.pid, snap.bounds);
        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        await this.launchAndPositionApp(snap);
      } catch (err) {
        console.error('[WindowTracker] Failed to launch app from snapshot', snap, err);
      }
    }
  }

  /**
   * @param {number} pid
   * @param {{x:number,y:number,width:number,height:number}} bounds
   */
  async setWindowBoundsByPid(pid, bounds) {
    if (process.platform !== 'win32') return;
    const windows = await this.getRunningWindowsAsync();
    const match = windows.find((w) => w.pid === pid);
    if (!match) return;
    await this.setWindowBoundsByHwnd(match.hwnd, bounds);
  }

  /**
   * @param {number} hwnd
   * @param {{x:number,y:number,width:number,height:number}} bounds
   */
  async setWindowBoundsByHwnd(hwnd, bounds) {
    if (process.platform !== 'win32') return;
    // Every value is interpolated into a PowerShell here-string. Coerce to
    // integers first — anything non-finite is rejected so a tampered snapshot
    // JSON (e.g. bounds.x = "0; Start-Process calc.exe") cannot inject script.
    const h = toFiniteInt(hwnd);
    const x = toFiniteInt(bounds?.x);
    const y = toFiniteInt(bounds?.y);
    const w = toFiniteInt(bounds?.width);
    const ht = toFiniteInt(bounds?.height);
    if (h === null || x === null || y === null || w === null || ht === null) {
      console.warn('[WindowTracker] Rejecting setWindowBoundsByHwnd: non-numeric input', { hwnd, bounds });
      return;
    }
    const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Move {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@

$HWND = [IntPtr]${h}
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
[void][Win32Move]::SetWindowPos($HWND, [IntPtr]::Zero, ${x}, ${y}, ${w}, ${ht}, ($SWP_NOZORDER -bor $SWP_NOACTIVATE))
`;
    await this.execPowerShell(psScript);
  }

  /**
   * @param {AppWindowSnapshot} snap
   */
  async launchAndPositionApp(snap) {
    // Snapshots are user-writable JSON in userData/workspaces. Validate the
    // exe path and args before spawn so a tampered snapshot cannot pivot us
    // into launching cmd.exe / powershell.exe with attacker-chosen argv.
    const exe = snap.executablePath;
    if (typeof exe !== 'string' || !path.isAbsolute(exe) || exe.includes('..')) {
      throw new Error(`Refusing to launch: invalid executablePath ${JSON.stringify(exe)}`);
    }
    if (!/\.exe$/i.test(exe)) {
      throw new Error(`Refusing to launch non-.exe target ${JSON.stringify(exe)}`);
    }
    if (!fs.existsSync(exe)) {
      throw new Error(`Refusing to launch: executable not found ${JSON.stringify(exe)}`);
    }
    const args = Array.isArray(snap.launchArgs) ? snap.launchArgs : [];
    if (args.length > 32 || !args.every((a) => typeof a === 'string' && a.length < 4096)) {
      throw new Error('Refusing to launch: invalid launchArgs');
    }

    const child = spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    const maxWaitMs = 15000;
    const pollIntervalMs = 500;
    const start = Date.now();

    // Wait for a window whose executable path matches
    while (Date.now() - start < maxWaitMs) {
      // eslint-disable-next-line no-await-in-loop
      const windows = await this.getRunningWindowsAsync();
      const match = windows.find(
        (w) => w.executablePath.toLowerCase() === snap.executablePath.toLowerCase()
      );
      if (match) {
        // eslint-disable-next-line no-await-in-loop
        await this.setWindowBoundsByHwnd(match.hwnd, snap.bounds);
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await wait(pollIntervalMs);
    }

    console.warn(
      '[WindowTracker] Timed out waiting for window for',
      snap.executablePath
    );
  }

  /**
   * @param {string} script
   * @returns {Promise<string>}
   */
  execPowerShell(script) {
    return new Promise((resolve, reject) => {
      // `timeout` makes execFile kill the child and call back with an error if
      // PowerShell hangs (e.g. enumerating a huge number of windows), so a
      // workspace save/restore can never block the UI indefinitely.
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        {
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 20000,
          killSignal: 'SIGKILL',
        },
        (err, stdout, stderr) => {
          if (err) {
            if (err.killed || err.signal) {
              console.warn('[WindowTracker] PowerShell timed out and was terminated');
            } else {
              console.warn('[WindowTracker] PowerShell error', err, stderr);
            }
            reject(err);
            return;
          }
          resolve(String(stdout || '').trim());
        }
      );
    });
  }
}

