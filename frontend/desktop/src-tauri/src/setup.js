/**
 * First-run storage-location setup for the Veyora desktop shell.
 *
 * Injected as a WebView initialization script before the web client loads —
 * but only on launches where no vault is configured yet. Choosing where the
 * vault database lives is the very first action, so nothing else is usable
 * until a location is picked (and re-picking later happens through the
 * native Vault menu).
 *
 * Flow: query the shell (`desktop_state`); when a vault is configured, clear
 * the backdrop and let the client boot against the loopback URL already in
 * localStorage. Otherwise render the picker overlay; a successful pick
 * (`pick_vault_dir`) starts the embedded server, so the page reloads into a
 * fully configured shell.
 */
(function () {
  'use strict';

  var URL_KEY = 'veyora-api-url';
  var TOKEN_KEY = 'veyora-api-token';
  var OVERLAY_ID = 'veyora-setup-overlay';
  var invoke = window.__TAURI__ && window.__TAURI__.core
    ? window.__TAURI__.core.invoke
    : null;

  // Hide the (API-less) client behind a painted backdrop immediately —
  // before DOMContentLoaded — so it never flashes through.
  document.documentElement.classList.add('veyora-first-run');
  var style = document.createElement('style');
  style.textContent =
    'html.veyora-first-run { background: #0b1220; }' +
    'html.veyora-first-run body > *:not(#' + OVERLAY_ID + ') { display: none !important; }';
  (document.head || document.documentElement).appendChild(style);

  if (!invoke) {
    reveal();
    return;
  }

  function reveal() {
    document.documentElement.classList.remove('veyora-first-run');
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.remove();
  }

  function ready(run) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run);
    } else {
      run();
    }
  }

  function showWizard(suggested) {
    ready(function () {
      var overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;display:flex;' +
        'align-items:center;justify-content:center;background:#0b1220;' +
        'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6edf3;';

      var card = document.createElement('div');
      card.style.cssText =
        'max-width:560px;width:calc(100% - 48px);padding:36px 40px;border-radius:16px;' +
        'background:#111a2c;border:1px solid #223047;box-shadow:0 24px 64px rgba(0,0,0,.45);';

      var title = document.createElement('h1');
      title.textContent = 'Choose where Veyora stores your vault';
      title.style.cssText = 'margin:0 0 12px;font-size:22px;font-weight:600;';
      card.appendChild(title);

      var intro = document.createElement('p');
      intro.style.cssText = 'margin:0 0 10px;font-size:14px;line-height:1.6;color:#b6c2d4;';
      intro.textContent =
        'Your vault is stored as a single encrypted database file in a folder ' +
        'you control. Records are end-to-end encrypted inside this app — the ' +
        'file only ever contains ciphertext locked by your master password.';
      card.appendChild(intro);

      var detail = document.createElement('p');
      detail.style.cssText = 'margin:0 0 18px;font-size:13px;line-height:1.6;color:#8a97a9;';
      detail.textContent =
        'The folder will contain vault.db and a backups/ folder with rolling ' +
        'snapshots. Copying the folder to another computer carries the vault ' +
        'with it. You can change the location anytime from the Vault menu.';
      card.appendChild(detail);

      var hint = document.createElement('p');
      hint.style.cssText =
        'margin:0 0 18px;font-size:13px;color:#8a97a9;word-break:break-all;';
      hint.textContent = 'Suggested: ' + (suggested || 'your Documents folder');
      card.appendChild(hint);

      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Choose Storage Location…';
      button.style.cssText =
        'display:block;width:100%;padding:12px 16px;font-size:15px;font-weight:600;' +
        'color:#0b1220;background:#4c8dff;border:none;border-radius:10px;cursor:pointer;';
      card.appendChild(button);

      var status = document.createElement('p');
      status.style.cssText =
        'margin:14px 0 0;min-height:20px;font-size:13px;color:#8a97a9;' +
        'word-break:break-word;';
      card.appendChild(status);

      function setStatus(text, isError) {
        status.textContent = text || '';
        status.style.color = isError ? '#ff8f8f' : '#8a97a9';
      }

      button.addEventListener('click', function () {
        button.disabled = true;
        button.style.opacity = '0.6';
        setStatus('Waiting for a folder…', false);
        invoke('pick_vault_dir')
          .then(function (result) {
            if (!result || !result.ok) {
              setStatus(
                (result && result.reason) || 'No folder selected — pick one to continue.',
                true
              );
              button.disabled = false;
              button.style.opacity = '1';
              return;
            }
            try {
              localStorage.removeItem(TOKEN_KEY);
              localStorage.setItem(URL_KEY, 'http://127.0.0.1:' + result.port);
            } catch (error) { /* storage is best-effort; the shell re-injects */ }
            setStatus(
              result.existing
                ? 'Existing vault found — opening it…'
                : 'Vault created — starting Veyora…',
              false
            );
            setTimeout(function () { location.reload(); }, 400);
          })
          .catch(function (error) {
            setStatus(String(error), true);
            button.disabled = false;
            button.style.opacity = '1';
          });
      });

      overlay.appendChild(card);
      document.body.appendChild(overlay);
    });
  }

  invoke('desktop_state')
    .then(function (state) {
      if (state && state.configured && state.port) {
        try {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.setItem(URL_KEY, 'http://127.0.0.1:' + state.port);
        } catch (error) { /* reload path already set it */ }
        reveal();
        return;
      }
      showWizard(state && state.suggestedDir);
    })
    .catch(function () {
      showWizard(null);
    });
})();
