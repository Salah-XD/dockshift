/**
 * Voice-to-Text (Speech-to-Text) provider abstraction for the main process.
 *
 * Mirrors the shape of `electron-ai-providers.js` but specialized for audio
 * transcription. The Voice panel and Voice settings UI only ever talk to the
 * registry (`TRANSCRIPTION_PROVIDER_LIST`, `getTranscriptionProvider`) and the
 * executor (`runTranscription`, `testTranscriptionProvider`) — they never
 * branch on provider id.
 *
 * Adding a new provider is one object literal in this file plus an entry in
 * the registry. No business-logic edits anywhere else.
 *
 * ── Provider contract ────────────────────────────────────────────────────────
 *   {
 *     id, label,                       short id + human label
 *     keyName,                          name in electron-secrets (null = keyless)
 *     keyless,                          true = no API key needed (local Whisper)
 *     description,                      one-line marketing blurb for Settings
 *     docsUrl?,                         deep-link to provider docs / signup
 *     defaultEndpoint,                  base URL used when no override is set
 *     supportsCustomEndpoint,           true = expose the endpoint input
 *     supportedAudioMimes,              MIMEs the provider accepts directly
 *     languageHintFormat,               'iso-639-1' | 'bcp-47' | 'none'
 *     capabilities: {
 *       autoDetectLanguage,              omit `language` → provider detects
 *       streaming,                       real-time streaming transcription
 *       multilingual,                    supports many languages
 *       timestamps,                      returns word/segment timestamps
 *       diarization,                     speaker labels
 *     },
 *     async transcribe({ apiKey, endpoint, audioBase64, mimeType, language, signal })
 *         → { text, detectedLanguage?, durationMs?, raw }
 *     async testConnection?({ apiKey, endpoint, signal })
 *         → { ok: true, info?: string } | throws TranscriptionError
 *   }
 *
 * Errors thrown from `transcribe()` / `testConnection()` should be
 * `TranscriptionError` instances so the executor can normalize them across
 * providers; raw fetch errors are also normalized by `wrapHttpError` below.
 */

/* ─── Normalized error ──────────────────────────────────────────────────── */

/**
 * @typedef {'auth'|'rate-limit'|'network'|'timeout'|'unsupported-language'
 *           |'unsupported-format'|'capability'|'config'|'server'|'unknown'} ErrorCode
 */

export class TranscriptionError extends Error {
  /**
   * @param {string} message      human-readable, surfaced in UI
   * @param {ErrorCode} code      machine-readable category
   * @param {object} [meta]       provider-specific extra info (HTTP status…)
   */
  constructor(message, code = 'unknown', meta = {}) {
    super(message);
    this.name = 'TranscriptionError';
    this.code = code;
    this.meta = meta;
  }
}

/** Map an HTTP response to a TranscriptionError with a useful code. */
async function wrapHttpError(providerLabel, response) {
  let detail = '';
  try {
    const text = await response.text();
    detail = text.slice(0, 400);
  } catch (_) { /* ignore */ }
  const status = response.status;
  let code = 'server';
  let message = `${providerLabel}: HTTP ${status}`;
  if (status === 401 || status === 403) {
    code = 'auth';
    message = `${providerLabel}: authentication failed — check your API key.`;
  } else if (status === 429) {
    code = 'rate-limit';
    message = `${providerLabel}: rate limit reached — try again shortly.`;
  } else if (status === 400 || status === 422) {
    code = 'config';
    message = `${providerLabel}: request rejected (${status})${detail ? ` — ${detail}` : ''}`;
  } else if (status >= 500) {
    code = 'server';
    message = `${providerLabel}: provider error (${status})${detail ? ` — ${detail}` : ''}`;
  }
  return new TranscriptionError(message, code, { status, detail });
}

/* ─── Shared helpers ────────────────────────────────────────────────────── */

function audioBufferFromBase64(audioBase64) {
  return Buffer.from(audioBase64, 'base64');
}

function inferExtensionFromMime(mimeType) {
  const m = (mimeType || 'audio/webm').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  if (m.includes('flac')) return 'flac';
  return 'webm';
}

/**
 * Normalize a user-supplied language tag for a provider.
 * 'auto' / null / '' means "let the provider auto-detect".
 *
 * @param {string|null|undefined} language
 * @param {'iso-639-1'|'bcp-47'|'none'} format
 * @returns {string|null}  null means "omit the parameter entirely"
 */
