import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { HEADER_STYLE, TITLE_STYLE } from '../hooks/usePanelPosition';
import ResizablePanel from './ResizablePanel';
import { Button, IconButton, Select, Callout, Badge, XIcon, MicIcon, StopIcon } from './ui';
import { useMicPcm, float32ToBase64 } from '../hooks/useMicPcm';
import '../styles/panels.css';

/** Format a byte count as "12.4 MB" / "534 KB" for the model download UI. */
function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Curated language list shown in the top selector. The first entry — 'auto' —
 * means "let the provider detect the spoken language", and is only enabled
 * when the active STT provider advertises `capabilities.autoDetectLanguage`.
 *
 * The values are BCP-47 tags; the main process normalizes them to whatever
 * shape each provider expects (e.g. trims to ISO-639-1 for Whisper).
 */
const LANGUAGES = [
  { value: 'auto', label: 'Auto Detect' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'es-ES', label: 'Spanish' },
  { value: 'fr-FR', label: 'French' },
  { value: 'de-DE', label: 'German' },
  { value: 'ja-JP', label: 'Japanese' },
  { value: 'ko-KR', label: 'Korean' },
  { value: 'zh-CN', label: 'Chinese' },
  { value: 'ar-SA', label: 'Arabic' },
  { value: 'pt-BR', label: 'Portuguese (BR)' },
  { value: 'ru-RU', label: 'Russian' },
  { value: 'it-IT', label: 'Italian' },
];

/** MIME type the renderer records in. Kept in sync with what providers accept. */
const RECORDER_MIME = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
  ? 'audio/webm;codecs=opus'
  : 'audio/webm';

