/**
 * useNexusAccess — Hook React para NexusGuard.
 * Usa el núcleo framework-agnostic (nexus-core.ts).
 */
import { useState, useEffect } from 'react';
import { verifyNexusAccess, NexusEmpresa, NexusSubmodulo } from '../core/nexus-core';

export type { NexusEmpresa, NexusSubmodulo };

export type NexusAccessState =
  | { status: 'loading' }
  | { status: 'active';   empresa: NexusEmpresa; submodulo: NexusSubmodulo }
  | { status: 'inactive'; reason: string }
  | { status: 'error';    reason: string };

const NEXUS_API_URL =
  (import.meta as unknown as { env: Record<string, string> }).env.VITE_NEXUS_API_URL ?? '';

export function useNexusAccess(): NexusAccessState {
  const [state, setState] = useState<NexusAccessState>({ status: 'loading' });

  useEffect(() => {
    if (!NEXUS_API_URL) {
      setState({ status: 'error', reason: 'VITE_NEXUS_API_URL no está definida en .env' });
      return;
    }

    verifyNexusAccess(NEXUS_API_URL).then((result) => {
      if (result.active) {
        setState({ status: 'active', empresa: result.empresa, submodulo: result.submodulo });
      } else {
        setState({ status: 'inactive', reason: result.reason });
      }
    });
  }, []);

  return state;
}