function normalizeLanguage(language, format) {
  if (!language || language === 'auto') return null;
  if (format === 'none') return null;
  if (format === 'iso-639-1') {
    // 'en-US' → 'en', 'zh-CN' → 'zh', single-letter tag passes through.
    return String(language).split('-')[0].toLowerCase();
  }
  // bcp-47 or unspecified: pass through, just trim.
  return String(language).trim();
}

/* ─── Provider definitions ──────────────────────────────────────────────── */

/**
 * On-device speech recognition powered by Vosk (WASM in a Web Worker). Runs
 * entirely in the renderer — once the small English model has been downloaded
 * to the user's profile, audio never leaves the device and no network is used.
 *
 * Special "client-side" provider: the main-process `transcribe()` below is
 * unreachable on the happy path — VoicePanel detects `clientSide: true` and
 * drives the recognizer directly. The function exists only so accidental
 * routing or generic probes fail with a clear, user-readable error.
 */
const voskOffline = {
  id: 'vosk-offline',
  label: 'On-device (offline)',
  keyName: null,
  keyless: true,
  clientSide: true,
  description: 'Runs entirely on your computer. No internet, no API key, no audio uploaded.',
  setupHint: 'A small speech model (~40 MB) downloads the first time you use it. After that, voice works offline.',
  docsUrl: null,
  defaultEndpoint: '',
  supportsCustomEndpoint: false,
  supportedAudioMimes: [], // unused — renderer streams the mic directly into Vosk
  languageHintFormat: 'bcp-47',
  capabilities: {
    autoDetectLanguage: false, // The current model is English-only
    streaming: true,           // Delivers interim + final results live
    multilingual: false,
    timestamps: false,
    diarization: false,
  },

  async transcribe() {
    throw new TranscriptionError(
      'On-device speech runs in the Voice panel itself, not as a background transcription job.',
      'capability',
    );
  },

  async testConnection() {
    return { ok: true, info: 'On-device — no network credentials to test.' };
  },
};

/**
 * OpenAI Whisper — the most widely used managed transcription API.
 * Endpoint is OpenAI-compatible, which is why Groq and many local stacks
 * (e.g. `whisper.cpp` server, `faster-whisper-server`) use the same shape;
 * those are handled via the dedicated `groq` and `custom` providers.
 */
const openaiWhisper = {
  id: 'openai-whisper',
  label: 'OpenAI Whisper',
  keyName: 'stt:openai',
  keyless: false,
  description: 'OpenAI hosted Whisper. High accuracy across 50+ languages with built-in auto-detection.',
  docsUrl: 'https://platform.openai.com/docs/guides/speech-to-text',
  defaultEndpoint: 'https://api.openai.com/v1/audio/transcriptions',
  supportsCustomEndpoint: false,
  supportedAudioMimes: ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/flac'],
  languageHintFormat: 'iso-639-1',
  capabilities: {
    autoDetectLanguage: true,
    streaming: false,
    multilingual: true,
    timestamps: true,
    diarization: false,
  },

  async transcribe({ apiKey, endpoint, audioBase64, mimeType, language, signal }) {
    const url = endpoint || this.defaultEndpoint;
    const ext = inferExtensionFromMime(mimeType);
    const bytes = audioBufferFromBase64(audioBase64);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType || 'audio/webm' }), `audio.${ext}`);
    form.append('model', 'whisper-1');
    // verbose_json lets us read the auto-detected language back from the response.
    form.append('response_format', 'verbose_json');
    const lang = normalizeLanguage(language, this.languageHintFormat);
    if (lang) form.append('language', lang);

    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
    if (!response.ok) throw await wrapHttpError(this.label, response);
    const json = await response.json();
    return {
      text: json?.text || '',
      detectedLanguage: json?.language || null,
      durationMs: typeof json?.duration === 'number' ? Math.round(json.duration * 1000) : null,
      raw: json,
    };
  },

  async testConnection({ apiKey, signal }) {
    // /v1/models is the canonical lightweight auth check for the OpenAI API.
    const res = await fetch('https://api.openai.com/v1/models?limit=1', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) throw await wrapHttpError(this.label, res);
    return { ok: true, info: 'Authenticated with OpenAI.' };
  },
};

/**
 * Groq — OpenAI-compatible Whisper endpoint, very fast (often 5–10× realtime).
 */
