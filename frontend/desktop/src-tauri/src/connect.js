/**
 * Veyora desktop connect screen (Tauri initialization script).
 *
 * Runs before the web client scripts on every navigation. When no server
 * URL is stored, it covers the page with a "connect to your server" form;
 * on success the values are written to the localStorage keys the web
 * client already resolves (`veyora-api-url`, `veyora-api-token`) and the
 * page reloads into the vault UI.
 */
(() => {
  const URL_KEY = 'veyora-api-url';
  const TOKEN_KEY = 'veyora-api-token';
  const BRAND = '#161512';
  const SURFACE = '#211f1b';
  const TEXT = '#ece7df';
  const MUTED = '#a49c8f';
  const ACCENT = '#2a9d8f';

  window.veyoraDesktopChangeServer = () => {
    try {
      localStorage.removeItem(URL_KEY);
      localStorage.removeItem(TOKEN_KEY);
    } catch (storageError) {
      /* storage unavailable: reload anyway to resurface the form */
    }
    location.reload();
  };

  let stored = null;
  try {
    stored = localStorage.getItem(URL_KEY);
  } catch (storageError) {
    stored = null;
  }
  if (stored) return;

  const el = (tag, style, text) => {
    const node = document.createElement(tag);
    if (style) Object.assign(node.style, style);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const showConnectScreen = () => {
    const card = el('div', {
      width: '380px',
      margin: '16vh auto 0',
      padding: '32px',
      background: SURFACE,
      borderRadius: '12px',
      boxSizing: 'border-box',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    });
    const cardTitle = el('h1', { margin: '0 0 6px', fontSize: '24px', color: TEXT }, 'Veyora');
    const cardHint = el(
      'p',
      { margin: '0 0 24px', fontSize: '14px', color: MUTED, lineHeight: '1.5' },
      'Connect to your Veyora server. Enter the gateway address that serves /healthz.'
    );

    const urlLabel = el('label', { display: 'block', fontSize: '12px', color: MUTED, marginBottom: '6px' }, 'Server URL');
    const urlInput = el('input', { width: '100%', padding: '10px 12px', marginBottom: '16px', borderRadius: '8px', border: '1px solid #3a362f', background: BRAND, color: TEXT, fontSize: '14px', boxSizing: 'border-box' });
    urlInput.type = 'text';
    urlInput.placeholder = 'https://vault.example.com';
    urlInput.autocomplete = 'off';
    urlInput.spellcheck = false;

    const tokenLabel = el('label', { display: 'block', fontSize: '12px', color: MUTED, marginBottom: '6px' }, 'API token (optional)');
    const tokenInput = el('input', { width: '100%', padding: '10px 12px', marginBottom: '20px', borderRadius: '8px', border: '1px solid #3a362f', background: BRAND, color: TEXT, fontSize: '14px', boxSizing: 'border-box' });
    tokenInput.type = 'password';
    tokenInput.placeholder = 'Required when the server uses token auth';

    const button = el(
      'button',
      {
        width: '100%', padding: '11px 0', border: 'none', borderRadius: '8px',
        background: ACCENT, color: '#0d0c0a', fontSize: '14px', fontWeight: '600',
        cursor: 'pointer',
      },
      'Connect'
    );
    const status = el('p', { margin: '14px 0 0', minHeight: '20px', fontSize: '13px', color: MUTED }, '');

    card.append(cardTitle, cardHint, urlLabel, urlInput, tokenLabel, tokenInput, button, status);

    const overlay = el('div', {
      position: 'fixed', inset: '0', zIndex: '2147483647', background: BRAND,
      display: 'block', overflow: 'auto',
    });
    overlay.id = 'veyora-connect-overlay';
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const setStatus = (message, failed) => {
      status.textContent = message;
      status.style.color = failed ? '#e07856' : MUTED;
    };

    const connect = async () => {
      const raw = urlInput.value.trim().replace(/\/+$/, '');
      const token = tokenInput.value.trim();
      let origin;
      try {
        origin = new URL(raw).origin;
      } catch (parseError) {
        setStatus('Enter a full URL, for example http://192.168.1.10:8080', true);
        return;
      }
      setStatus('Checking the server…');
      try {
        const init = token ? { headers: { Authorization: 'Bearer ' + token } } : undefined;
        const response = await fetch(origin + '/healthz', init);
        if (!response.ok) {
          setStatus('The server answered with HTTP ' + response.status + '. Check the address and token.', true);
          return;
        }
      } catch (networkError) {
        setStatus('Could not reach the server. Verify the address, TLS setup, and CORS allowlist.', true);
        return;
      }
      try {
        localStorage.setItem(URL_KEY, origin);
        if (token) localStorage.setItem(TOKEN_KEY, token);
        else localStorage.removeItem(TOKEN_KEY);
      } catch (storageError) {
        setStatus('Local storage is unavailable in this WebView.', true);
        return;
      }
      setStatus('Connected. Starting Veyora…');
      setTimeout(() => location.reload(), 300);
    };

    button.addEventListener('click', () => { void connect(); });
    [urlInput, tokenInput].forEach(input => {
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { void connect(); }
      });
    });
    urlInput.focus();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showConnectScreen, { once: true });
  } else {
    showConnectScreen();
  }
})();
