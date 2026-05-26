import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { HEADER_STYLE, TITLE_STYLE } from '../hooks/usePanelPosition';
import ResizablePanel from './ResizablePanel';
import { Button, IconButton, Badge, XIcon, SparkleIcon, KeyIcon, ArrowUpIcon, RefreshIcon } from './ui';
import '../styles/panels.css';

// Developer-focused quick actions — each prepends a task-specific instruction
// to whatever is on the clipboard (code, an error, a diff).
const QUICK_ACTIONS = [
  { label: 'Explain code', prefix: 'Explain what the following code does, step by step:\n\n' },
  { label: 'Write tests', prefix: 'Write unit tests for the following code. Match the conventions and style visible in the code:\n\n' },
  { label: 'Fix error', prefix: 'Here is an error message or stack trace. Explain the likely cause and how to fix it:\n\n' },
  { label: 'Review', prefix: 'Review the following code for bugs, edge cases, and possible improvements. Be concise and specific:\n\n' },
  { label: 'Add docs', prefix: 'Add clear doc comments to the following code. Return only the updated code:\n\n' },
  { label: 'Add types', prefix: 'Add type annotations to the following code. Return only the updated code:\n\n' },
];

function TypingIndicator() {
  return (
    <div style={{ display: 'flex', gap: 5, padding: '6px 0', alignItems: 'center' }}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--ds-accent)',
            animation: `aiDot${i} 1.4s infinite ease-in-out`,
          }}
        />
      ))}
    </div>
  );
}

