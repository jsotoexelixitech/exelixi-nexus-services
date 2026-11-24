/**
 * NexusGuard — Componente que envuelve TODA la app de un servicio.
 *
 *   import { NexusGuard } from './nexus/NexusGuard';
 *
 *   ReactDOM.createRoot(document.getElementById('root')!).render(
 *     <NexusGuard nexusApiUrl={import.meta.env.VITE_NEXUS_API_URL} serviceName="RCV">
 *       <App />
 *     </NexusGuard>,
 *   );
 */

import React, { createContext, useContext, ReactNode } from 'react';
import {
  useNexusAccess,
  NexusEmpresa,
  NexusSubmodulo,
  NexusMetadata,
} from './useNexusAccess';

type NexusContextValue = {
  empresa: NexusEmpresa;
  submodulo: NexusSubmodulo;
  metadata?: NexusMetadata;
};

const NexusContext = createContext<NexusContextValue | null>(null);

export function useNexus(): NexusContextValue {
  const ctx = useContext(NexusContext);
  if (!ctx) throw new Error('useNexus debe usarse dentro de <NexusGuard>');
  return ctx;
}

type NexusGuardProps = {
  children: ReactNode;
  nexusApiUrl: string;
  serviceName?: string;
  logoUrl?: string;
};

export function NexusGuard({
  children,
  nexusApiUrl,
  serviceName = 'Servicio',
  logoUrl,
}: NexusGuardProps) {
  const access = useNexusAccess(nexusApiUrl);

  if (access.status === 'loading') {
    return (
      <div style={styles.fullPage}>
        <div style={styles.card}>
          {logoUrl && <img src={logoUrl} alt={serviceName} style={styles.logo} />}
          <div style={styles.spinner} />
          <p style={styles.subtitle}>Verificando acceso con Exélixi Nexus…</p>
        </div>
      </div>
    );
  }

  if (access.status === 'blocked') {
    return (
      <div style={styles.fullPage}>
        <div style={styles.card}>
          {logoUrl && <img src={logoUrl} alt={serviceName} style={styles.logo} />}
          <div style={styles.lockIcon}>🔒</div>
          <h1 style={styles.title}>Acceso no disponible</h1>
          <p style={styles.subtitle}>{access.reason}</p>
          <p style={styles.hint}>
            Si cree que esto es un error, contacte a su administrador.
          </p>
        </div>
      </div>
    );
  }

  return (
    <NexusContext.Provider
      value={{
        empresa: access.empresa,
        submodulo: access.submodulo,
        metadata: access.metadata,
      }}
    >
      {children}
    </NexusContext.Provider>
  );
}

const styles: Record<string, React.CSSProperties> = {
  fullPage: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #0C133A 0%, #1a2460 100%)',
    fontFamily: 'Inter, system-ui, sans-serif',
    zIndex: 9999,
  },
  card: {
    background: '#fff',
    borderRadius: '1.25rem',
    padding: '3rem 2.5rem',
    maxWidth: 420,
    width: '90%',
    textAlign: 'center',
    boxShadow: '0 25px 50px rgba(0,0,0,0.35)',
  },
  logo: {
    height: 48,
    marginBottom: '1.5rem',
    objectFit: 'contain',
  },
  lockIcon: {
    fontSize: '3rem',
    marginBottom: '1rem',
  },
  spinner: {
    width: 40,
    height: 40,
    border: '3px solid #e5e7eb',
    borderTop: '3px solid #ED7423',
    borderRadius: '50%',
    margin: '0 auto 1.5rem',
    animation: 'spin 0.8s linear infinite',
  },
  title: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: '#0C133A',
    margin: '0 0 0.75rem',
  },
  subtitle: {
    fontSize: '0.95rem',
    color: '#475569',
    margin: '0 0 0.5rem',
    lineHeight: 1.5,
  },
  hint: {
    fontSize: '0.8rem',
    color: '#94a3b8',
    marginTop: '1rem',
  },
};

if (typeof document !== 'undefined') {
  const styleId = '__nexus_guard_spin__';
  if (!document.getElementById(styleId)) {
    const tag = document.createElement('style');
    tag.id = styleId;
    tag.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(tag);
  }
}
