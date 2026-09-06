/**
 * First-run setup for the Veyora desktop shell.
 *
 * Injected as a WebView initialization script before the web client loads —
 * but only on launches where no vault is configured yet. Per UX-ONB-002 the
 * first screen offers the four desktop routes — create a vault, open an
 * existing vault, import into a new vault, and the advanced self-hosted
 * connection — before any password is requested. Local storage stays the
 * default: the first two routes pick the folder that will hold the encrypted
 * SQLite vault and start the embedded loopback API (`pick_vault_dir`), while
 * the connect route only opens the operator's service address in the system
 * browser because desktop connected pairing is not part of this preview.
 *
 * When a vault is already configured the overlay is cleared and the client
 * boots against the loopback URL already in localStorage.
 */
(function () {
  'use strict';

  var URL_KEY = 'veyora-api-url';
  var TOKEN_KEY = 'veyora-api-token';
  var OVERLAY_ID = 'veyora-setup-overlay';
  var TITLE_ID = 'veyora-setup-title';
  var invoke = window.__TAURI__ && window.__TAURI__.core
    ? window.__TAURI__.core.invoke
    : null;

  // Hide the (API-less) client behind a painted backdrop immediately —
  // before DOMContentLoaded — so it never flashes through.
  document.documentElement.classList.add('veyora-first-run');
  var style = document.createElement('style');
  style.textContent =
    'html.veyora-first-run { background: #0b1220; }' +
    'html.veyora-first-run body > *:not(#' + OVERLAY_ID + ') { display: none !important; }' +
    '#' + OVERLAY_ID + ' button:focus-visible,' +
    '#' + OVERLAY_ID + ' input:focus-visible {' +
    'outline: 2px solid #4c8dff; outline-offset: 2px;' +
    '}';
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

  function el(tag, css, text) {
    var node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  var TEXT = {
    title: 'Welcome to Veyora',
    intro:
      'Veyora saves your passwords and private information in a vault — ' +
      'a single encrypted database file in a folder you control. Records are ' +
      'end-to-end encrypted inside this app; the file only ever holds ' +
      'ciphertext locked by your master password.',
    createTitle: 'Create a new vault',
    createBody:
      'Pick an empty folder for the new vault database. It will contain ' +
      'vault.db and a backups/ folder with rolling snapshots, and you will ' +
      'set your master password on the next screen.',
    createAction: 'Choose a Folder for a New Vault…',
    openTitle: 'Open an existing vault',
    openBody:
      'Use a vault database (vault.db) already on this device or copied ' +
      'from another computer. No vault is known on this device yet — you ' +
      'choose the folder it lives in.',
    openAction: 'Choose the Vault Folder…',
    importTitle: 'Import from another password manager',
    importBody:
      'Importing starts with a new vault: pick a folder for it here, then ' +
      'the next screen offers importing your items (from Settings → Data). ' +
      'Your existing passwords stay where they are until the import.',
    importAction: 'Create a Vault to Import Into…',
    connectTitle: 'Advanced: connect to a self-hosted server',
    connectBody:
      'Advanced. This desktop preview keeps your vault on this device. To ' +
      'work against a Veyora service you run yourself, open its web address ' +
      'in your browser; desktop connected pairing arrives with connected ' +
      'mode.',
    connectPlaceholder: 'https://vault.example.com',
    connectAction: 'Open in Browser',
    hint: 'Suggested folder: '
  };

  function routeBlock(heading, body, action, onClick) {
    var block = el(
      'div',
      'margin:0 0 18px;padding:16px 18px;border:1px solid #223047;border-radius:12px;' +
        'background:#0e1626;'
    );
    var title = el(
      'h2',
      'margin:0 0 8px;font-size:16px;font-weight:600;color:#e6edf3;',
      heading
    );
    block.appendChild(title);
    var text = el(
      'p',
      'margin:0 0 12px;font-size:13px;line-height:1.6;color:#b6c2d4;',
      body
    );
    block.appendChild(text);
    if (onClick.then) {
      // The connect route returns a promise for its control elements.
      onClick.then(function (controls) {
        for (var i = 0; i < controls.length; i += 1) block.appendChild(controls[i]);
      });
    } else {
      var button = el(
        'button',
        'padding:10px 16px;font-size:14px;font-weight:600;color:#0b1220;' +
          'background:#4c8dff;border:none;border-radius:10px;cursor:pointer;',
        action
      );
      button.type = 'button';
      button.addEventListener('click', onClick);
      block.appendChild(button);
    }
    return block;
  }

  function showWizard(suggested) {
    ready(function () {
      var overlay = el(
        'div',
        'position:fixed;inset:0;z-index:2147483647;display:flex;' +
          'align-items:center;justify-content:center;background:#0b1220;' +
          'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6edf3;'
      );
      overlay.id = OVERLAY_ID;
      // Dialog semantics so assistive technology announces the first-run
      // screen as a window with a name instead of loose content.
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');

      var card = el(
        'div',
        'max-width:640px;width:calc(100% - 48px);padding:32px 36px;border-radius:16px;' +
          'background:#111a2c;border:1px solid #223047;box-shadow:0 24px 64px rgba(0,0,0,.45);' +
          'max-height:calc(100vh - 64px);overflow-y:auto;'
      );

      var title = el(
        'h1',
        'margin:0 0 12px;font-size:22px;font-weight:600;',
        TEXT.title
      );
      title.id = TITLE_ID;
      overlay.setAttribute('aria-labelledby', TITLE_ID);
      card.appendChild(title);
      card.appendChild(
        el(
          'p',
          'margin:0 0 8px;font-size:14px;line-height:1.6;color:#b6c2d4;',
          TEXT.intro
        )
      );
      card.appendChild(
        el(
          'p',
          'margin:0 0 20px;font-size:13px;color:#8a97a9;word-break:break-all;',
          TEXT.hint + (suggested || 'your Documents folder')
        )
      );

      var status = el(
        'p',
        'margin:16px 0 0;min-height:20px;font-size:13px;color:#8a97a9;' +
          'word-break:break-word;'
      );
      // Waiting/error messages are announced as a status region (PRD 7.3).
      status.setAttribute('role', 'status');
      function setStatus(text, isError) {
        status.textContent = text || '';
        status.style.color = isError ? '#ff8f8f' : '#8a97a9';
      }

      // Create / open / import share the folder-picking ceremony; `route`
      // keeps create and open honest on the shell side (an existing
      // vault.db is refused for create, required for open).
      function pickFolder(route, waitingMessage) {
        setStatus(waitingMessage, false);
        return invoke('pick_vault_dir', { route: route })
          .then(function (result) {
            if (!result || !result.ok) {
              setStatus(
                (result && result.reason) || 'No folder selected — pick one to continue.',
                true
              );
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
          });
      }

      card.appendChild(
        routeBlock(TEXT.createTitle, TEXT.createBody, TEXT.createAction, function () {
          pickFolder('create', 'Waiting for an empty folder…');
        })
      );
      card.appendChild(
        routeBlock(TEXT.openTitle, TEXT.openBody, TEXT.openAction, function () {
          pickFolder('open', 'Waiting for the vault folder…');
        })
      );
      card.appendChild(
        routeBlock(TEXT.importTitle, TEXT.importBody, TEXT.importAction, function () {
          pickFolder('create', 'Waiting for a folder for the new vault…');
        })
      );

      // Advanced connect: a plain http(s) address opened in the system
      // browser — the desktop shell keeps local storage as the default.
      var connectControls = Promise.resolve().then(function () {
        var urlInput = el('input');
        urlInput.type = 'url';
        urlInput.value = '';
        urlInput.placeholder = TEXT.connectPlaceholder;
        urlInput.setAttribute('aria-label', TEXT.connectTitle);
        // Enter in the address field behaves like the button, so the route
        // never depends on pointer use.
        urlInput.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') {
            event.preventDefault();
            openButton.click();
          }
        });
        urlInput.style.cssText =
          'display:block;flex:1;min-width:0;padding:10px 12px;font-size:14px;' +
          'color:#e6edf3;background:#0b1220;border:1px solid #223047;border-radius:10px;';
        var openButton = el(
          'button',
          'padding:10px 16px;font-size:14px;font-weight:600;color:#0b1220;' +
            'background:#4c8dff;border:none;border-radius:10px;cursor:pointer;',
          TEXT.connectAction
        );
        openButton.type = 'button';
        openButton.addEventListener('click', function () {
          invoke('open_external_url', { url: urlInput.value })
            .then(function () {
              setStatus('Opened ' + urlInput.value.trim() + ' in your browser.', false);
            })
            .catch(function (error) {
              setStatus(String(error), true);
            });
        });
        var row = el(
          'div',
          'display:flex;gap:10px;align-items:stretch;flex-wrap:wrap;margin-top:12px;'
        );
        row.appendChild(urlInput);
        row.appendChild(openButton);
        return [row];
      });
      card.appendChild(
        routeBlock(TEXT.connectTitle, TEXT.connectBody, null, connectControls)
      );

      card.appendChild(status);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      // The wizard takes over the window: land focus on the first route
      // action so keyboard users start inside the dialog.
      var firstAction = overlay.querySelector('button');
      if (firstAction) firstAction.focus();
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
