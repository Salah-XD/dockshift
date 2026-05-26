import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { HEADER_STYLE, TITLE_STYLE, SCROLL_AREA } from '../hooks/usePanelPosition';
import { useTheme } from '../context/ThemeContext';
import ResizablePanel from './ResizablePanel';
import AiSettings from './AiSettings';
import VoiceSettings from './VoiceSettings';
import {
  Badge,
  Button,
  IconButton,
  Select,
  Switch,
  SegmentedControl,
  SectionGroup,
  SettingRow,
  Keys,
  XIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
} from './ui';
import HotkeyRecorder from './HotkeyRecorder';
import UpdateStatus from './UpdateStatus';

const DEFAULT_TOGGLE_SHORTCUT = 'Control+Shift+D';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: <SunIcon size={13} /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon size={13} /> },
  { value: 'system', label: 'System', icon: <MonitorIcon size={13} /> },
];

const POSITIONS = [
  { value: 'bottom-center', label: 'Bottom Center' },
  { value: 'bottom-right', label: 'Bottom Right' },
  { value: 'bottom-left', label: 'Bottom Left' },
  { value: 'top-center', label: 'Top Center' },
];

const CLIPBOARD_LIMITS = [50, 100, 200, 500].map((n) => ({ value: n, label: String(n) }));

export default function SettingsPanel({ isOpen, onClose, anchorRect }) {
  const [settings, setSettings] = useState({
    dockPosition: 'bottom-center',
    alwaysOnTop: true,
    launchOnStartup: true,
    clipboardMaxItems: 200,
    toggleDockShortcut: DEFAULT_TOGGLE_SHORTCUT,
    analyticsEnabled: false,
  });
  const panelRef = useRef(null);
  const api = useMemo(() => window.electronAPI, []);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    if (!isOpen) return;
    api?.invoke?.('settings:get')?.then((s) => { if (s) setSettings((prev) => ({ ...prev, ...s })); })?.catch(() => {});
  }, [isOpen, api]);

  const update = useCallback((key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      api?.invoke?.('settings:set', { settings: next })?.catch(() => {});
      return next;
    });
  }, [api]);

  if (!isOpen || !anchorRect) return null;

  const panel = (
    <ResizablePanel isOpen={isOpen} dockAction="settings">
      <div style={HEADER_STYLE}>
        <span style={TITLE_STYLE}>Settings</span>
        <IconButton variant="danger" title="Close" onClick={onClose}>
          <XIcon size={14} />
        </IconButton>
      </div>

      <div style={SCROLL_AREA}>
        <SectionGroup title="Appearance">
          <SettingRow
            label="Theme"
            control={<SegmentedControl value={theme} onChange={setTheme} options={THEME_OPTIONS} />}
          />
          <SettingRow
            label="Dock Position"
            control={
              <Select
                value={settings.dockPosition}
                onChange={(v) => update('dockPosition', v)}
                options={POSITIONS}
                style={{ width: 150 }}
              />
            }
          />
          <SettingRow
            label="Always on Top"
            description="Keep the dock above other windows"
            control={
              <Switch
                checked={!!settings.alwaysOnTop}
                onChange={(v) => update('alwaysOnTop', v)}
              />
            }
          />
        </SectionGroup>

        <SectionGroup title="AI & Models">
          <AiSettings settings={settings} update={update} api={api} />
        </SectionGroup>

        <SectionGroup title="Voice to Text">
          <VoiceSettings settings={settings} update={update} api={api} />
        </SectionGroup>

        <SectionGroup title="System">
          <SettingRow
            label="Launch on Startup"
            description="Start DockShift when Windows boots"
            control={
              <Switch
                checked={!!settings.launchOnStartup}
                onChange={(v) => update('launchOnStartup', v)}
              />
            }
          />
          <SettingRow
            label="Help improve DockShift"
            description="Send anonymous usage stats once a day (version, OS, country). No personal data, no telemetry inside the app. Off by default."
            control={
              <Switch
                checked={!!settings.analyticsEnabled}
                onChange={async (v) => {
                  // Optimistic update; rollback if the IPC says no.
                  setSettings((prev) => ({ ...prev, analyticsEnabled: v }));
                  const r = await api?.invoke?.('analytics:setEnabled', { enabled: v });
                  if (!r?.ok) {
                    setSettings((prev) => ({ ...prev, analyticsEnabled: !v }));
                  }
                }}
              />
            }
          />
        </SectionGroup>

        <SectionGroup title="Clipboard">
          <SettingRow
            label="Max History Items"
            description="Older entries are dropped past this limit"
            control={
              <Select
                value={settings.clipboardMaxItems}
                onChange={(v) => update('clipboardMaxItems', v)}
                options={CLIPBOARD_LIMITS}
                style={{ width: 90 }}
              />
            }
          />
        </SectionGroup>

        <SectionGroup title="Windows Integration">
          <ShellIntegrationRow api={api} />
        </SectionGroup>

        <SectionGroup title="Shortcuts">
          <SettingRow
            label="Toggle dock"
            description="Global hotkey that shows or hides the dock from anywhere"
            control={
              <HotkeyRecorder
                value={settings.toggleDockShortcut || DEFAULT_TOGGLE_SHORTCUT}
                defaultValue={DEFAULT_TOGGLE_SHORTCUT}
                onChange={async (accel) => {
                  const r = await api?.invoke?.('settings:hotkey:set', { accelerator: accel });
                  if (r?.ok) {
                    setSettings((prev) => ({ ...prev, toggleDockShortcut: r.accelerator }));
                  }
                  return r;
                }}
              />
            }
          />
        </SectionGroup>

        <SectionGroup title="About">
          <UpdateStatus />
        </SectionGroup>
      </div>
    </ResizablePanel>
  );

  return ReactDOM.createPortal(panel, document.body);
}

