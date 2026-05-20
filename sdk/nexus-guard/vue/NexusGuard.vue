<template>
  <!-- NexusGuard.vue — Wrapper para Vue 3
  
  USO en App.vue:
    <script setup>
      import NexusGuard from './nexus/NexusGuard.vue'
    </script>
    <template>
      <NexusGuard nexus-api-url="http://192.168.8.120:3091" service-name="RCV">
        <RouterView />
      </NexusGuard>
    </template>

  Acceder a empresa desde componentes hijos:
    import { useNexus } from './nexus/NexusGuard.vue'
    const { empresa } = useNexus()
  -->

  <div v-if="state.status === 'loading'" class="nexus-fullpage">
    <div class="nexus-card">
      <img v-if="logoUrl" :src="logoUrl" :alt="serviceName" class="nexus-logo" />
      <div class="nexus-spinner"></div>
      <p class="nexus-subtitle">Verificando acceso…</p>
    </div>
  </div>

  <div v-else-if="state.status === 'blocked'" class="nexus-fullpage">
    <div class="nexus-card">
      <img v-if="logoUrl" :src="logoUrl" :alt="serviceName" class="nexus-logo" />
      <div class="nexus-lock">🔒</div>
      <h1 class="nexus-title">Acceso no disponible</h1>
      <p class="nexus-subtitle">{{ state.reason }}</p>
      <p class="nexus-hint">Si cree que esto es un error, contacte a su administrador.</p>
    </div>
  </div>

  <slot v-else />
</template>

<script setup lang="ts">
import { ref, onMounted, provide, inject } from 'vue';
import { verifyNexusAccess } from '../core/nexus-core';
import type { NexusEmpresa, NexusSubmodulo } from '../core/nexus-core';

const props = defineProps<{
  nexusApiUrl: string;
  serviceName?: string;
  logoUrl?: string;
}>();

type State =
  | { status: 'loading' }
  | { status: 'active';  empresa: NexusEmpresa; submodulo: NexusSubmodulo }
  | { status: 'blocked'; reason: string };

const state = ref<State>({ status: 'loading' });
const nexusData = ref<{ empresa: NexusEmpresa | null; submodulo: NexusSubmodulo | null }>({
  empresa: null,
  submodulo: null,
});

provide('nexus', nexusData);

onMounted(async () => {
  const result = await verifyNexusAccess(props.nexusApiUrl);
  if (result.active) {
    nexusData.value = { empresa: result.empresa, submodulo: result.submodulo };
    state.value = { status: 'active', empresa: result.empresa, submodulo: result.submodulo };
  } else {
    state.value = { status: 'blocked', reason: result.reason };
  }
});

// Composable para componentes hijos
export function useNexus() {
  const data = inject<typeof nexusData>('nexus');
  if (!data) throw new Error('useNexus debe usarse dentro de <NexusGuard>');
  return data.value;
}
</script>

<style scoped>
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
.nexus-logo     { height: 48px; margin-bottom: 1.5rem; object-fit: contain; }
.nexus-lock     { font-size: 3rem; margin-bottom: 1rem; }
.nexus-spinner  {
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
