import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { HEADER_STYLE, TITLE_STYLE } from '../hooks/usePanelPosition';
import ResizablePanel from './ResizablePanel';
import { Button, IconButton, Select, Callout, Badge, XIcon, MicIcon, StopIcon } from './ui';
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
  // Client-side providers (e.g. on-device Vosk) bypass the MediaRecorder + IPC
  // round-trip and stream audio directly into a WASM recognizer in the renderer.
  const isClientSide = !!activeProvider?.clientSide;

  // ── On-device speech state ────────────────────────────────────────────────
  // The Vosk model is heavy to load (parses a ~40 MB tar.gz and spins up a
  // WebWorker), so we keep the Model alive across recordings in a ref and only
  // tear it down on unmount. A fresh Recognizer is created per recording.
  const [modelInstalled, setModelInstalled] = useState(false);
  const [modelBytes, setModelBytes] = useState(0);
  const [downloadState, setDownloadState] = useState(null);
  // ^ null | { phase: 'starting'|'downloading'|'done'|'error', downloaded, total }
  const [isLoadingModel, setIsLoadingModel] = useState(false);
  const voskModelRef = useRef(null);
  const voskRecognizerRef = useRef(null);
  const audioCtxRef = useRef(null);
  const processorRef = useRef(null);
  // The committed prefix the recognizer's interim results extend. Lives in a
  // ref so onresult handlers (which capture an initial closure) always read
  // the current value without re-binding.
  const transcriptBaseRef = useRef('');
  const partialRef = useRef('');

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

  /**
   * Tear down the live on-device recording pipeline — recognizer, audio nodes,
   * mic stream. Idempotent; called from the stop button, panel-close effect,
   * and unmount cleanup. Leaves the loaded Vosk model alive so a follow-up
   * recording in the same session starts instantly.
   */
  const stopVoskPipeline = useCallback(() => {
    if (voskRecognizerRef.current) {
      try { voskRecognizerRef.current.retrieveFinalResult(); } catch (_) {}
      try { voskRecognizerRef.current.remove(); } catch (_) {}
      voskRecognizerRef.current = null;
    }
    if (processorRef.current) {
      try { processorRef.current.disconnect(); } catch (_) {}
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch (_) {}
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  // Stop a live recording when the panel closes — releases the mic and avoids
  // a transcription firing after the user dismissed the panel.
  useEffect(() => {
    if (isOpen) return;
    if (mediaRecorderRef.current && isRecording) {
      try { mediaRecorderRef.current.stop(); } catch (_) {}
    }
    if (isRecording && voskRecognizerRef.current) {
      stopVoskPipeline();
    }
    if (isRecording) setIsRecording(false);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [isOpen, isRecording, stopVoskPipeline]);

  // Cleanup on unmount: belt-and-braces release of the mic stream + the
  // Vosk model (which owns a Web Worker).
  useEffect(() => () => {
    stopVoskPipeline();
    if (voskModelRef.current) {
      try { voskModelRef.current.terminate(); } catch (_) {}
      voskModelRef.current = null;
    }
  }, [stopVoskPipeline]);

  // Check whether the on-device model is already cached on disk. Runs when the
  // panel opens onto a client-side provider so we can render either the
  // download CTA or the normal record button without flicker.
  useEffect(() => {
    if (!isOpen || !api || !isClientSide) return undefined;
    let cancelled = false;
    api.invoke('stt:voskModel:status').then((res) => {
      if (cancelled) return;
      setModelInstalled(!!res?.installed);
      setModelBytes(res?.sizeBytes || 0);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen, api, isClientSide]);

  // Stream the one-time download progress from main into the progress UI. The
  // generic `api.on` returns an unsubscribe — return it so each remount of the
  // panel re-binds cleanly.
  useEffect(() => {
    if (!api?.on) return undefined;
    const unsub = api.on('stt:voskModel:progress', (data) => {
      setDownloadState(data);
      if (data?.phase === 'done') {
        setModelInstalled(true);
        setModelBytes(data.downloaded || 0);
      }
    });
    return () => { try { unsub?.(); } catch (_) {} };
  }, [api]);

  /** Kick off the one-time model download. Progress comes back via the push channel. */
  const handleDownloadModel = useCallback(async () => {
    setError(null);
    setDownloadState({ phase: 'starting', downloaded: 0, total: 0 });
    const res = await api.invoke('stt:voskModel:download').catch((err) => ({ ok: false, error: err?.message }));
    if (!res?.ok) {
      setError(res?.error || 'Could not download the speech model.');
      setDownloadState({ phase: 'error', downloaded: 0, total: 0 });
    }
  }, [api]);

  /**
   * Lazily load the on-device Vosk model. Returns the cached instance on
   * subsequent calls so toggling record back on doesn't re-parse the archive.
   * The model URL is served by the main process's `vosk-model://` protocol.
   */
  const loadVoskModel = useCallback(async () => {
    if (voskModelRef.current) return voskModelRef.current;
    setIsLoadingModel(true);
    try {
      const { createModel } = await import('vosk-browser');
      const model = await createModel('vosk-model://en-us-small');
      voskModelRef.current = model;
      return model;
    } finally {
      setIsLoadingModel(false);
    }
  }, []);

  /**
   * Drive on-device speech recognition. Audio flows mic → MediaStream →
   * AudioContext → ScriptProcessor → Vosk recognizer, all in the renderer.
   * Final results append to the committed transcript; partial results render
   * as a live tail and get replaced (not appended) on each update.
   */
  const startVoskRecognition = useCallback(async () => {
    if (!modelInstalled) {
      setError('The speech model isn\'t downloaded yet. Click "Download model" first.');
      return;
    }

    let model;
    try {
      model = await loadVoskModel();
    } catch (err) {
      setError(`Could not load the speech model: ${err?.message || err}`);
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      setError('Microphone access denied. Allow it in Windows Settings → Privacy & security → Microphone.');
      return;
    }
    streamRef.current = stream;

    // AudioContext picks its own sample rate (usually 48 kHz). Vosk handles
    // the resample down to the model's training rate internally when given an
    // AudioBuffer, so we don't hard-pin a rate here.
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtor();
    audioCtxRef.current = audioCtx;

    const recognizer = new model.KaldiRecognizer(audioCtx.sampleRate);
    recognizer.setWords(true);
    voskRecognizerRef.current = recognizer;

    // Capture the prefix to extend (any text already in the transcript) so
    // interim/partial results render correctly when the user hits record
    // twice in the same session.
    transcriptBaseRef.current = transcript ? transcript + ' ' : '';
    partialRef.current = '';

    recognizer.on('result', (msg) => {
      const text = msg?.result?.text || '';
      if (!text) return;
      // Final segment: append to the base and reset the interim tail.
      transcriptBaseRef.current = transcriptBaseRef.current + text + ' ';
      partialRef.current = '';
      setTranscript(transcriptBaseRef.current.trimEnd());
    });
    recognizer.on('partialresult', (msg) => {
      const partial = msg?.result?.partial || '';
      partialRef.current = partial;
      setTranscript((transcriptBaseRef.current + partial).trimEnd());
    });
    recognizer.on('error', (msg) => {
      setError(msg?.error || 'Speech recognition error.');
    });

    const source = audioCtx.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated in favour of AudioWorklet but still
    // works in Chromium; the smaller buffer keeps interim results snappy.
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      try {
        const rec = voskRecognizerRef.current;
        if (rec) rec.acceptWaveform(event.inputBuffer);
      } catch (_) { /* recognizer was torn down mid-tick */ }
    };
    // ScriptProcessor only fires while it's part of the audio graph, but we
    // don't want to actually hear the mic — route through a muted gain so the
    // node runs without feeding the speakers.
    const muteGain = audioCtx.createGain();
    muteGain.gain.value = 0;
    source.connect(processor);
    processor.connect(muteGain);
    muteGain.connect(audioCtx.destination);
    processorRef.current = processor;

    setIsRecording(true);
  }, [modelInstalled, loadVoskModel, transcript]);

  const toggleRecording = useCallback(async () => {
    if (isRecording) {
      // Stop whichever pathway is active.
      try { mediaRecorderRef.current?.stop(); } catch (_) {}
      if (voskRecognizerRef.current) stopVoskPipeline();
      setIsRecording(false);
      return;
    }

    setError(null);
    setDetectedLanguage(null);

    if (isClientSide) {
      await startVoskRecognition();
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
  }, [isRecording, language, api, isClientSide, startVoskRecognition, stopVoskPipeline]);

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
      {isClientSide && !modelInstalled && (
        downloadState && downloadState.phase !== 'error' && downloadState.phase !== 'done' ? (
          <div style={{
            padding: 'var(--ds-space-3)',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--ds-space-2)',
            alignItems: 'stretch',
          }}>
            <div style={{ fontSize: 'var(--ds-font-sm)', color: 'var(--ds-text-secondary)' }}>
              Downloading speech model…
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
                width: `${downloadState.total > 0
                  ? Math.min(100, Math.round((downloadState.downloaded / downloadState.total) * 100))
                  : 0}%`,
                background: 'var(--ds-accent)',
                transition: 'width 120ms linear',
              }} />
            </div>
            <div style={{ fontSize: 'var(--ds-font-xs)', color: 'var(--ds-text-dim)' }}>
              {formatBytes(downloadState.downloaded)} of {formatBytes(downloadState.total || 0)}
            </div>
          </div>
        ) : (
          <Callout tone="neutral">
            <div style={{ marginBottom: 'var(--ds-space-2)' }}>
              On-device speech needs a one-time ~40 MB model download. After that
              it works offline with no API key.
            </div>
            <Button variant="primary" onClick={handleDownloadModel}>
              Download model
            </Button>
          </Callout>
        )
      )}

      {/* Record button — disabled while the model is missing or loading, so the
          user can't trigger a doomed recording. */}
      {(!isClientSide || modelInstalled) && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--ds-space-3) 0' }}>
          <button
            onClick={toggleRecording}
            title={isRecording ? 'Stop recording' : 'Start recording'}
            disabled={isLoadingModel}
            style={{
              width: 68,
              height: 68,
              borderRadius: '50%',
              background: isRecording ? 'var(--ds-danger)' : 'var(--ds-accent)',
              border: 'none',
              cursor: isLoadingModel ? 'wait' : 'pointer',
              opacity: isLoadingModel ? 0.6 : 1,
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
      {(!isClientSide || modelInstalled) && (
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
          ) : isLoadingModel ? (
            <span style={{ color: 'var(--ds-accent-cyan)' }}>Loading speech model…</span>
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
