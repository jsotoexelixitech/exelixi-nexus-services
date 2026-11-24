/**
 * useNexusAccess — Hook React para NexusGuard.
 * Verifica el token al montar y re-verifica cada ~30 s (empresa activa/inactiva en Admin).
 */
import { useState, useEffect } from 'react';
import {
  startNexusAccessPoll,
  NexusEmpresa,
  NexusSubmodulo,
  NexusMetadata,
} from './core/nexus-core';

export type { NexusEmpresa, NexusSubmodulo, NexusMetadata };

export type NexusAccessState =
  | { status: 'loading' }
  | {
      status: 'active';
      empresa: NexusEmpresa;
      submodulo: NexusSubmodulo;
      metadata?: NexusMetadata;
    }
  | { status: 'blocked'; reason: string };

export function useNexusAccess(nexusApiUrl: string): NexusAccessState {
  const [state, setState] = useState<NexusAccessState>({ status: 'loading' });

  useEffect(() => {
    if (!nexusApiUrl?.trim()) {
      setState({
        status: 'blocked',
        reason: 'VITE_NEXUS_API_URL no está configurada en .env',
      });
      return;
    }

    const stopPoll = startNexusAccessPoll(nexusApiUrl, (result) => {
      if (result.active) {
        setState({
          status: 'active',
          empresa: result.empresa,
          submodulo: result.submodulo,
          metadata: result.metadata,
        });
      } else {
        setState({ status: 'blocked', reason: result.reason });
      }
    });

    return stopPoll;
  }, [nexusApiUrl]);

  return state;
}