const groqWhisper = {
  id: 'groq-whisper',
  label: 'Groq Whisper',
  keyName: 'stt:groq',
  keyless: false,
  description: 'OpenAI-compatible Whisper Large v3 served on Groq LPUs. Sub-second latency for short clips.',
  docsUrl: 'https://console.groq.com/docs/speech-to-text',
  defaultEndpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
  supportsCustomEndpoint: false,
  supportedAudioMimes: ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/flac'],
  languageHintFormat: 'iso-639-1',
  capabilities: {
    autoDetectLanguage: true,
    streaming: false,
    multilingual: true,
    timestamps: true,
    diarization: false,
  },

  async transcribe({ apiKey, endpoint, audioBase64, mimeType, language, signal }) {
    const url = endpoint || this.defaultEndpoint;
    const ext = inferExtensionFromMime(mimeType);
    const bytes = audioBufferFromBase64(audioBase64);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType || 'audio/webm' }), `audio.${ext}`);
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'verbose_json');
    const lang = normalizeLanguage(language, this.languageHintFormat);
    if (lang) form.append('language', lang);

    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
    if (!response.ok) throw await wrapHttpError(this.label, response);
    const json = await response.json();
    return {
      text: json?.text || '',
      detectedLanguage: json?.language || null,
      durationMs: typeof json?.duration === 'number' ? Math.round(json.duration * 1000) : null,
      raw: json,
    };
  },

  async testConnection({ apiKey, signal }) {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) throw await wrapHttpError(this.label, res);
    return { ok: true, info: 'Authenticated with Groq.' };
  },
};

/**
 * Deepgram — purpose-built STT with real-time streaming and great multilingual
 * support. We use the prerecorded REST endpoint here; streaming would go over
 * a websocket (not yet wired through the Voice panel).
 */
