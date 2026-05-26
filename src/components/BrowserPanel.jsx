import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { HEADER_STYLE, TITLE_STYLE } from '../hooks/usePanelPosition';
import ResizablePanel from './ResizablePanel';
import {
  Button,
  IconButton,
  Input,
  Callout,
  XIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  RefreshIcon,
  StarIcon,
  GlobeIcon,
} from './ui';

export default function BrowserPanel({ isOpen, onClose, anchorRect }) {
  const [url, setUrl] = useState('');
  const [currentUrl, setCurrentUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [bookmarks, setBookmarks] = useState([]);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const panelRef = useRef(null);
  const webviewRef = useRef(null);
  const inputRef = useRef(null);
  const api = useMemo(() => window.electronAPI, []);

  useEffect(() => {
    if (!isOpen) return;
    api.invoke('browser:getBookmarks').then((b) => setBookmarks(Array.isArray(b) ? b : [])).catch(() => {});
    api.invoke('browser:getHistory').then((h) => setHistory(Array.isArray(h) ? h : [])).catch(() => {});
  }, [isOpen, api]);

  // Webview event listeners
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !isOpen) return undefined;
    const onStart = () => setLoading(true);
    const onStop = () => { setLoading(false); setCurrentUrl(wv.getURL()); };
    const onFail = (e) => { setLoading(false); setError(e.errorDescription || 'Failed to load'); };
    const onNav = (e) => { setCurrentUrl(e.url); setUrl(e.url); };
    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('did-fail-load', onFail);
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    return () => {
      wv.removeEventListener('did-start-loading', onStart);
      wv.removeEventListener('did-stop-loading', onStop);
      wv.removeEventListener('did-fail-load', onFail);
      wv.removeEventListener('did-navigate', onNav);
      wv.removeEventListener('did-navigate-in-page', onNav);
    };
  }, [isOpen]);

  // Blocked URL schemes that could be used for attacks
  const BLOCKED_SCHEMES = /^(file|javascript|data|chrome|chrome-extension|vbscript|about):/i;

  const navigate = useCallback((targetUrl) => {
    if (!targetUrl?.trim()) return;
    let finalUrl = targetUrl.trim();

    // Block dangerous URL schemes
    if (BLOCKED_SCHEMES.test(finalUrl)) {
      setError(`Blocked: "${finalUrl.split(':')[0]}:" URLs are not allowed for security`);
      return;
    }

    if (!/^https?:\/\//i.test(finalUrl)) {
      finalUrl = finalUrl.includes('.')
        ? `https://${finalUrl}`
        : `https://www.google.com/search?q=${encodeURIComponent(finalUrl)}`;
    }
    setUrl(finalUrl);
    setCurrentUrl(finalUrl);
    setError(null);
    if (webviewRef.current) webviewRef.current.src = finalUrl;
    // Save to history
    api.invoke('browser:addHistory', { url: finalUrl, title: finalUrl }).catch(() => {});
  }, [api]);

  const handleSubmit = (e) => { e.preventDefault(); navigate(url); };

  const addBookmark = useCallback(async () => {
    if (!currentUrl) return;
    const title = webviewRef.current?.getTitle?.() || currentUrl;
    await api.invoke('browser:saveBookmark', { url: currentUrl, title });
    const b = await api.invoke('browser:getBookmarks');
    setBookmarks(Array.isArray(b) ? b : []);
  }, [currentUrl, api]);

  if (!isOpen || !anchorRect) return null;

  const panel = (
    <ResizablePanel isOpen={isOpen} dockAction="browser" size="wide">
      <div style={HEADER_STYLE}>
        <span style={TITLE_STYLE}>Browser</span>
        <IconButton variant="danger" title="Close" onClick={onClose}>
          <XIcon size={14} />
        </IconButton>
      </div>

      {/* Nav Bar */}
      <div style={{ display: 'flex', gap: 'var(--ds-space-1)', alignItems: 'center', flexShrink: 0 }}>
        <IconButton title="Back" onClick={() => webviewRef.current?.goBack()}>
          <ChevronLeftIcon size={15} />
        </IconButton>
        <IconButton title="Forward" onClick={() => webviewRef.current?.goForward()}>
          <ChevronRightIcon size={15} />
        </IconButton>
        <IconButton title="Reload" onClick={() => webviewRef.current?.reload()}>
          <RefreshIcon size={14} />
        </IconButton>
        <form onSubmit={handleSubmit} style={{ flex: 1, display: 'flex', gap: 'var(--ds-space-2)' }}>
          <Input
            ref={inputRef}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Enter URL or search…"
            size="sm"
            wrapStyle={{ flex: 1, width: 'auto' }}
          />
          <Button type="submit" variant="primary" size="sm">Go</Button>
        </form>
        <IconButton title="Bookmark this page" onClick={addBookmark}>
          <StarIcon size={14} />
        </IconButton>
      </div>

      {/* Bookmarks bar */}
      {bookmarks.length > 0 && (
        <div style={{
          display: 'flex', gap: 'var(--ds-space-1)', flexShrink: 0,
          overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none',
        }}>
          {bookmarks.slice(0, 8).map((bm, i) => {
            let host = bm.title;
            try { host = new URL(bm.url).hostname.replace('www.', ''); } catch (_) { /* keep title */ }
            return (
              <button
                key={i}
                onClick={() => navigate(bm.url)}
                style={{
                  background: 'var(--ds-bg-input)',
                  border: '1px solid var(--ds-border)',
                  borderRadius: 'var(--ds-radius-sm)',
                  color: 'var(--ds-text-muted)',
                  fontSize: 'var(--ds-font-xs)',
                  padding: '3px 8px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  WebkitAppRegion: 'no-drag',
                  fontFamily: 'inherit',
                }}
              >
                {host}
              </button>
            );
          })}
        </div>
      )}

      {/* Loading bar */}
      {loading && (
        <div style={{ height: 2, background: 'var(--ds-accent)', borderRadius: 1, flexShrink: 0 }} />
      )}

      {/* Error */}
      {error && <Callout tone="danger">{error}</Callout>}

      {/* Webview or placeholder */}
      {currentUrl ? (
        <webview
          ref={webviewRef}
          src={currentUrl}
          partition="persist:browser"
          allowpopups="true"
          style={{
            flex: 1,
            borderRadius: 'var(--ds-radius-md)',
            border: '1px solid var(--ds-border)',
            minHeight: 0,
            background: '#ffffff',
          }}
        />
      ) : (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 'var(--ds-space-2)',
        }}>
          <div style={{ color: 'var(--ds-text-dim)' }}>
            <GlobeIcon size={28} />
          </div>
          <p style={{ color: 'var(--ds-text-dim)', fontSize: 'var(--ds-font-sm)', textAlign: 'center' }}>
            Enter a URL above to browse, or search the web.
          </p>
          {history.length > 0 && (
            <div style={{ width: '100%', marginTop: 'var(--ds-space-2)' }}>
              <div style={{
                fontSize: 'var(--ds-font-xs)',
                fontWeight: 'var(--ds-weight-semibold)',
                color: 'var(--ds-text-dim)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '4px 0',
              }}>
                Recent
              </div>
              {history.slice(0, 5).map((h, i) => (
                <button
                  key={i}
                  onClick={() => navigate(h.url)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '6px 0',
                    color: 'var(--ds-text-muted)',
                    fontSize: 'var(--ds-font-sm)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    WebkitAppRegion: 'no-drag',
                    fontFamily: 'inherit',
                  }}
                >
                  {h.title || h.url}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </ResizablePanel>
  );

  return ReactDOM.createPortal(panel, document.body);
}
