import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Select,
  Input,
  Button,
  Badge,
  Callout,
  SettingRow,
} from './ui';

/**
 * The "Voice to Text" block inside the Settings panel.
 *
 * Sibling to <AiSettings />: lets the user pick an STT provider, manage its
 * encrypted API key, optionally set a custom endpoint (for self-hosted or
 * region-pinned services), and run a Test Connection probe. The component is
 * intentionally provider-agnostic — every provider-specific concern lives in
 * `electron-transcription-providers.js`, and this UI is driven entirely by the
 * `transcription:providers` catalog.
 *
 * Props:
 *   settings   current settings (reads sttProvider, sttEndpoints)
 *   update     (key, value) => void — persist a single setting
 *   api        window.electronAPI
 */

const CAPABILITY_BADGES = [
  { key: 'autoDetectLanguage', label: 'Auto-detect' },
  { key: 'multilingual', label: 'Multilingual' },
  { key: 'streaming', label: 'Streaming' },
  { key: 'timestamps', label: 'Timestamps' },
  { key: 'diarization', label: 'Diarization' },
];

export default function VoiceSettings({ settings, update, api }) {
  const [catalog, setCatalog] = useState([]);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [keyDraft, setKeyDraft] = useState('');
  const [endpointDraft, setEndpointDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState(null); // { kind: 'ok'|'err', text }

  // Resolve the currently active provider from the catalog. `catalog`
  // already carries per-provider `hasKey` (computed in main) so the UI never
  // has to call `secrets:list` separately.
  const activeId = settings.sttProvider || catalog[0]?.id || '';
  const active = useMemo(
    () => catalog.find((p) => p.id === activeId) || null,
    [catalog, activeId]
  );

  const refresh = useCallback(() => {
    api?.invoke?.('transcription:providers')
      ?.then((res) => {
        setCatalog(Array.isArray(res?.providers) ? res.providers : []);
        setEncryptionAvailable(res?.encryptionAvailable !== false);
      })
      ?.catch(() => {});
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  // Reset transient form state when switching providers so a stale draft or
  // notice from one provider doesn't bleed into another's panel.
  useEffect(() => {
    setKeyDraft('');
    setNotice(null);
    if (active) {
      // Prefill the endpoint input with the saved override (or default).
      const saved = (settings.sttEndpoints && settings.sttEndpoints[active.id]) || '';
      setEndpointDraft(saved || active.defaultEndpoint || '');
    } else {
      setEndpointDraft('');
    }
  }, [activeId, active, settings.sttEndpoints]);

  const handleProviderChange = (id) => {
    update('sttProvider', id);
  };

  const handleSaveKey = async () => {
    if (!active?.keyName || !keyDraft.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.invoke('secrets:set', {
        name: active.keyName,
        value: keyDraft.trim(),
      });
      if (res?.ok) {
        setKeyDraft('');
        setNotice({ kind: 'ok', text: 'Key saved — encrypted on this device.' });
        refresh();
      } else {
        const reason = res?.reason === 'encryption-unavailable'
          ? 'Secure storage unavailable on this system — key not saved.'
          : 'Could not save the key.';
        setNotice({ kind: 'err', text: reason });
      }
    } catch (_) {
      setNotice({ kind: 'err', text: 'Could not save the key.' });
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveKey = async () => {
    if (!active?.keyName) return;
    setBusy(true);
    try {
      await api.invoke('secrets:delete', { name: active.keyName });
      setNotice({ kind: 'ok', text: 'Key removed.' });
      refresh();
    } catch (_) {
      setNotice({ kind: 'err', text: 'Could not remove the key.' });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEndpoint = () => {
    if (!active) return;
    const next = { ...(settings.sttEndpoints || {}) };
    const trimmed = endpointDraft.trim();
    if (trimmed && trimmed !== (active.defaultEndpoint || '')) {
      next[active.id] = trimmed;
    } else {
      delete next[active.id];
    }
    update('sttEndpoints', next);
    setNotice({ kind: 'ok', text: 'Endpoint saved.' });
  };

  const handleTest = async () => {
    if (!active) return;
    setTesting(true);
    setNotice(null);
    try {
      const res = await api.invoke('transcription:test', { providerId: active.id });
      if (res?.ok) {
        setNotice({ kind: 'ok', text: res.info || 'Connection successful.' });
      } else {
        setNotice({ kind: 'err', text: res?.error || 'Connection failed.' });
      }
    } catch (err) {
      setNotice({ kind: 'err', text: err?.message || 'Connection failed.' });
    } finally {
      setTesting(false);
    }
  };

  const providerOptions = catalog.map((p) => ({
    value: p.id,
    label: p.label,
    hint: p.keyless ? 'No key required' : undefined,
  }));

  const showKeyForm = active && !active.keyless && active.keyName;
  const hasKey = !!active?.hasKey;

  return (
    <>
      {!encryptionAvailable && (
        <Callout tone="danger" style={{ margin: 'var(--ds-space-3) 0' }}>
          Secure key storage isn't available on this system. STT API keys can't be saved encrypted.
        </Callout>
      )}

      <SettingRow
        label="Provider"
        description="Used by the Voice to Text panel for all transcription requests."
        control={
          <Select
            value={activeId}
            onChange={handleProviderChange}
            options={providerOptions}
            placeholder="Select provider"
            searchable
            style={{ width: 220 }}
          />
        }
      />

      {active && (
        <SettingRow stack>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--ds-space-2)',
            paddingBottom: 'var(--ds-space-3)',
          }}>
            <div style={{
              fontSize: 'var(--ds-font-xs)',
              color: 'var(--ds-text-dim)',
              lineHeight: 1.5,
            }}>
              {active.description}
            </div>
            <div style={{ display: 'flex', gap: 'var(--ds-space-2)', flexWrap: 'wrap' }}>
              {CAPABILITY_BADGES.map((cap) => (
                <Badge
                  key={cap.key}
                  tone={active.capabilities?.[cap.key] ? 'success' : 'neutral'}
                  title={active.capabilities?.[cap.key] ? `${cap.label} supported` : `${cap.label} not supported`}
                >
                  {active.capabilities?.[cap.key] ? `✓ ${cap.label}` : `· ${cap.label}`}
                </Badge>
              ))}
            </div>
            {active.docsUrl && (
              <a
                href={active.docsUrl}
                onClick={(e) => {
                  e.preventDefault();
                  api?.invoke?.('app:openExternal', { url: active.docsUrl })?.catch(() => {});
                }}
                style={{
                  fontSize: 'var(--ds-font-xs)',
                  color: 'var(--ds-accent)',
                  textDecoration: 'none',
                }}
              >
                Provider documentation →
              </a>
            )}
          </div>
        </SettingRow>
      )}

      {showKeyForm && (
        <SettingRow
          label="API Key"
          control={
            hasKey ? (
              <>
                <Badge tone="success">Saved</Badge>
                <Button variant="danger" size="sm" onClick={handleRemoveKey} disabled={busy}>
                  Remove
                </Button>
              </>
            ) : (
              <Badge tone="neutral">Not set</Badge>
            )
          }
        >
          {!hasKey && (
            <div style={{ display: 'flex', gap: 'var(--ds-space-2)', paddingBottom: 'var(--ds-space-3)' }}>
              <Input
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveKey(); }}
                placeholder={`Paste your ${active.label} API key`}
              />
              <Button
                variant="primary"
                onClick={handleSaveKey}
                disabled={busy || !keyDraft.trim()}
                loading={busy}
              >
                Save
              </Button>
            </div>
          )}
          <div style={{
            fontSize: 'var(--ds-font-xs)',
            color: 'var(--ds-text-dim)',
            lineHeight: 1.5,
            paddingBottom: 'var(--ds-space-3)',
          }}>
            Stored encrypted on this device via the OS keystore. Never sent anywhere except {active.label}.
          </div>
        </SettingRow>
      )}

      {active?.keyless && (
        <SettingRow>
          <Callout tone="neutral" style={{ marginBottom: 'var(--ds-space-3)' }}>
            {active.label} does not require an API key. {active.id === 'custom-openai'
              ? 'Provide an endpoint below; the bearer token is optional.'
              : ''}
          </Callout>
        </SettingRow>
      )}

      {active?.supportsCustomEndpoint && (
        <SettingRow
          label="Custom Endpoint"
          description={
            active.defaultEndpoint
              ? `Leave blank to use ${active.defaultEndpoint}`
              : 'Required — provider does not ship a default endpoint.'
          }
        >
          <div style={{ display: 'flex', gap: 'var(--ds-space-2)', paddingBottom: 'var(--ds-space-3)' }}>
            <Input
              type="url"
              value={endpointDraft}
              onChange={(e) => setEndpointDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEndpoint(); }}
              placeholder={active.defaultEndpoint || 'https://…'}
            />
            <Button
              variant="secondary"
              onClick={handleSaveEndpoint}
              disabled={busy}
            >
              Save
            </Button>
          </div>
        </SettingRow>
      )}

      {active && (
        <SettingRow
          label="Test Connection"
          description="Verify the key and endpoint reach the provider without consuming transcription credits."
          control={
            <Button
              variant="secondary"
              onClick={handleTest}
              loading={testing}
              disabled={testing || (!active.keyless && !hasKey)}
            >
              Test
            </Button>
          }
        />
      )}

      {notice && (
        <div style={{ padding: '0 0 var(--ds-space-3)' }}>
          <Callout tone={notice.kind === 'ok' ? 'success' : 'danger'}>{notice.text}</Callout>
        </div>
      )}
    </>
  );
}
