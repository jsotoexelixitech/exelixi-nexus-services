/**
 * nexus-guard.js — Vanilla JS / HTML puro / cualquier framework sin componentes
 *
 * USO — pega esto al inicio de tu HTML o entry point:
 *
 *   <script src="nexus-guard.js"></script>
 *   <script>
 *     NexusGuard.init({
 *       nexusApiUrl: 'http://192.168.8.120:3091',
 *       serviceName: 'RCV',
 *       onActive: function(empresa, submodulo) {
 *         console.log('Empresa:', empresa.nombre)
 *         document.getElementById('app').style.display = 'block'
 *       }
 *     })
 *   </script>
 *
 * O con import en un .js/.ts:
 *   import { initNexusGuard } from './nexus-guard.js'
 */

(function (global) {
  const BLOCKED_HTML = function (reason, serviceName) {
    return `
      <div style="
        position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
        background:linear-gradient(135deg,#0C133A 0%,#1a2460 100%);
        font-family:Inter,system-ui,sans-serif;z-index:9999;
      ">
        <div style="
          background:#fff;border-radius:1.25rem;padding:3rem 2.5rem;
          max-width:420px;width:90%;text-align:center;
          box-shadow:0 25px 50px rgba(0,0,0,.35);
        ">
          <div style="font-size:3rem;margin-bottom:1rem">🔒</div>
          <h1 style="font-size:1.4rem;font-weight:700;color:#0C133A;margin:0 0 .75rem">
            Acceso no disponible
          </h1>
          <p style="font-size:.95rem;color:#475569;margin:0 0 .5rem;line-height:1.5">
            ${reason}
          </p>
          <p style="font-size:.8rem;color:#94a3b8;margin-top:1rem">
            Si cree que esto es un error, contacte a su administrador.
          </p>
        </div>
      </div>`;
  };

  const LOADING_HTML = `
    <div id="__nexus_loading__" style="
      position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
      background:linear-gradient(135deg,#0C133A 0%,#1a2460 100%);
      font-family:Inter,system-ui,sans-serif;z-index:9999;
    ">
      <div style="
        background:#fff;border-radius:1.25rem;padding:3rem 2.5rem;
        max-width:420px;width:90%;text-align:center;
        box-shadow:0 25px 50px rgba(0,0,0,.35);
      ">
        <div style="
          width:40px;height:40px;border:3px solid #e5e7eb;border-top-color:#ED7423;
          border-radius:50%;margin:0 auto 1.5rem;
          animation:__nexus_spin__ .8s linear infinite;
        "></div>
        <p style="font-size:.95rem;color:#475569">Verificando acceso…</p>
      </div>
    </div>
    <style>@keyframes __nexus_spin__ { to { transform: rotate(360deg); } }</style>`;

  async function init(options) {
    var nexusApiUrl = options.nexusApiUrl;
    var serviceName = options.serviceName || 'Servicio';
    var onActive    = options.onActive;    // callback(empresa, submodulo)
    var onBlocked   = options.onBlocked;   // callback(reason) — opcional

    // Mostrar loading
    var overlay = document.createElement('div');
    overlay.innerHTML = LOADING_HTML;
    document.body.appendChild(overlay);

    // Leer token de URL
    var token = new URLSearchParams(window.location.search).get('nexus_token');

    if (!token) {
      overlay.innerHTML = BLOCKED_HTML('No se proporcionó token de acceso.', serviceName);
      if (onBlocked) onBlocked('No se proporcionó token de acceso.');
      return;
    }

    try {
      var res = await fetch(nexusApiUrl.replace(/\/$/, '') + '/api/access/verify', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      var data = await res.json();

      if (data.active) {
        // Remover overlay — app visible
        document.body.removeChild(overlay);
        if (onActive) onActive(data.empresa, data.submodulo);
      } else {
        var reason = data.reason || 'Servicio no disponible para esta empresa.';
        overlay.innerHTML = BLOCKED_HTML(reason, serviceName);
        if (onBlocked) onBlocked(reason);
      }
    } catch (e) {
      var msg = 'No se pudo conectar con el servidor de autorización.';
      overlay.innerHTML = BLOCKED_HTML(msg, serviceName);
      if (onBlocked) onBlocked(msg);
    }
  }

  // Exponer como global y como ESM
  var NexusGuard = { init: init };
  if (typeof module !== 'undefined' && module.exports) module.exports = NexusGuard;
  if (typeof global !== 'undefined') global.NexusGuard = NexusGuard;

})(typeof window !== 'undefined' ? window : this);
