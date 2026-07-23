<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { writable } from 'svelte/store';
  import { verifyNexusAccess, heartbeatNexus } from './core/nexus-core';
  import type { NexusEmpresa, NexusSubmodulo } from './core/nexus-core';

  export let nexusApiUrl: string;
  export let serviceName: string = 'Servicio';
  export let logoUrl: string = '';

  const HEARTBEAT_MS = 5 * 60 * 1000;

  type State =
    | { status: 'loading' }
    | { status: 'active'; empresa: NexusEmpresa; submodulo: NexusSubmodulo }
    | { status: 'blocked'; reason: string };

  export const nexusStore = writable<{
    empresa: NexusEmpresa | null;
    submodulo: NexusSubmodulo | null;
  }>({
    empresa: null,
    submodulo: null,
  });

  let state: State = { status: 'loading' };
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(async () => {
      const active = await heartbeatNexus(nexusApiUrl);
      if (!active) {
        stopHeartbeat();
        nexusStore.set({ empresa: null, submodulo: null });
        state = {
          status: 'blocked',
          reason: 'Sesión expirada. Acceso suspendido.',
        };
      }
    }, HEARTBEAT_MS);
  }

  onMount(async () => {
    if (!nexusApiUrl?.trim()) {
      state = {
        status: 'blocked',
        reason: 'VITE_NEXUS_API_URL no está configurada en .env',
      };
      return;
    }

    const result = await verifyNexusAccess(nexusApiUrl);
    if (result.active) {
      nexusStore.set({ empresa: result.empresa, submodulo: result.submodulo });
      state = {
        status: 'active',
        empresa: result.empresa,
        submodulo: result.submodulo,
      };
      startHeartbeat();
    } else {
      state = { status: 'blocked', reason: result.reason };
    }
  });

  onDestroy(stopHeartbeat);
</script>

{#if state.status === 'loading'}
  <div class="nexus-fullpage">
    <div class="nexus-card">
      {#if logoUrl}<img src={logoUrl} alt={serviceName} class="nexus-logo" />{/if}
      <div class="nexus-spinner"></div>
      <p class="nexus-subtitle">Verificando acceso con Exélixi Nexus…</p>
    </div>
  </div>

{:else if state.status === 'blocked'}
  <div class="nexus-fullpage">
    <div class="nexus-card">
      {#if logoUrl}<img src={logoUrl} alt={serviceName} class="nexus-logo" />{/if}
      <div class="nexus-lock">🔒</div>
      <h1 class="nexus-title">Acceso no disponible</h1>
      <p class="nexus-subtitle">{state.reason}</p>
      <p class="nexus-hint">Si cree que esto es un error, contacte a su administrador.</p>
    </div>
  </div>

{:else}
  <slot />
{/if}

<style>
  .nexus-fullpage {
    position: fixed; inset: 0;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #0C133A 0%, #1a2460 100%);
    font-family: Inter, system-ui, sans-serif;
    z-index: 9999;
  }
  .nexus-card {
    background: #fff; border-radius: 1.25rem;
    padding: 3rem 2.5rem; max-width: 420px; width: 90%;
    text-align: center; box-shadow: 0 25px 50px rgba(0,0,0,0.35);
  }
  .nexus-logo  { height: 48px; margin-bottom: 1.5rem; object-fit: contain; }
  .nexus-lock  { font-size: 3rem; margin-bottom: 1rem; }
  .nexus-spinner {
    width: 40px; height: 40px;
    border: 3px solid #e5e7eb; border-top-color: #ED7423;
    border-radius: 50%; margin: 0 auto 1.5rem;
    animation: spin 0.8s linear infinite;
  }
  .nexus-title    { font-size: 1.4rem; font-weight: 700; color: #0C133A; margin: 0 0 0.75rem; }
  .nexus-subtitle { font-size: 0.95rem; color: #475569; margin: 0 0 0.5rem; line-height: 1.5; }
  .nexus-hint     { font-size: 0.8rem; color: #94a3b8; margin-top: 1rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
