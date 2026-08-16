/**
 * Boot-time error surface and Service Worker registration.
 * Loaded before the main module so failures are visible even if the
 * module system breaks. Kept as an external file (not inline) to
 * comply with the strict CSP (script-src 'self').
 */
(function () {
  'use strict';

  // Development error surface: shows module/boot failures that would
  // otherwise render as a blank page.
  window.addEventListener('error', function (event) {
    var el = document.createElement('pre');
    el.id = 'boot-error';
    el.textContent = 'BOOT ERROR: ' + (event.message || event.error) +
      ' @ ' + (event.filename || '') + ':' + event.lineno;
    document.body.appendChild(el);
  });

  window.addEventListener('unhandledrejection', function (event) {
    var el = document.createElement('pre');
    el.id = 'boot-rejection';
    el.textContent = 'BOOT REJECTION: ' +
      (event.reason && (event.reason.stack || event.reason.message) || event.reason);
    document.body.appendChild(el);
  });

  // Service Worker registration for offline support.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(function () {
      // SW registration failure is non-fatal.
    });
  }
})();
