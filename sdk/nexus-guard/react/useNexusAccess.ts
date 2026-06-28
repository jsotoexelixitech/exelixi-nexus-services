/**
 * useNexusAccess — Hook React para NexusGuard.
 * Verifica el token al montar y renueva la sesión cada HEARTBEAT_INTERVAL ms.
 */
import { useState, useEffect, useRef } from 'react';
import {
  verifyNexusAccess,
  heartbeatNexus,
  NexusEmpresa,
  NexusSubmodulo,
  NexusMetadata,
} from '../core/nexus-core';

export type { NexusEmpresa, NexusSubmodulo, NexusMetadata };

export type NexusAccessState =
  | { status: 'loading' }
  | {
      status: 'active';
      empresa: NexusEmpresa;
      submodulo: NexusSubmodulo;
      metadata?: NexusMetadata;
    }
  | { status: 'inactive'; reason: string }
  | { status: 'error'; reason: string };

/** Intervalo de heartbeat en ms. Default: 5 minutos. */
const HEARTBEAT_INTERVAL = 5 * 60 * 1000;

const NEXUS_API_URL =
  (import.meta as unknown as { env: Record<string, string> }).env
    .VITE_NEXUS_API_URL ?? '';

export function useNexusAccess(): NexusAccessState {
  const [state, setState] = useState<NexusAccessState>({ status: 'loading' });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!NEXUS_API_URL) {
      setState({
        status: 'error',
        reason: 'VITE_NEXUS_API_URL no está definida en .env',
      });
      return;
    }

    verifyNexusAccess(NEXUS_API_URL).then((result) => {
      if (result.active) {
        setState({
          status: 'active',
          empresa: result.empresa,
          submodulo: result.submodulo,
          metadata: result.metadata,
        });

        // Heartbeat automático mientras la app esté montada
        intervalRef.current = setInterval(async () => {
          const active = await heartbeatNexus(NEXUS_API_URL);
          if (!active) {
            setState({
              status: 'inactive',
              reason: 'Sesión expirada. Acceso suspendido.',
            });
            if (intervalRef.current) clearInterval(intervalRef.current);
          }
        }, HEARTBEAT_INTERVAL);
      } else {
        setState({ status: 'inactive', reason: result.reason });
      }
    });

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return state;
}