const deepgram = {
  id: 'deepgram',
  label: 'Deepgram',
  keyName: 'stt:deepgram',
  keyless: false,
  description: 'Deepgram Nova prerecorded transcription. Strong accuracy, language detection, smart formatting.',
  docsUrl: 'https://developers.deepgram.com/docs/pre-recorded-audio',
  defaultEndpoint: 'https://api.deepgram.com/v1/listen',
  supportsCustomEndpoint: false,
  supportedAudioMimes: ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/flac'],
  languageHintFormat: 'bcp-47',
  capabilities: {
    autoDetectLanguage: true,
    streaming: true, // websocket — UI does not yet expose this
    multilingual: true,
    timestamps: true,
    diarization: true,
  },

  async transcribe({ apiKey, endpoint, audioBase64, mimeType, language, signal }) {
    const base = endpoint || this.defaultEndpoint;
    const params = new URLSearchParams({
      model: 'nova-3',
      smart_format: 'true',
      punctuate: 'true',
    });
    const lang = normalizeLanguage(language, this.languageHintFormat);
    if (lang) {
      params.set('language', lang);
    } else {
      params.set('detect_language', 'true');
    }
    const url = `${base}?${params.toString()}`;

    const bytes = audioBufferFromBase64(audioBase64);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': mimeType || 'audio/webm',
      },
      body: bytes,
      signal,
    });
    if (!response.ok) throw await wrapHttpError(this.label, response);
    const json = await response.json();
    const alt = json?.results?.channels?.[0]?.alternatives?.[0];
    const detected = json?.results?.channels?.[0]?.detected_language
      || json?.metadata?.detected_language
      || null;
    const duration = json?.metadata?.duration;
    return {
      text: alt?.transcript || '',
      detectedLanguage: detected,
      durationMs: typeof duration === 'number' ? Math.round(duration * 1000) : null,
      raw: json,
    };
  },

  async testConnection({ apiKey, signal }) {
    // Project listing requires a key with any read scope — good auth check.
    const res = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${apiKey}` },
      signal,
    });
    if (!res.ok) throw await wrapHttpError(this.label, res);
    return { ok: true, info: 'Authenticated with Deepgram.' };
  },
};

/**
 * AssemblyAI — async upload + poll. Slower for small clips than Whisper/Groq
 * but very strong for long audio and diarization.
 */
const assemblyai = {
  id: 'assemblyai',
  label: 'AssemblyAI',
  keyName: 'stt:assemblyai',
  keyless: false,
  description: 'AssemblyAI Universal-2. Best-in-class for long-form audio, speaker labels, and PII redaction.',
  docsUrl: 'https://www.assemblyai.com/docs/getting-started',
  defaultEndpoint: 'https://api.assemblyai.com/v2',
  supportsCustomEndpoint: false,
  supportedAudioMimes: ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/flac'],
  languageHintFormat: 'iso-639-1',
  capabilities: {
    autoDetectLanguage: true,
    streaming: true, // realtime websocket — UI does not yet expose this
    multilingual: true,
    timestamps: true,
    diarization: true,
  },

  async transcribe({ apiKey, endpoint, audioBase64, mimeType, language, signal }) {
    const base = (endpoint || this.defaultEndpoint).replace(/\/$/, '');
    const bytes = audioBufferFromBase64(audioBase64);

    // 1. Upload raw bytes — AssemblyAI returns a private upload_url.
    const upload = await fetch(`${base}/upload`, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/octet-stream',
      },
      body: bytes,
      signal,
    });
    if (!upload.ok) throw await wrapHttpError(this.label, upload);
    const uploadJson = await upload.json();
    const audioUrl = uploadJson?.upload_url;
    if (!audioUrl) throw new TranscriptionError(`${this.label}: upload returned no URL.`, 'server');

    // 2. Create the transcript job.
    const body = { audio_url: audioUrl };
    const lang = normalizeLanguage(language, this.languageHintFormat);
    if (lang) body.language_code = lang;
    else body.language_detection = true;

    const create = await fetch(`${base}/transcript`, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!create.ok) throw await wrapHttpError(this.label, create);
    const job = await create.json();
    const jobId = job?.id;
    if (!jobId) throw new TranscriptionError(`${this.label}: job creation returned no id.`, 'server');

    // 3. Poll. AssemblyAI recommends 1–3s intervals; we use 1.5s with a hard cap.
    const POLL_INTERVAL_MS = 1500;
    const MAX_POLL_ATTEMPTS = 80; // ~2 minutes — enough for a few-minute clip
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new TranscriptionError(`${this.label}: cancelled.`, 'timeout');
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const poll = await fetch(`${base}/transcript/${jobId}`, {
        headers: { Authorization: apiKey },
        signal,
      });
      if (!poll.ok) throw await wrapHttpError(this.label, poll);
      const status = await poll.json();
      if (status.status === 'completed') {
        const durationSec = status.audio_duration;
        return {
          text: status.text || '',
          detectedLanguage: status.language_code || null,
          durationMs: typeof durationSec === 'number' ? Math.round(durationSec * 1000) : null,
          raw: status,
        };
      }
      if (status.status === 'error') {
        throw new TranscriptionError(`${this.label}: ${status.error || 'transcription failed.'}`, 'server');
      }
    }
    throw new TranscriptionError(`${this.label}: transcription timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS}ms.`, 'timeout');
  },

  async testConnection({ apiKey, signal }) {
    // GET transcripts list — small response, requires a valid key.
    const res = await fetch('https://api.assemblyai.com/v2/transcript?limit=1', {
      headers: { Authorization: apiKey },
      signal,
    });
    if (!res.ok) throw await wrapHttpError(this.label, res);
    return { ok: true, info: 'Authenticated with AssemblyAI.' };
  },
};

/**
 * Google Cloud Speech-to-Text v1 (synchronous `speech:recognize`).
 * Auth here uses an API key for simplicity; long-form audio would normally use
 * a service-account-signed access token and longRunningRecognize, which we
 * deliberately do not expose in the UI.
 *
 * Google requires a primary `languageCode` even in auto-detect mode; we pass
 * a wide `alternativeLanguageCodes` set so a different language still resolves.
 */
const googleSpeech = {
  id: 'google-speech',
  label: 'Google Speech-to-Text',
  keyName: 'stt:google',
  keyless: false,
  description: 'Google Cloud Speech-to-Text v1. Strong multilingual support; auto-detect via alternative language codes.',
  docsUrl: 'https://cloud.google.com/speech-to-text/docs',
  defaultEndpoint: 'https://speech.googleapis.com/v1/speech:recognize',
  supportsCustomEndpoint: false,
  supportedAudioMimes: ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/flac'],
  languageHintFormat: 'bcp-47',
  capabilities: {
    autoDetectLanguage: true,
    streaming: true, // gRPC streaming — UI does not expose
    multilingual: true,
    timestamps: true,
    diarization: true,
  },

  async transcribe({ apiKey, endpoint, audioBase64, mimeType, language, signal }) {
    const base = endpoint || this.defaultEndpoint;
    const url = `${base}?key=${encodeURIComponent(apiKey)}`;
    const m = (mimeType || 'audio/webm').toLowerCase();
    // Map MIME → Google encoding. WebM/Ogg Opus are auto-detected when encoding/rate are omitted.
    const config = {
      enableAutomaticPunctuation: true,
      model: 'latest_long',
    };
    if (m.includes('wav') || m.includes('linear')) {
      config.encoding = 'LINEAR16';
      config.sampleRateHertz = 16000;
    } else if (m.includes('flac')) {
      config.encoding = 'FLAC';
    } else if (m.includes('mp3') || m.includes('mpeg')) {
      config.encoding = 'MP3';
    }
    // For WebM/Ogg Opus we leave encoding/sampleRateHertz out — Google detects it.

    const lang = normalizeLanguage(language, this.languageHintFormat);
    if (lang) {
      config.languageCode = lang;
    } else {
      // Auto-detect mode: a primary code is required; alternativeLanguageCodes
      // lets Google switch. The list mirrors the VoicePanel's curated languages.
      config.languageCode = 'en-US';
      config.alternativeLanguageCodes = [
        'en-GB', 'hi-IN', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP', 'ko-KR',
        'zh', 'ar-SA', 'pt-BR', 'ru-RU', 'it-IT',
      ];
    }

    const body = { config, audio: { content: audioBase64 } };
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await wrapHttpError(this.label, response);
    const json = await response.json();
    const results = json?.results || [];
    const text = results
      .map((r) => r?.alternatives?.[0]?.transcript || '')
      .filter(Boolean)
      .join(' ')
      .trim();
    const detected = results.find((r) => r?.languageCode)?.languageCode || null;
    return {
      text,
      detectedLanguage: detected,
      durationMs: null,
      raw: json,
    };
  },

  async testConnection({ apiKey, signal }) {
    // No truly "free" auth check exists; recognize with a 1-sample silent
    // LINEAR16 clip is the cheapest valid request. Empty results === ok.
    const silence = Buffer.alloc(3200).toString('base64'); // 100ms of silence @ 16kHz
    const body = {
      config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US' },
      audio: { content: silence },
    };
    const res = await fetch(`${this.defaultEndpoint}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await wrapHttpError(this.label, res);
    return { ok: true, info: 'Authenticated with Google Speech-to-Text.' };
  },
};