export default function AiPanel({ isOpen, onClose, anchorRect }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  // 'checking' until ai:status resolves, then 'ok' or 'missing'
  const [keyStatus, setKeyStatus] = useState('checking');
  // Label of the active provider, shown in the header (e.g. "OpenAI").
  const [providerLabel, setProviderLabel] = useState('');
  const panelRef = useRef(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const api = useMemo(() => window.electronAPI, []);
  // Tracks the in-flight stream so chunk/done/error events can be matched to it.
  const activeStreamRef = useRef(null);

  // If the user closes the AI panel while a stream is in flight, tell main
  // to abort it. Otherwise the provider keeps streaming (and consuming tokens)
  // until the idle timeout fires — wasteful, and on closed-source providers,
  // expensive.
  useEffect(() => {
    if (isOpen) return;
    const streamId = activeStreamRef.current;
    if (!streamId) return;
    activeStreamRef.current = null;
    api?.invoke?.('ai:streamAbort', { streamId })?.catch(() => {});
    setLoading(false);
  }, [isOpen, api]);

  // Re-check provider/key status whenever the panel opens — the user may have
  // switched providers or added a key in Settings since it was last open.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setKeyStatus('checking');
    api.invoke('ai:status')
      .then((res) => {
        if (cancelled) return;
        setKeyStatus(res?.hasKey ? 'ok' : 'missing');
        setProviderLabel(res?.providerLabel || '');
      })
      .catch(() => { if (!cancelled) setKeyStatus('missing'); });
    return () => { cancelled = true; };
  }, [isOpen, api]);

  // Subscribe once to the streaming push channels. Events are tagged with a
  // streamId; we only act on the one we started, so a stale stream from a
  // previous turn can't write into the current bubble.
  useEffect(() => {
    if (!api.onAiStream) return undefined;
    return api.onAiStream({
      onChunk: ({ streamId, delta }) => {
        if (streamId !== activeStreamRef.current) return;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'ai' && last.streaming) {
            next[next.length - 1] = { ...last, text: last.text + delta };
          }
          return next;
        });
      },
      onDone: ({ streamId, text }) => {
        if (streamId !== activeStreamRef.current) return;
        activeStreamRef.current = null;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'ai' && last.streaming) {
            // Prefer the final text from main (in case any chunk was missed).
            next[next.length - 1] = { role: 'ai', text: text || last.text };
          }
          return next;
        });
        setLoading(false);
      },
      onError: ({ streamId, error }) => {
        if (streamId !== activeStreamRef.current) return;
        activeStreamRef.current = null;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          // Replace the empty streaming bubble with an error bubble that keeps
          // the prompt so the user can retry it.
          if (last && last.role === 'ai' && last.streaming) {
            next[next.length - 1] = {
              role: 'ai',
              text: `Error: ${error || 'Failed to get response'}`,
              error: true,
              retryPrompt: last.retryPrompt,
            };
          }
          return next;
        });
        setLoading(false);
      },
    });
  }, [api]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  // Focus input on open
  useEffect(() => {
    if (isOpen && keyStatus === 'ok' && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, keyStatus]);

  const sendMessage = useCallback(async (text) => {
    const msg = text || input.trim();
    if (!msg || loading) return;
    setInput('');
    // Append the user turn and an empty AI bubble that streamed chunks fill in.
    setMessages((prev) => [
      ...prev,
      { role: 'user', text: msg },
      { role: 'ai', text: '', streaming: true, retryPrompt: msg },
    ]);
    setLoading(true);
    try {
      const { streamId } = await api.invoke('ai:chatStream', { prompt: msg });
      activeStreamRef.current = streamId;
    } catch (err) {
      // The invoke itself failed (rare) — convert the placeholder to an error.
      activeStreamRef.current = null;
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'ai' && last.streaming) {
          next[next.length - 1] = {
            role: 'ai',
            text: `Error: ${err.message || 'Failed to get response'}`,
            error: true,
            retryPrompt: msg,
          };
        }
        return next;
      });
      setLoading(false);
    }
  }, [input, loading, api]);

  // Retry a failed prompt: drop the error bubble, then resend.
  const retryMessage = useCallback((index, prompt) => {
    setMessages((prev) => prev.filter((_, i) => i !== index));
    sendMessage(prompt);
  }, [sendMessage]);

  const handleQuickAction = useCallback(async (action) => {
    let clipContent = '';
    try {
      clipContent = await navigator.clipboard.readText();
    } catch (_) { /* clipboard unavailable */ }
    const text = action.prefix + (clipContent || '[paste your content here]');
    setInput(text);
    // Focus and move cursor to end
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.setSelectionRange(text.length, text.length);
      }
    }, 50);
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  if (!isOpen || !anchorRect) return null;

  const canSend = !!input.trim() && !loading && keyStatus === 'ok';

  const panel = (
    <ResizablePanel isOpen={isOpen} dockAction="sparkle">
      {/* Header */}
      <div style={HEADER_STYLE}>
        <span style={{ ...TITLE_STYLE, display: 'flex', alignItems: 'center', gap: 'var(--ds-space-2)' }}>
          AI Assistant
          {providerLabel && keyStatus === 'ok' && <Badge tone="neutral">{providerLabel}</Badge>}
        </span>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setMessages([])}>Clear</Button>
        )}
        <IconButton variant="danger" title="Close" onClick={onClose}>
          <XIcon size={14} />
        </IconButton>
      </div>

      {/* Quick Actions (shown when no messages and the AI is usable) */}
      {messages.length === 0 && keyStatus === 'ok' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--ds-space-2)', flexShrink: 0 }}>
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.label}
              onClick={() => handleQuickAction(a)}
              className="ai-quick-action"
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--ds-space-3)',
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--ds-scrollbar-thumb) transparent',
        }}
      >
        {messages.length === 0 && !loading && keyStatus === 'ok' && (
          <div style={{ textAlign: 'center', padding: 'var(--ds-space-8)', animation: 'fadeInUp 0.4s ease' }}>
            <div style={{ color: 'var(--ds-accent-light)', marginBottom: 'var(--ds-space-3)' }}>
              <SparkleIcon size={28} />
            </div>
            <p style={{ color: 'var(--ds-text-dim)', fontSize: 'var(--ds-font-sm)', lineHeight: 1.6 }}>
              Ask me anything or use a quick action above.
            </p>
          </div>
        )}
        {messages.length === 0 && keyStatus === 'checking' && (
          <div style={{ textAlign: 'center', padding: 'var(--ds-space-8)' }}>
            <p style={{ color: 'var(--ds-text-dim)', fontSize: 'var(--ds-font-sm)' }}>
              Checking AI configuration…
            </p>
          </div>
        )}
        {keyStatus === 'missing' && (
          <div
            style={{
              margin: 'auto',
              maxWidth: 300,
              textAlign: 'center',
              padding: 'var(--ds-space-6) var(--ds-space-5)',
              background: 'var(--ds-bg-subtle)',
              border: '1px solid var(--ds-border)',
              borderRadius: 'var(--ds-radius-lg)',
              animation: 'fadeInUp 0.4s ease',
            }}
          >
            <div style={{ color: 'var(--ds-text-muted)', marginBottom: 'var(--ds-space-2)' }}>
              <KeyIcon size={24} />
            </div>
            <p style={{
              color: 'var(--ds-text-secondary)',
              fontSize: 'var(--ds-font-base)',
              fontWeight: 'var(--ds-weight-semibold)',
              marginBottom: 'var(--ds-space-1)',
            }}>
              {providerLabel ? `${providerLabel} isn't configured` : 'No AI provider configured'}
            </p>
            <p style={{ color: 'var(--ds-text-faint)', fontSize: 'var(--ds-font-sm)', lineHeight: 1.6 }}>
              Open <strong style={{ color: 'var(--ds-text-secondary)' }}>Settings → AI &amp; Models</strong> to
              add an API key, or switch to a provider you've already set up.
              Local models via Ollama need no key.
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              padding: '10px 14px',
              borderRadius: 'var(--ds-radius-lg)',
              background: msg.role === 'user'
                ? 'var(--ds-accent-bg)'
                : msg.error ? 'var(--ds-danger-bg)' : 'var(--ds-bg-input)',
              border: `1px solid ${
                msg.role === 'user'
                  ? 'var(--ds-accent-border)'
                  : msg.error ? 'var(--ds-danger-border)' : 'var(--ds-border)'
              }`,
              fontSize: 'var(--ds-font-sm)',
              lineHeight: 1.7,
              color: msg.error ? 'var(--ds-danger-text)' : 'var(--ds-text-secondary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              animation: 'fadeInUp 0.25s ease',
            }}
          >
            {/* A streaming bubble with no text yet shows the typing dots. */}
            {msg.streaming && !msg.text ? <TypingIndicator /> : msg.text}
            {msg.error && msg.retryPrompt && (
              <div style={{ marginTop: 'var(--ds-space-2)' }}>
                <Button
                  variant="danger"
                  size="sm"
                  icon={<RefreshIcon size={12} />}
                  onClick={() => retryMessage(i, msg.retryPrompt)}
                  disabled={loading}
                >
                  Retry
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input Area */}
      <div style={{ display: 'flex', gap: 'var(--ds-space-2)', flexShrink: 0, alignItems: 'flex-end' }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={keyStatus === 'ok' ? 'Ask anything…' : 'AI unavailable — no API key configured'}
          disabled={loading || keyStatus !== 'ok'}
          rows={Math.min(4, Math.max(1, input.split('\n').length))}
          style={{
            flex: 1,
            background: 'var(--ds-bg-input)',
            border: '1px solid var(--ds-border)',
            borderRadius: 'var(--ds-radius-md)',
            padding: '9px 12px',
            color: 'var(--ds-text-primary)',
            fontSize: 'var(--ds-font-sm)',
            outline: 'none',
            WebkitAppRegion: 'no-drag',
            fontFamily: 'inherit',
            resize: 'none',
            transition: 'border-color var(--ds-dur-fast) var(--ds-ease)',
            lineHeight: 1.5,
            maxHeight: 100,
            minHeight: 36,
            opacity: keyStatus === 'ok' ? 1 : 0.5,
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--ds-accent-border)'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--ds-border)'; }}
        />
        <IconButton
          variant="subtle"
          size={36}
          title="Send"
          onClick={() => sendMessage()}
          disabled={!canSend}
          className={canSend ? 'ds-icon-btn--active' : ''}
        >
          <ArrowUpIcon size={16} />
        </IconButton>
      </div>
    </ResizablePanel>
  );

  return ReactDOM.createPortal(panel, document.body);
}
