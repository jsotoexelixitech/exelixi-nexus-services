/**
 * NexusGuard — Componente que envuelve TODA la app de un servicio.
 *
 * Colócalo en el main.tsx / App.tsx de cada servicio externo:
 *
 *   import { NexusGuard } from './hooks/NexusGuard'
 *
 *   ReactDOM.createRoot(document.getElementById('root')!).render(
 *     <NexusGuard>
 *       <App />
 *     </NexusGuard>
 *   )
 *
 * Si el servicio está inactivo o el token es inválido → pantalla de bloqueo.
 * Si está activo → renderiza los children normalmente.
 * Los datos de empresa/submódulo se exponen via NexusContext.
 */

import React, { createContext, useContext, ReactNode } from 'react';
import { useNexusAccess, NexusEmpresa, NexusSubmodulo } from './useNexusAccess';
// core: ../core/nexus-core.ts

// ─── Context ─────────────────────────────────────────────────────────────────

type NexusContextValue = {
  empresa: NexusEmpresa;
  submodulo: NexusSubmodulo;
};

const NexusContext = createContext<NexusContextValue | null>(null);

export function useNexus(): NexusContextValue {
  const ctx = useContext(NexusContext);
  if (!ctx) throw new Error('useNexus debe usarse dentro de <NexusGuard>');
  return ctx;
}

// ─── Guard Component ─────────────────────────────────────────────────────────

type NexusGuardProps = {
  children: ReactNode;
  /** Nombre del servicio mostrado en la pantalla de bloqueo */
  serviceName?: string;
  /** URL del logo del servicio (opcional) */
  logoUrl?: string;
};

export function NexusGuard({
  children,
  serviceName = 'Servicio',
  logoUrl,
}: NexusGuardProps) {
  const access = useNexusAccess();

  if (access.status === 'loading') {
    return (
      <div style={styles.fullPage}>
        <div style={styles.card}>
          {logoUrl && <img src={logoUrl} alt={serviceName} style={styles.logo} />}
          <div style={styles.spinner} />
          <p style={styles.subtitle}>Verificando acceso…</p>
        </div>
      </div>
    );
  }

  if (access.status === 'inactive' || access.status === 'error') {
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

  // access.status === 'active'
  return (
    <NexusContext.Provider
      value={{ empresa: access.empresa, submodulo: access.submodulo }}
    >
      {children}
    </NexusContext.Provider>
  );
}

// ─── Inline styles (sin dependencias externas) ───────────────────────────────

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

// Keyframe injection (solo una vez)
if (typeof document !== 'undefined') {
  const styleId = '__nexus_guard_spin__';
  if (!document.getElementById(styleId)) {
    const tag = document.createElement('style');
    tag.id = styleId;
    tag.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(tag);
  }
}
