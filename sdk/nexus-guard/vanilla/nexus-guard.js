/**
 * nexus-guard.js — Vanilla JS (HTML sin bundler)
 *
 *   <script src="./nexus-guard.js"></script>
 *   <script>
 *     NexusGuard.init({
 *       nexusApiUrl: 'https://cierrelmds.exelixitech.com/nexus-api',
 *       serviceName: 'Mi módulo',
 *       onActive: function(empresa, submodulo, metadata) { ... }
 *     });
 *   </script>
 *
 * Con bundler (Vite/Webpack): import { initNexusGuard, nexusFetch } from './core/nexus-core'
 *   vía el kit en vanilla/core/nexus-core.ts
 */

(function (global) {
  var SESSION_KEY = '__nexus_token__';
  var VERIFY_POLL_MS = 30 * 1000;

  function getStoredToken() {
    try {
      return sessionStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  }

  function storeToken(t) {
    try {
      sessionStorage.setItem(SESSION_KEY, t);
    } catch {
      /* sin sessionStorage */
    }
  }

  function getTokenFromUrl() {
    return new URLSearchParams(window.location.search).get('nexus_token');
  }

  function blockedHtml(reason) {
    return (
      '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
      'background:linear-gradient(135deg,#0C133A 0%,#1a2460 100%);font-family:Inter,system-ui,sans-serif;z-index:9999">' +
      '<div style="background:#fff;border-radius:1.25rem;padding:3rem 2.5rem;max-width:420px;width:90%;text-align:center;' +
      'box-shadow:0 25px 50px rgba(0,0,0,.35)">' +
      '<div style="font-size:3rem;margin-bottom:1rem">🔒</div>' +
      '<h1 style="font-size:1.4rem;font-weight:700;color:#0C133A;margin:0 0 .75rem">Acceso no disponible</h1>' +
      '<p style="font-size:.95rem;color:#475569;margin:0 0 .5rem;line-height:1.5">' +
      reason +
      '</p>' +
      '<p style="font-size:.8rem;color:#94a3b8;margin-top:1rem">Si cree que esto es un error, contacte a su administrador.</p>' +
      '</div></div>'
    );
  }

  var LOADING_HTML =
    '<div id="__nexus_loading__" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'background:linear-gradient(135deg,#0C133A 0%,#1a2460 100%);font-family:Inter,system-ui,sans-serif;z-index:9999">' +
    '<div style="background:#fff;border-radius:1.25rem;padding:3rem 2.5rem;max-width:420px;width:90%;text-align:center;' +
    'box-shadow:0 25px 50px rgba(0,0,0,.35)">' +
    '<div style="width:40px;height:40px;border:3px solid #e5e7eb;border-top-color:#ED7423;border-radius:50%;' +
    'margin:0 auto 1.5rem;animation:__nexus_spin__ .8s linear infinite"></div>' +
    '<p style="font-size:.95rem;color:#475569">Verificando acceso con Exélixi Nexus…</p>' +
    '</div></div>' +
    '<style>@keyframes __nexus_spin__ { to { transform: rotate(360deg); } }</style>';

  async function verifyOnce(nexusApiUrl) {
    var urlToken = getTokenFromUrl();
    var token = urlToken || getStoredToken();

    if (!token) {
      return {
        active: false,
        reason:
          'No se proporcionó token de acceso. Contacte a su administrador.',
      };
    }

    try {
      var res = await fetch(
        nexusApiUrl.replace(/\/$/, '') + '/api/access/verify',
        {
          method: 'GET',
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
          },
        },
      );

      var data = await res.json();

      if (data.access_token) storeToken(data.access_token);
      else {
        var refreshed = res.headers.get('X-Nexus-Token-Refreshed');
        if (refreshed) storeToken(refreshed);
        else if (urlToken) storeToken(urlToken);
      }

      if (data.active) {
        return {
          active: true,
          empresa: data.empresa,
          submodulo: data.submodulo,
          metadata: data.metadata || {},
        };
      }

      return {
        active: false,
        reason: data.reason || 'Servicio no disponible para esta empresa.',
      };
    } catch {
      return {
        active: false,
        reason: 'No se pudo conectar con el servidor de autorización.',
      };
    }
  }

  async function init(options) {
    var nexusApiUrl = options.nexusApiUrl;
    var onActive = options.onActive;
    var onBlocked = options.onBlocked;
    var pollMs = options.verifyPollMs || VERIFY_POLL_MS;

    var overlay = document.createElement('div');
    overlay.innerHTML = LOADING_HTML;
    document.body.appendChild(overlay);

    if (!nexusApiUrl || !String(nexusApiUrl).trim()) {
      var noUrl = 'VITE_NEXUS_API_URL no está configurada en .env';
      overlay.innerHTML = blockedHtml(noUrl);
      if (onBlocked) onBlocked(noUrl);
      return function () {};
    }

    var isActive = false;
    var pollTimer = null;
    var stopped = false;

    async function tick() {
      if (stopped) return;

      var result = await verifyOnce(nexusApiUrl);

      if (result.active) {
        if (!isActive) {
          isActive = true;
          if (overlay.parentNode) document.body.removeChild(overlay);
          if (onActive)
            onActive(result.empresa, result.submodulo, result.metadata || {});
        }
      } else {
        isActive = false;
        if (!overlay.parentNode) {
          overlay = document.createElement('div');
          document.body.appendChild(overlay);
        }
        overlay.innerHTML = blockedHtml(result.reason);
        if (onBlocked) onBlocked(result.reason);
      }
    }

    await tick();
    pollTimer = setInterval(tick, pollMs);

    return function stop() {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
    };
  }

  function getToken() {
    return getStoredToken();
  }

  async function apiFetch(input, init) {
    init = init || {};
    var headers = Object.assign({}, init.headers || {});
    var t = getStoredToken();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    var res = await fetch(input, Object.assign({}, init, { headers: headers }));
    var refreshed = res.headers.get('X-Nexus-Token-Refreshed');
    if (refreshed) storeToken(refreshed);
    return res;
  }

  var NexusGuard = { init: init, getToken: getToken, fetch: apiFetch };
  if (typeof module !== 'undefined' && module.exports)
    module.exports = NexusGuard;
  if (typeof global !== 'undefined') global.NexusGuard = NexusGuard;
})(typeof window !== 'undefined' ? window : this);
