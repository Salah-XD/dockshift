import { useCallback, useRef, useState } from 'react';

/**
 * Capture the microphone as mono Float32 PCM in the renderer, for the
 * `localNative` (sherpa-onnx) transcription path.
 *
 * Unlike the cloud path (MediaRecorder → webm container → base64), this
 * accumulates the whole utterance as raw Float32 samples and returns them on
 * stop. Main base64-decodes
 * them and feeds the engine directly — sherpa resamples to 16 kHz internally, so
 * we keep the AudioContext's native rate and report it alongside the samples.
 *
 * @returns {{ start: () => Promise<void>, stop: () => {samples: Float32Array, sampleRate: number},
 *             cancel: () => void, isCapturing: boolean, level: number }}
 */
export function useMicPcm() {
  const [isCapturing, setIsCapturing] = useState(false);
  const [level, setLevel] = useState(0); // 0..1 RMS for a live meter

  const streamRef = useRef(null);
  const ctxRef = useRef(null);
  const processorRef = useRef(null);
  const gainRef = useRef(null);
  const chunksRef = useRef([]);
  const sampleRateRef = useRef(0);

  const teardown = useCallback(() => {
    if (processorRef.current) {
      try { processorRef.current.disconnect(); } catch (_) {}
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (gainRef.current) { try { gainRef.current.disconnect(); } catch (_) {} gainRef.current = null; }
    if (ctxRef.current) { try { ctxRef.current.close(); } catch (_) {} ctxRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    streamRef.current = stream;

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtor();
    ctxRef.current = ctx;
    sampleRateRef.current = ctx.sampleRate;
    chunksRef.current = [];

    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated but works reliably in Chromium/Electron.
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      // Copy — Web Audio reuses the underlying buffer each tick.
      chunksRef.current.push(new Float32Array(input));
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      setLevel(Math.min(1, Math.sqrt(sum / input.length) * 4));
    };

    // Route through a muted gain so the processor runs without echoing the mic.
    const muteGain = ctx.createGain();
    muteGain.gain.value = 0;
    gainRef.current = muteGain;
    source.connect(processor);
    processor.connect(muteGain);
    muteGain.connect(ctx.destination);
    processorRef.current = processor;

    setIsCapturing(true);
  }, []);

  const stop = useCallback(() => {
    const chunks = chunksRef.current;
    const sampleRate = sampleRateRef.current;
    teardown();
    setIsCapturing(false);
    setLevel(0);

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const samples = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { samples.set(c, off); off += c.length; }
    chunksRef.current = [];
    return { samples, sampleRate };
  }, [teardown]);

  const cancel = useCallback(() => {
    teardown();
    chunksRef.current = [];
    setIsCapturing(false);
    setLevel(0);
  }, [teardown]);

  return { start, stop, cancel, isCapturing, level };
}

/**
 * Base64-encode a Float32Array's raw little-endian bytes — the payload the
 * localNative providers expect as `audio` (with `pcm: true` + `sampleRate`).
 * Chunked to avoid blowing the call stack on long clips.
 */
export function float32ToBase64(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
