import { useCallback, useEffect, useRef, useState } from 'react';
import { useMicPcm, float32ToBase64 } from '../hooks/useMicPcm';
import { MicIcon, XIcon } from './ui';

/**
 * The global dictation pill (Voice Phase 2). Renders in its own non-activating
 * BrowserWindow (`#pill` route). The main process drives the lifecycle over push
 * channels: `voice:pill:start` (hotkey pressed → begin capture) and
 * `voice:pill:stop` (pressed again → finalize). On stop we transcribe the PCM via
 * `voice:pill:transcribe`, which also auto-inserts the text into the focused app
 * and returns whether it pasted. A brief ✓/✗ flash, then we ask main to hide us.
 *
 * States: idle → warming → listening → transcribing → done | error → idle.
 */
export default function VoicePill() {
  const api = window.electronAPI;
  const mic = useMicPcm();
  const { start: micStart, stop: micStop, cancel: micCancel, level } = mic;

  const [state, setState] = useState('idle');
  const [message, setMessage] = useState('');
  const [pasted, setPasted] = useState(false);
  // Guards a double-finalize (e.g. a stray second 'stop' while transcribing).
  const busyRef = useRef(false);

  // This window is transparent — strip any inherited app background so only the
  // pill's own rounded box paints.
  useEffect(() => {
    const root = document.getElementById('root');
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    if (root) root.style.background = 'transparent';
  }, []);

  const dismissAfter = useCallback((ms) => {
    setTimeout(() => {
      busyRef.current = false;
      setState('idle');
      api?.invoke?.('voice:pill:dismiss').catch(() => {});
    }, ms);
  }, [api]);

  const finalize = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;

    let samples, sampleRate;
    try { ({ samples, sampleRate } = micStop()); } catch { samples = null; }
    if (!samples || !samples.length) {
      busyRef.current = false;
      setState('idle');
      api?.invoke?.('voice:pill:dismiss').catch(() => {});
      return;
    }

    setState('transcribing');
    try {
      const res = await api.invoke('voice:pill:transcribe', {
        audio: float32ToBase64(samples),
        pcm: true,
        sampleRate,
      });
      if (res?.ok && res.text) {
        setPasted(!!res.pasted);
        setMessage(res.pasted ? 'Inserted' : 'Copied to clipboard');
        setState('done');
      } else {
        setMessage(res?.error ? 'Couldn’t transcribe' : 'No speech detected');
        setState('error');
      }
    } catch (err) {
      setMessage(err?.message || 'Transcription failed');
      setState('error');
    }
    dismissAfter(1100);
  }, [api, micStop, dismissAfter]);

  // Subscribe once to the main-process lifecycle pushes. micStart/micStop are
  // stable useCallbacks, so this binds a single listener pair for the window.
  useEffect(() => {
    if (!api?.on) return undefined;
    const offStart = api.on('voice:pill:start', async () => {
      setMessage('');
      setPasted(false);
      busyRef.current = false;
      setState('warming');
      try {
        await micStart();
        setState('listening');
      } catch {
        setMessage('Microphone unavailable');
        setState('error');
        dismissAfter(1300);
      }
    });
    const offStop = api.on('voice:pill:stop', () => { finalize(); });
    return () => { try { offStart?.(); } catch (_) {} try { offStop?.(); } catch (_) {} };
  }, [api, micStart, finalize, dismissAfter]);

  const cancel = useCallback(() => {
    try { micCancel(); } catch (_) {}
    busyRef.current = false;
    setState('idle');
    api?.invoke?.('voice:pill:cancel').catch(() => {});
  }, [api, micCancel]);

  if (state === 'idle') return null;

  const isListening = state === 'listening' || state === 'warming';
  const accent = state === 'error' ? '#ff5c5c' : state === 'done' ? '#3ecf8e' : '#6aa3ff';

  return (
    <div
      style={{
        WebkitAppRegion: 'drag',
        userSelect: 'none',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 8,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          minWidth: 220,
          maxWidth: 320,
          borderRadius: 999,
          background: 'rgba(20, 22, 28, 0.94)',
          border: `1px solid ${accent}55`,
          boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
          color: '#e8eaee',
          fontSize: 13,
          fontFamily: 'system-ui, sans-serif',
          backdropFilter: 'blur(8px)',
        }}
      >
        {/* Status glyph / level meter */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, flexShrink: 0, color: accent }}>
          {state === 'transcribing' ? (
            <span style={{ width: 16, height: 16, border: `2px solid ${accent}`, borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} />
          ) : state === 'done' ? (
            <span style={{ fontSize: 18, fontWeight: 700 }}>✓</span>
          ) : state === 'error' ? (
            <span style={{ fontSize: 18, fontWeight: 700 }}>✕</span>
          ) : (
            <MicIcon size={18} />
          )}
        </div>

        {/* Live level bars while listening */}
        {isListening && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, height: 22, flex: 1 }}>
            {[0, 1, 2, 3, 4, 5, 6].map((i) => {
              const phase = Math.abs(((i % 4) - 1.5)) / 1.5; // center bars taller
              const h = state === 'warming' ? 4 : Math.max(3, Math.min(22, 4 + level * 28 * (1 - 0.4 * phase)));
              return (
                <span key={i} style={{ width: 3, height: h, borderRadius: 2, background: accent, transition: 'height 80ms linear', opacity: 0.85 }} />
              );
            })}
          </div>
        )}

        {/* Status text */}
        <div style={{ flex: isListening ? '0 0 auto' : 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#c7cbd2' }}>
          {state === 'warming' && 'Warming up…'}
          {state === 'listening' && 'Listening…'}
          {state === 'transcribing' && 'Transcribing…'}
          {(state === 'done' || state === 'error') && message}
        </div>

        {/* Cancel (no-drag so the click lands) */}
        {isListening && (
          <button
            onClick={cancel}
            title="Cancel"
            style={{
              WebkitAppRegion: 'no-drag',
              flexShrink: 0,
              width: 22,
              height: 22,
              borderRadius: '50%',
              border: 'none',
              cursor: 'pointer',
              background: 'rgba(255,255,255,0.08)',
              color: '#c7cbd2',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <XIcon size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