/**
 * Convert a Blob to base64 (without the data: prefix). Uses FileReader so the
 * heavy lifting stays off the main thread for large clips.
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export default function VoicePanel({ isOpen, onClose, anchorRect }) {
  const api = useMemo(() => window.electronAPI, []);

  // ── Recording / transcription state ────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [language, setLanguage] = useState('auto');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const [detectedLanguage, setDetectedLanguage] = useState(null);

  // ── Provider catalog (capabilities, label) ─────────────────────────────────
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState('');

  // ── Refs for live recording (don't trigger re-renders) ─────────────────────
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  // Snapshot of the language at recording-start time. Mutating the selector
  // mid-recording must NOT change which language hint is sent for the
  // already-captured audio — this ref freezes it.
  const recordingLanguageRef = useRef('auto');
  const scrollRef = useRef(null);

  const activeProvider = useMemo(
    () => providers.find((p) => p.id === activeProviderId) || null,
    [providers, activeProviderId]
  );
  const supportsAutoDetect = activeProvider
    ? !!activeProvider.capabilities?.autoDetectLanguage
    : true; // assume yes until catalog loads, so the UI doesn't flicker
  // localNative providers (Parakeet / Whisper via sherpa) capture raw Float32 PCM
  // in the renderer and decode it in the main process. They need a one-time model
  // download, a much larger one than the cloud providers' zero.
  const isLocalNative = !!activeProvider?.localNative;
  const localModelId = activeProvider?.modelId || null;

  // ── localNative (sherpa) on-device state ───────────────────────────────────
  const mic = useMicPcm();
  const [localModelInstalled, setLocalModelInstalled] = useState(false);
  const [localModelStatus, setLocalModelStatus] = useState(null); // catalog getStatus()
  const [localDownloadState, setLocalDownloadState] = useState(null);
  const autoDlRef = useRef(false); // ensures the auto-download fires at most once

  // Catalog + persisted language preference. Reload on every panel open so
  // changes made in Settings (provider switch, key added) take effect without
  // re-mounting the panel.
  useEffect(() => {
    if (!isOpen || !api) return;
    let cancelled = false;
    api.invoke('transcription:providers').then((res) => {
      if (cancelled) return;
      setProviders(Array.isArray(res?.providers) ? res.providers : []);
      setActiveProviderId(res?.activeId || '');
    }).catch(() => {});
    api.invoke('settings:get').then((s) => {
      if (cancelled || !s) return;
      if (typeof s.sttLanguage === 'string' && s.sttLanguage) {
        setLanguage(s.sttLanguage);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen, api]);

  // When the catalog reveals the active provider can't auto-detect, fall back
  // to a safe default — but only if the user has 'auto' selected. We never
  // silently overwrite a manual choice the user actually made.
  useEffect(() => {
    if (activeProvider && !supportsAutoDetect && language === 'auto') {
      setLanguage('en-US');
    }
  }, [activeProvider, supportsAutoDetect, language]);

  // Persist the user's language choice. Excluded from the recording-start
  // capture above so an in-flight transcription is unaffected. Defensively
  // rejects 'auto' for providers that don't support it (Select can't render
  // per-option disabled, so we enforce here instead).
  const handleLanguageChange = useCallback((value) => {
    const next = (value === 'auto' && !supportsAutoDetect) ? 'en-US' : value;
    setLanguage(next);
    api?.invoke?.('settings:set', { settings: { sttLanguage: next } })?.catch(() => {});
  }, [api, supportsAutoDetect]);

  // Stop a live recording when the panel closes — releases the mic and avoids
  // a transcription firing after the user dismissed the panel.
  useEffect(() => {
    if (isOpen) return;
    if (mediaRecorderRef.current && isRecording) {
      try { mediaRecorderRef.current.stop(); } catch (_) {}
    }
    if (isRecording && mic.isCapturing) {
      mic.cancel(); // localNative path: release the mic, discard the clip
    }
    if (isRecording) setIsRecording(false);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [isOpen, isRecording, mic]);

  // Cleanup on unmount: belt-and-braces release of any live mic stream.
  useEffect(() => () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  // localNative model: check whether the provider's model is on disk yet, and
  // auto-download it for every user if it's missing (no manual click needed).
  useEffect(() => {
    if (!isOpen || !api || !isLocalNative || !localModelId) return undefined;
    let cancelled = false;
    api.invoke('stt:model:status', { id: localModelId }).then((res) => {
      if (cancelled || !res) return;
      setLocalModelStatus(res);
      setLocalModelInstalled(!!res.installed);
      if (res.downloading) {
        // A background download (e.g. kicked off from the welcome screen) is
        // already running — reflect it instead of starting a second one.
        setLocalDownloadState((s) => s || { phase: 'downloading', downloaded: 0, total: res.downloadBytes || 0 });
      } else if (res.installable && !res.installed && !autoDlRef.current) {
        autoDlRef.current = true;
        setLocalDownloadState({ phase: 'starting', downloaded: 0, total: res.downloadBytes || 0 });
        api.invoke('stt:model:download', { id: localModelId }).then((r) => {
          if (cancelled) return;
          if (r && !r.ok) setLocalDownloadState({ phase: 'error', downloaded: 0, total: 0 });
          else setLocalModelInstalled(true);
        }).catch(() => {});
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen, api, isLocalNative, localModelId]);

  // localNative download progress (download → verify → extract → done).
  useEffect(() => {
    if (!api?.on) return undefined;
    const unsub = api.on('stt:model:progress', (data) => {
      if (localModelId && data?.id && data.id !== localModelId) return;
      setLocalDownloadState(data);
      if (data?.phase === 'done') setLocalModelInstalled(true);
    });
    return () => { try { unsub?.(); } catch (_) {} };
  }, [api, localModelId]);

  /** One-time download of a localNative (sherpa) model. Progress via push channel. */
  const handleDownloadLocalModel = useCallback(async () => {
    if (!localModelId) return;
    setError(null);
    setLocalDownloadState({ phase: 'starting', downloaded: 0, total: 0 });
    const res = await api.invoke('stt:model:download', { id: localModelId })
      .catch((err) => ({ ok: false, error: err?.message }));
    if (!res?.ok) {
      setError(res?.error || 'Could not download the speech model.');
      setLocalDownloadState({ phase: 'error', downloaded: 0, total: 0 });
    } else {
      setLocalModelInstalled(true);
    }
  }, [api, localModelId]);

  /**
   * localNative recording: capture mono Float32 PCM in the renderer (useMicPcm),
   * then on stop base64 it and post to main with `pcm: true` + `sampleRate`. The
   * main-process sherpa engine decodes it; no MediaRecorder / container involved.
   */
  const transcribeLocalPcm = useCallback(async () => {
    const { samples, sampleRate } = mic.stop();
    setIsRecording(false);
    if (!samples.length) return;
    setIsTranscribing(true);
    try {
      const lang = recordingLanguageRef.current;
      const result = await api.invoke('transcription:transcribe', {
        audio: float32ToBase64(samples),
        pcm: true,
        sampleRate,
        language: lang === 'auto' ? null : lang,
      });
      if (!result?.ok) {
        setError(result?.error || 'Transcription failed.');
      } else if (result.text) {
        setTranscript((prev) => prev + (prev ? ' ' : '') + result.text);
        if (result.detectedLanguage) setDetectedLanguage(result.detectedLanguage);
      }
    } catch (err) {
      setError(err?.message || 'Transcription failed.');
    } finally {
      setIsTranscribing(false);
    }
  }, [api, mic]);

  const toggleRecording = useCallback(async () => {
    if (isRecording) {
      // Stop whichever pathway is active.
      if (isLocalNative) { await transcribeLocalPcm(); return; }
      try { mediaRecorderRef.current?.stop(); } catch (_) {}
      setIsRecording(false);
      return;
    }

    setError(null);
    setDetectedLanguage(null);

    if (isLocalNative) {
      if (!localModelInstalled) {
        setError('The on-device model isn\'t downloaded yet. Click "Download model" first.');
        return;
      }
      recordingLanguageRef.current = language;
      try {
        await mic.start();
        setIsRecording(true);
      } catch (_) {
        setError('Microphone access denied or not supported.');
      }
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      setError('Microphone access denied or not supported.');
      return;
    }

    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: RECORDER_MIME });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      setError(`Could not start recorder: ${err.message}`);
      return;
    }

    chunksRef.current = [];
    recordingLanguageRef.current = language;
    streamRef.current = stream;
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      // Release the mic immediately so the OS indicator clears even if the
      // transcription request hangs.
      stream.getTracks().forEach((t) => t.stop());
      if (streamRef.current === stream) streamRef.current = null;

      if (chunksRef.current.length === 0) return;
      const blob = new Blob(chunksRef.current, { type: RECORDER_MIME });
      chunksRef.current = [];

      setIsTranscribing(true);
      try {
        const base64Audio = await blobToBase64(blob);
        // language: 'auto' (or null) → main process omits the param so the
        // provider auto-detects. The captured value comes from the ref so a
        // mid-recording UI change can't poison the request.
        const lang = recordingLanguageRef.current;
        const result = await api.invoke('transcription:transcribe', {
          audio: base64Audio,
          mimeType: blob.type || RECORDER_MIME,
          language: lang === 'auto' ? null : lang,
        });
        if (!result?.ok) {
          setError(result?.error || 'Transcription failed.');
        } else if (result.text) {
          setTranscript((prev) => prev + (prev ? ' ' : '') + result.text);
          if (result.detectedLanguage) setDetectedLanguage(result.detectedLanguage);
        }
      } catch (err) {
        setError(err?.message || 'Transcription failed.');
      } finally {
        setIsTranscribing(false);
      }
    };

    try {
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      setError(`Could not start recording: ${err.message}`);
    }
  }, [isRecording, language, api, isLocalNative, localModelInstalled, mic, transcribeLocalPcm]);

  const handleCopy = useCallback(() => {
    if (!transcript) return;
    if (api?.clipboard?.copy) api.clipboard.copy(transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [transcript, api]);

  const handleClear = useCallback(() => {
    setTranscript('');
    setError(null);
    setDetectedLanguage(null);
  }, []);

  // Auto-scroll the transcript area as new text arrives.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [transcript, isTranscribing]);

  if (!isOpen || !anchorRect) return null;

  // On-device (sherpa localNative) gates recording behind a one-time model
  // download; cloud providers have no model to fetch. Unify so the record
  // button, status line, and download CTA share one source of truth.
  const modelMissing = isLocalNative && !localModelInstalled;
  const showRecordUI = !modelMissing;
  const activeDownloadState = localDownloadState;
  const downloadMB = localModelStatus?.downloadBytes
    ? Math.round(localModelStatus.downloadBytes / 1024 / 1024)
    : 620;
  const downloadPhaseLabel = activeDownloadState?.phase === 'verifying'
    ? 'Verifying model…'
    : activeDownloadState?.phase === 'extracting'
      ? 'Extracting model…'
      : 'Downloading speech model…';

  // Build the language option list — disabling 'auto' for providers that don't
  // support it preserves the UI affordance while preventing invalid requests.
  const languageOptions = LANGUAGES.map((opt) =>
    opt.value === 'auto' && !supportsAutoDetect
      ? { ...opt, label: `${opt.label} (unsupported)`, disabled: true }
      : opt
  );

  const panel = (
    <ResizablePanel isOpen={isOpen} dockAction="mic">
      {/* Header */}
      <div style={HEADER_STYLE}>
        <span style={TITLE_STYLE}>Voice to Text</span>
        <Select
          value={language}
          onChange={handleLanguageChange}
          options={languageOptions}
          searchable
          size="sm"
          style={{ width: 160 }}
        />
        <IconButton variant="danger" title="Close" onClick={onClose}>
          <XIcon size={14} />
        </IconButton>
      </div>

      {/* Provider hint row — shows active provider + detected language when present.
          Kept lightweight so it never crowds the recording control. */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--ds-space-2)',
        flexWrap: 'wrap',
        fontSize: 'var(--ds-font-xs)',
        color: 'var(--ds-text-dim)',
        flexShrink: 0,
      }}>
        {activeProvider && (
          <Badge tone="neutral" title="Configured in Settings → Voice to Text">
            {activeProvider.label}
          </Badge>
        )}
        {language === 'auto' && supportsAutoDetect && (
          <Badge tone="accent">Auto-detect on</Badge>
        )}
        {detectedLanguage && language === 'auto' && (
          <Badge tone="success">Detected: {detectedLanguage}</Badge>
        )}
      </div>

      {/* Capability warning — only shown when the user picked 'auto' against a
          provider that doesn't support it (rare, since we auto-fallback above). */}
      {!supportsAutoDetect && language === 'auto' && (
        <Callout tone="warning">
          {activeProvider?.label || 'This provider'} doesn't support auto-detection — pick a language.
        </Callout>
      )}

      {/* First-use download prompt — only shown for on-device providers when the
          model isn't cached yet. Hides the record button until the user opts in
          so the panel never looks "broken" before the one-time download. */}
      {modelMissing && (
        activeDownloadState && activeDownloadState.phase !== 'error' && activeDownloadState.phase !== 'done' ? (
          <div style={{
            padding: 'var(--ds-space-3)',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--ds-space-2)',
            alignItems: 'stretch',
          }}>
            <div style={{ fontSize: 'var(--ds-font-sm)', color: 'var(--ds-text-secondary)' }}>
              {downloadPhaseLabel}
            </div>
            <div style={{
              width: '100%',
              height: 6,
              background: 'var(--ds-bg-subtle)',
              borderRadius: 999,
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${activeDownloadState.total > 0
                  ? Math.min(100, Math.round((activeDownloadState.downloaded / activeDownloadState.total) * 100))
                  : 0}%`,
                background: 'var(--ds-accent)',
                transition: 'width 120ms linear',
              }} />
            </div>
            <div style={{ fontSize: 'var(--ds-font-xs)', color: 'var(--ds-text-dim)' }}>
              {formatBytes(activeDownloadState.downloaded)} of {formatBytes(activeDownloadState.total || 0)}
            </div>
          </div>
        ) : (
          <Callout tone="neutral">
            <div style={{ marginBottom: 'var(--ds-space-2)' }}>
              On-device speech needs a one-time ~{downloadMB} MB model download. After that
              it works offline with no API key.
            </div>
            <Button variant="primary" onClick={handleDownloadLocalModel}>
              Download model
            </Button>
          </Callout>
        )
      )}

      {/* Record button — shown once any required on-device model is present. */}
      {showRecordUI && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--ds-space-3) 0' }}>
          <button
            onClick={toggleRecording}
            title={isRecording ? 'Stop recording' : 'Start recording'}
            style={{
              width: 68,
              height: 68,
              borderRadius: '50%',
              background: isRecording ? 'var(--ds-danger)' : 'var(--ds-accent)',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              boxShadow: isRecording
                ? '0 0 0 6px var(--ds-danger-bg)'
                : '0 0 0 4px var(--ds-accent-bg)',
              transition: 'background var(--ds-dur-base) var(--ds-ease)',
              animation: isRecording ? 'voicePulse 1.5s ease-in-out infinite' : 'none',
              WebkitAppRegion: 'no-drag',
            }}
          >
            {isRecording ? <StopIcon size={24} /> : <MicIcon size={26} />}
          </button>
        </div>
      )}

      {/* Status */}
      {showRecordUI && (
        <div style={{
          textAlign: 'center',
          fontSize: 'var(--ds-font-sm)',
          color: 'var(--ds-text-faint)',
          flexShrink: 0,
        }}>
          {isRecording ? (
            <span style={{ color: 'var(--ds-danger)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--ds-space-2)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--ds-danger)', animation: 'voiceDot 1s ease-in-out infinite' }} />
              Listening… click to stop
            </span>
          ) : isTranscribing ? (
            <span style={{ color: 'var(--ds-accent-cyan)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--ds-space-2)' }}>
              <span style={{ width: 12, height: 12, border: '2px solid var(--ds-accent-cyan)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
              Transcribing…
            </span>
          ) : (
            'Click to start recording'
          )}
        </div>
      )}

      {/* Error */}
      {error && <Callout tone="danger">{error}</Callout>}

      {/* Transcript */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          minHeight: 0,
          background: 'var(--ds-bg-subtle)',
          borderRadius: 'var(--ds-radius-md)',
          padding: 'var(--ds-space-3)',
          fontSize: 'var(--ds-font-base)',
          lineHeight: 1.6,
          color: 'var(--ds-text-secondary)',
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--ds-scrollbar-thumb) transparent',
        }}
      >
        {transcript && <span>{transcript}</span>}
        {!transcript && !isTranscribing && (
          <span style={{ color: 'var(--ds-text-dim)', fontStyle: 'italic' }}>
            Your transcript will appear here…
          </span>
        )}
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 'var(--ds-space-2)', flexShrink: 0 }}>
        <Button variant="primary" fullWidth onClick={handleCopy} disabled={!transcript}>
          {copied ? 'Copied' : 'Copy to Clipboard'}
        </Button>
        <Button variant="secondary" onClick={handleClear} disabled={!transcript}>
          Clear
        </Button>
      </div>
    </ResizablePanel>
  );

  return ReactDOM.createPortal(panel, document.body);
}