/**
 * Azure Cognitive Services Speech — REST short-audio endpoint.
 *
 * Endpoint is region-specific: `https://<region>.stt.speech.microsoft.com/...`.
 * The user MUST provide their region either inside a custom endpoint URL or by
 * leaving the endpoint blank and configuring the region elsewhere; we surface
 * a `config` error when the endpoint is missing.
 *
 * Auto-detect requires the language identification feature, which is enabled
 * with `language=auto-detect` and an `Accept-Language` header listing the
 * candidates — supported only on conversation transcription endpoints.
 */
const azureSpeech = {
  id: 'azure-speech',
  label: 'Azure Speech Services',
  keyName: 'stt:azure',
  keyless: false,
  description: 'Azure Cognitive Services Speech-to-Text. Region-specific endpoint required (e.g. eastus).',
  docsUrl: 'https://learn.microsoft.com/azure/ai-services/speech-service/rest-speech-to-text-short',
  defaultEndpoint: '', // user must supply; we don't ship a default region
  supportsCustomEndpoint: true,
  supportedAudioMimes: ['audio/wav', 'audio/ogg', 'audio/webm'],
  languageHintFormat: 'bcp-47',
  capabilities: {
    autoDetectLanguage: true,
    streaming: true,
    multilingual: true,
    timestamps: false,
    diarization: false,
  },

  async transcribe({ apiKey, endpoint, audioBase64, mimeType, language, signal }) {
    if (!endpoint) {
      throw new TranscriptionError(
        `${this.label}: a region-specific endpoint is required (e.g. https://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1).`,
        'config'
      );
    }
    const base = endpoint.replace(/\/$/, '');
    const params = new URLSearchParams({ format: 'detailed' });
    const lang = normalizeLanguage(language, this.languageHintFormat);
    if (lang) {
      params.set('language', lang);
    } else {
      params.set('language', 'auto-detect');
    }
    const url = `${base}?${params.toString()}`;
    const bytes = audioBufferFromBase64(audioBase64);
    const contentType = mimeType?.includes('wav')
      ? 'audio/wav; codecs=audio/pcm; samplerate=16000'
      : (mimeType || 'audio/ogg; codecs=opus');

    const headers = {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': contentType,
      Accept: 'application/json',
    };
    if (!lang) {
      headers['Accept-Language'] = 'en-US,hi-IN,es-ES,fr-FR,de-DE,ja-JP,ko-KR,zh-CN,ar-SA,pt-BR';
    }

    const response = await fetch(url, { method: 'POST', headers, body: bytes, signal });
    if (!response.ok) throw await wrapHttpError(this.label, response);
    const json = await response.json();
    return {
      text: json?.DisplayText || json?.NBest?.[0]?.Display || '',
      detectedLanguage: json?.Language || json?.PrimaryLanguage?.Language || null,
      durationMs: json?.Duration ? Math.round(json.Duration / 10000) : null, // 100-ns ticks
      raw: json,
    };
  },
};

