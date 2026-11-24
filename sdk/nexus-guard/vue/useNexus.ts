import { inject } from 'vue';
import type { Ref } from 'vue';
import type {
  NexusEmpresa,
  NexusSubmodulo,
  NexusMetadata,
} from './core/nexus-core';

export type NexusInject = {
  empresa: NexusEmpresa | null;
  submodulo: NexusSubmodulo | null;
  metadata?: NexusMetadata;
};

const NEXUS_KEY = Symbol('nexus');

export { NEXUS_KEY };

export function useNexus(): NexusInject {
  const data = inject<Ref<NexusInject>>(NEXUS_KEY);
  if (!data) throw new Error('useNexus debe usarse dentro de <NexusGuard>');
  return data.value;
}