// Manages the "Open with DockShift Terminal / Save to DockShift Notes / Copy
// path to DockShift Clipboard" Explorer right-click entries. Writes to HKCU
// only (no admin needed). Install is gated on packaged builds — in dev mode,
// the exe path would be node_modules\electron.exe which makes a useless target.
function ShellIntegrationRow({ api }) {
  const [status, setStatus] = useState({ loading: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(() => {
    api?.invoke?.('shell:integrationStatus')
      ?.then((r) => setStatus({ loading: false, ...r }))
      ?.catch(() => setStatus({ loading: false, ok: false }));
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  const onInstall = async () => {
    setBusy(true); setError(null);
    const r = await api?.invoke?.('shell:install');
    setBusy(false);
    if (!r?.ok) setError(r?.error || 'Install failed');
    refresh();
  };

  const onUninstall = async () => {
    setBusy(true); setError(null);
    const r = await api?.invoke?.('shell:uninstall');
    setBusy(false);
    if (!r?.ok) setError(r?.error || 'Uninstall failed');
    refresh();
  };

  // Not Windows → nothing to install.
  if (!status.loading && status.platform !== 'win32') {
    return (
      <SettingRow
        label="Right-click context menu"
        description="Windows-only feature. The menu adds DockShift Terminal / Notes / Clipboard entries to File Explorer's right-click."
        control={<Badge tone="neutral">Windows only</Badge>}
      />
    );
  }

  // Dev mode → explain why install is disabled.
  if (!status.loading && status.devMode) {
    return (
      <SettingRow
        label="Right-click context menu"
        description="Available after installing DockShift via the NSIS installer — the dev exe path (node_modules\\electron.exe) would make the registry entry useless."
        control={<Badge tone="neutral">Dev build</Badge>}
      />
    );
  }

  const installed = !!status.installed;

  return (
    <SettingRow
      label="Right-click context menu"
      description="Add DockShift Terminal / Notes / Clipboard entries to File Explorer's right-click menu. Per-user (HKCU); no admin needed."
      control={
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ds-space-2)' }}>
          <Badge tone={installed ? 'success' : 'neutral'}>{installed ? 'Installed' : 'Not installed'}</Badge>
          {installed ? (
            <Button variant="danger" size="sm" onClick={onUninstall} disabled={busy} loading={busy}>
              Remove
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={onInstall} disabled={busy} loading={busy}>
              Install
            </Button>
          )}
        </div>
      }
    >
      {error && (
        <div style={{ fontSize: 'var(--ds-font-xs)', color: 'var(--ds-text-danger, #f87171)', paddingBottom: 'var(--ds-space-2)' }}>
          {error}
        </div>
      )}
    </SettingRow>
  );
}