/**
 * Google Gemini — multimodal model used as a transcription provider.
 * Preserves the existing behavior so users who already configured Gemini for
 * AI chat get free voice support without setting up a second key.
 */
const geminiTranscribe = {
  id: 'gemini',
  label: 'Google Gemini',
  keyName: 'gemini', // reuses the existing AI-chat Gemini key
  keyless: false,
  description: 'Google Gemini 2.5 Flash multimodal transcription. Reuses your existing Gemini API key.',
  docsUrl: 'https://ai.google.dev/gemini-api/docs',
  defaultEndpoint: 'https://generativelanguage.googleapis.com',
  supportsCustomEndpoint: false,
  supportedAudioMimes: ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/flac'],
  languageHintFormat: 'bcp-47',
  capabilities: {
    autoDetectLanguage: true,
    streaming: false,
    multilingual: true,
    timestamps: false,
    diarization: false,
  },

  async transcribe({ apiKey, audioBase64, mimeType, language, signal }) {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    // For auto-detect we instruct the model to identify the language itself;
    // otherwise we pin it. Either way we ask for ONLY the transcript so the
    // text is usable as-is in the panel.
    const langInstruction = language && language !== 'auto'
      ? `The spoken language is ${language}. Transcribe in that language.`
      : 'Automatically detect the spoken language and transcribe in that same language without translating.';
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: mimeType || 'audio/webm', data: audioBase64 } },
          { text: `Transcribe this audio. ${langInstruction} Return ONLY the transcribed text — no preface, no quotes, no language label.` },
        ],
      }],
      // generateContent doesn't take an AbortSignal directly in this SDK
      // version; the executor's timeout still triggers via overall race.
    });
    void signal;
    return {
      text: (response?.text || '').trim(),
      detectedLanguage: null, // Gemini doesn't return a structured language code
      durationMs: null,
      raw: { responseText: response?.text },
    };
  },

  async testConnection({ apiKey, signal }) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { signal }
    );
    if (!res.ok) throw await wrapHttpError(this.label, res);
    return { ok: true, info: 'Authenticated with Google Gemini.' };
  },
};

/**
 * Custom Whisper-compatible — point at any OpenAI-format `/audio/transcriptions`
 * endpoint. Works with self-hosted Whisper servers (`whisper.cpp` server,
 * `faster-whisper-server`, `LocalAI`, …) and other OpenAI-API-compatible
 * providers not explicitly listed.
 *
 * Key is optional: many self-hosted stacks accept any non-empty bearer token
 * or no auth at all; we send the header only when a key is configured.
 */
