import { useCallback, useEffect, useMemo, useState } from 'react';
import ConfirmModal from './ConfirmModal';
import {
  Select,
  Input,
  Button,
  Badge,
  Callout,
  SettingRow,
} from './ui';

/**
 * The "AI & Models" block inside the Settings panel.
 *
 * Lets the user pick an AI provider + model and manage that provider's API
 * key. Keys are written through the `secrets:` IPC surface, which encrypts
 * them in the main process — a raw key value is never read back here, only
 * its existence (`secrets:has` / `secrets:list`).
 *
 * Props:
 *   - settings: current settings object (reads aiProvider, aiModel)
 *   - update(key, value): persist a single setting
 *   - api: window.electronAPI
 */
export default function AiSettings({ settings, update, api }) {
  const [providers, setProviders] = useState([]);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [savedKeyNames, setSavedKeyNames] = useState([]);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { kind: 'ok'|'err', text }
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);

  // Live model catalog (Phase 3 wires `ai:listModels`); falls back to the
  // provider's curated list.
  const [modelList, setModelList] = useState([]); // [{ value, label, hint? }]
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsFallback, setModelsFallback] = useState(false);

  const activeId = settings.aiProvider || 'gemini';
  const activeProvider = useMemo(
    () => providers.find((p) => p.id === activeId) || null,
    [providers, activeId]
  );

  const refreshKeys = useCallback(() => {
    api?.invoke?.('secrets:list')
      ?.then((res) => setSavedKeyNames(Array.isArray(res?.names) ? res.names : []))
      ?.catch(() => {});
  }, [api]);

  // Load the provider catalog + which keys already exist, once.
  useEffect(() => {
    api?.invoke?.('ai:providers')
      ?.then((res) => {
        const list = Array.isArray(res?.providers) ? res.providers : [];
        setProviders(list);
        setEncryptionAvailable(res?.encryptionAvailable !== false);
        // Self-heal stale settings: if the saved provider isn't in the catalog
        // (e.g. removed in an update), drop the user onto the first visible
        // option so the dropdown isn't stuck on a phantom id.
        if (list.length && settings.aiProvider && !list.find((p) => p.id === settings.aiProvider)) {
          const next = list[0];
          update('aiProvider', next.id);
          update('aiModel', next.defaultModel);
        }
      })
      ?.catch(() => {});
    refreshKeys();
  }, [api, refreshKeys, settings.aiProvider, update]);

  // Clear the draft + any notice when switching providers.
  useEffect(() => { setKeyDraft(''); setNotice(null); }, [activeId]);

  // Fetch the model list for the active provider (live, with curated fallback).
  useEffect(() => {
    if (!activeProvider) return undefined;
    let cancelled = false;
    const curated = (activeProvider.models || []).map((m) => ({ value: m, label: m }));
    // Show the curated list immediately while the live fetch runs.
    setModelList(curated);
    setModelsFallback(false);

    const pending = api?.invoke?.('ai:listModels', { provider: activeProvider.id });
    // `invoke` returns undefined for a channel not on the preload allowlist —
    // degrade to the curated list instead of spinning forever.
    if (!pending || typeof pending.then !== 'function') {
      setModelsLoading(false);
      return () => { cancelled = true; };
    }

    setModelsLoading(true);
    pending
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.models)
          ? res.models.map((m) => (typeof m === 'string' ? { value: m, label: m } : m))
          : curated;
        setModelList(list.length ? list : curated);
        setModelsFallback(res?.source === 'fallback');
      })
      .catch(() => { if (!cancelled) { setModelList(curated); setModelsFallback(true); } })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [api, activeProvider]);

  const hasKey = activeProvider && activeProvider.keyName
    ? savedKeyNames.includes(activeProvider.keyName)
    : false;

  const handleProviderChange = (id) => {
    const next = providers.find((p) => p.id === id);
    update('aiProvider', id);
    // Reset the model to that provider's default — models don't cross providers.
    if (next) update('aiModel', next.defaultModel);
  };

  const handleSaveKey = async () => {
    if (!activeProvider?.keyName || !keyDraft.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.invoke('secrets:set', {
        name: activeProvider.keyName,
        value: keyDraft.trim(),
      });
      if (res?.ok) {
        setKeyDraft('');
        setNotice({ kind: 'ok', text: 'Key saved — encrypted on this device.' });
        refreshKeys();
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
    if (!activeProvider?.keyName) return;
    setBusy(true);
    try {
      await api.invoke('secrets:delete', { name: activeProvider.keyName });
      setNotice({ kind: 'ok', text: 'Key removed.' });
      refreshKeys();
    } catch (_) {
      setNotice({ kind: 'err', text: 'Could not remove the key.' });
    } finally {
      setBusy(false);
    }
  };

  const providerOptions = providers.map((p) => ({ value: p.id, label: p.label }));
  const activeModel = settings.aiModel || activeProvider?.defaultModel || '';

  return (
    <>
      {!encryptionAvailable && (
        <Callout tone="danger" style={{ margin: 'var(--ds-space-3) 0' }}>
          Secure key storage isn't available on this system. API keys can't be saved
          encrypted — use a <code>.env</code> file instead.
        </Callout>
      )}

      <SettingRow
        label="Provider"
        control={
          <Select
            value={activeId}
            onChange={handleProviderChange}
            options={providerOptions}
            placeholder="Select provider"
            style={{ width: 180 }}
          />
        }
      />

      <SettingRow
        label="Model"
        description={modelsFallback ? 'Showing a built-in list — live catalog unavailable.' : undefined}
        control={
          <Select
            value={activeModel}
            onChange={(v) => update('aiModel', v)}
            options={modelList}
            searchable
            allowCustom
            loading={modelsLoading}
            placeholder="Select model"
            emptyText="No models — type to use a custom id"
            style={{ width: 200 }}
          />
        }
      />

      {activeProvider?.keyless ? (
        <SettingRow>
          <Callout tone="neutral" style={{ marginBottom: 'var(--ds-space-3)' }}>
            {activeProvider.setupHint
              || `${activeProvider.label} runs locally — no API key needed.`}
          </Callout>
        </SettingRow>
      ) : (
        <SettingRow
          label="API Key"
          control={
            hasKey ? (
              <>
                <Badge tone="success">Saved</Badge>
                <Button variant="danger" size="sm" onClick={() => setConfirmRemoveOpen(true)} disabled={busy}>
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
                placeholder={`Paste your ${activeProvider?.label || ''} API key`}
                flat
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
          {notice && (
            <div style={{ paddingBottom: 'var(--ds-space-3)' }}>
              <Callout tone={notice.kind === 'ok' ? 'success' : 'danger'}>{notice.text}</Callout>
            </div>
          )}
          <div style={{
            fontSize: 'var(--ds-font-xs)',
            color: 'var(--ds-text-dim)',
            lineHeight: 1.5,
            paddingBottom: 'var(--ds-space-3)',
          }}>
            Stored encrypted on this device via the OS keystore. Never sent anywhere
            except {activeProvider?.label || 'the provider'}.
          </div>
        </SettingRow>
      )}

      <ConfirmModal
        isOpen={confirmRemoveOpen}
        title={`Remove ${activeProvider?.label || ''} API key?`}
        message={
          <>
            The encrypted key for{' '}
            <strong style={{ color: 'var(--ds-text-strong)' }}>{activeProvider?.label || 'this provider'}</strong>
            {' '}will be deleted from this device. AI features that depend on it will stop
            working until you paste the key in again.
          </>
        }
        confirmLabel="Remove"
        variant="danger"
        onConfirm={async () => {
          setConfirmRemoveOpen(false);
          await handleRemoveKey();
        }}
        onClose={() => setConfirmRemoveOpen(false)}
      />
    </>
  );
}