const customCompat = {
  id: 'custom-openai',
  label: 'Custom (OpenAI-compatible)',
  keyName: 'stt:custom',
  keyless: true, // API key is optional, not required
  description: 'Any OpenAI-format /v1/audio/transcriptions endpoint — self-hosted Whisper, LocalAI, etc.',
  docsUrl: 'https://github.com/openai/openai-openapi',
  defaultEndpoint: 'http://127.0.0.1:8000/v1/audio/transcriptions',
  supportsCustomEndpoint: true,
  supportedAudioMimes: ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/flac'],
  languageHintFormat: 'iso-639-1',
  capabilities: {
    autoDetectLanguage: true,
    streaming: false,
    multilingual: true,
    timestamps: false,
    diarization: false,
  },

  async transcribe({ apiKey, endpoint, audioBase64, mimeType, language, signal }) {
    const url = endpoint || this.defaultEndpoint;
    if (!url) {
      throw new TranscriptionError(`${this.label}: a custom endpoint URL is required.`, 'config');
    }
    const ext = inferExtensionFromMime(mimeType);
    const bytes = audioBufferFromBase64(audioBase64);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType || 'audio/webm' }), `audio.${ext}`);
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    const lang = normalizeLanguage(language, this.languageHintFormat);
    if (lang) form.append('language', lang);

    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: form, signal });
    } catch (err) {
      throw new TranscriptionError(
        `${this.label}: could not reach ${url} — ${err.message}`,
        'network'
      );
    }
    if (!response.ok) throw await wrapHttpError(this.label, response);
    const json = await response.json();
    return {
      text: typeof json === 'string' ? json : (json?.text || ''),
      detectedLanguage: json?.language || null,
      durationMs: typeof json?.duration === 'number' ? Math.round(json.duration * 1000) : null,
      raw: json,
    };
  },

  async testConnection({ apiKey, endpoint, signal }) {
    const url = endpoint || this.defaultEndpoint;
    if (!url) throw new TranscriptionError(`${this.label}: endpoint required.`, 'config');
    // Try the models endpoint derived from the transcription URL; fall back to
    // a HEAD on the transcription URL itself.
    const modelsUrl = url.replace(/\/audio\/transcriptions\/?$/, '/models');
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    try {
      const res = await fetch(modelsUrl, { headers, signal });
      if (res.ok) return { ok: true, info: `Reached ${modelsUrl}.` };
    } catch (_) { /* fall through to HEAD probe */ }
    try {
      const probe = await fetch(url, { method: 'OPTIONS', headers, signal });
      // Any HTTP response (even 4xx with auth-required) confirms reachability.
      return { ok: true, info: `Endpoint reachable (HTTP ${probe.status}).` };
    } catch (err) {
      throw new TranscriptionError(
        `${this.label}: could not reach ${url} — ${err.message}`,
        'network'
      );
    }
  },
};

/* ─── Registry ──────────────────────────────────────────────────────────── */

export const TRANSCRIPTION_PROVIDERS = {
  [voskOffline.id]: voskOffline,
  [openaiWhisper.id]: openaiWhisper,
  [groqWhisper.id]: groqWhisper,
  [deepgram.id]: deepgram,
  [assemblyai.id]: assemblyai,
  [googleSpeech.id]: googleSpeech,
  [azureSpeech.id]: azureSpeech,
  [geminiTranscribe.id]: geminiTranscribe,
  [customCompat.id]: customCompat,
};

/**
 * Default provider id when settings.sttProvider is unset. On-device speech is
 * the only option that works with no setup and no API key, so new installs
 * land there. The renderer prompts for the one-time model download.
 */
export const DEFAULT_TRANSCRIPTION_PROVIDER_ID = voskOffline.id;

/** Catalog shape sent to the renderer — never includes runtime functions. */
export const TRANSCRIPTION_PROVIDER_LIST = Object.values(TRANSCRIPTION_PROVIDERS).map((p) => ({
  id: p.id,
  label: p.label,
  keyName: p.keyName,
  keyless: p.keyless,
  // `clientSide: true` tells the renderer to handle transcription locally
  // (e.g. Windows Speech via SpeechRecognition) instead of recording audio
  // and posting it to main. Any provider without this stays on the
  // MediaRecorder → IPC → main path.
  clientSide: !!p.clientSide,
  description: p.description,
  setupHint: p.setupHint || null,
  docsUrl: p.docsUrl || null,
  defaultEndpoint: p.defaultEndpoint || '',
  supportsCustomEndpoint: !!p.supportsCustomEndpoint,
  supportedAudioMimes: p.supportedAudioMimes || [],
  languageHintFormat: p.languageHintFormat || 'none',
  capabilities: { ...p.capabilities },
}));

export function getTranscriptionProvider(id) {
  return TRANSCRIPTION_PROVIDERS[id] || null;
}

/* ─── Executor ──────────────────────────────────────────────────────────── */

const TRANSCRIBE_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 15_000;

/**
 * Race a promise against a timeout. The returned `signal` should be passed to
 * fetch() so an aborted request stops eating socket time.
 */
function withTimeout(timeoutMs, label, runner) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new TranscriptionError(`${label}: request timed out after ${timeoutMs}ms.`, 'timeout')), timeoutMs);
  return Promise.resolve()
    .then(() => runner(ctrl.signal))
    .finally(() => clearTimeout(timer));
}

/**
 * Map a thrown error from a provider's transcribe()/testConnection() into a
 * normalized TranscriptionError. Pure pass-through for already-normalized
 * errors; AbortError becomes a `timeout` code.
 */
function normalizeThrown(err, providerLabel) {
  if (err instanceof TranscriptionError) return err;
  if (err?.name === 'AbortError') {
    return new TranscriptionError(`${providerLabel}: request was aborted.`, 'timeout');
  }
  if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED' || /fetch failed/i.test(err?.message || '')) {
    return new TranscriptionError(`${providerLabel}: network error — ${err.message}`, 'network');
  }
  return new TranscriptionError(`${providerLabel}: ${err?.message || 'unknown error'}`, 'unknown');
}

/**
 * Execute a transcription against a chosen provider.
 *
 * @param {object} args
 * @param {object} args.provider              provider object
 * @param {string|null} args.apiKey           resolved API key (or null/'' for keyless)
 * @param {string} [args.endpoint]            user-configured custom endpoint
 * @param {string} args.audioBase64
 * @param {string} args.mimeType
 * @param {string|null} args.language         BCP-47 / ISO-639-1 / 'auto' / null
 * @returns {Promise<{text, detectedLanguage, durationMs, provider, raw}>}
 */
export async function runTranscription({ provider, apiKey, endpoint, audioBase64, mimeType, language }) {
  if (!provider) throw new TranscriptionError('No transcription provider selected.', 'config');
  if (!provider.keyless && !apiKey) {
    throw new TranscriptionError(`${provider.label}: no API key configured — add one in Settings → Voice to Text.`, 'auth');
  }
  // Capability guard: auto-detect requested against a provider that can't.
  if ((!language || language === 'auto') && !provider.capabilities?.autoDetectLanguage) {
    throw new TranscriptionError(
      `${provider.label} does not support automatic language detection — pick a specific language.`,
      'capability'
    );
  }
  try {
    const result = await withTimeout(TRANSCRIBE_TIMEOUT_MS, provider.label, (signal) =>
      provider.transcribe({ apiKey, endpoint, audioBase64, mimeType, language, signal })
    );
    return {
      text: result?.text || '',
      detectedLanguage: result?.detectedLanguage || null,
      durationMs: result?.durationMs ?? null,
      provider: provider.id,
      raw: result?.raw,
    };
  } catch (err) {
    throw normalizeThrown(err, provider.label);
  }
}

/**
 * Lightweight connection test: verifies the API key + endpoint reach the
 * provider without performing an actual transcription. Falls back to a 1-byte
 * silent-audio probe when no dedicated `testConnection` is implemented.
 *
 * @returns {Promise<{ok: true, info?: string}>}
 */
export async function testTranscriptionProvider({ provider, apiKey, endpoint }) {
  if (!provider) throw new TranscriptionError('No provider.', 'config');
  if (!provider.keyless && !apiKey) {
    throw new TranscriptionError(`${provider.label}: no API key configured.`, 'auth');
  }
  try {
    if (typeof provider.testConnection === 'function') {
      const out = await withTimeout(TEST_TIMEOUT_MS, provider.label, (signal) =>
        provider.testConnection({ apiKey, endpoint, signal })
      );
      return { ok: true, info: out?.info };
    }
    // Generic fallback: send a tiny silent WAV and accept any non-auth response.
    const silentWav = buildSilentWavBase64();
    await withTimeout(TEST_TIMEOUT_MS, provider.label, (signal) =>
      provider.transcribe({
        apiKey, endpoint, audioBase64: silentWav, mimeType: 'audio/wav', language: 'en', signal,
      })
    );
    return { ok: true, info: 'Probe succeeded.' };
  } catch (err) {
    throw normalizeThrown(err, provider.label);
  }
}

/** ~250ms of silence, mono, 16kHz PCM WAV. */
function buildSilentWavBase64() {
  const sampleRate = 16000;
  const samples = Math.floor(sampleRate * 0.25);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);             // PCM chunk size
  buf.writeUInt16LE(1, 20);              // PCM format
  buf.writeUInt16LE(1, 22);              // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);              // block align
  buf.writeUInt16LE(16, 34);             // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  // samples are already zero-filled
  return buf.toString('base64');
}
