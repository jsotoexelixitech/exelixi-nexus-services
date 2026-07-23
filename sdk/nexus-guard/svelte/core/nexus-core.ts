/**
 * nexus-core.ts — Núcleo framework-agnostic del NexusGuard SDK.
 *
 * Sin dependencias externas. Funciona en cualquier entorno JS/TS:
 * React, Vue, Svelte, Angular, Next.js, Vanilla JS, etc.
 *
 * Solo necesitas:
 *   - NEXUS_API_URL: la URL de tu servidor Nexus
 *   - El ?nexus_token= en la URL del navegador (o sessionStorage)
 */

export type NexusEmpresa = {
  id: number;
  nombre: string;
  rif: string;
};

export type NexusSubmodulo = {
  id: number;
  nombre: string;
  url: string | null;
};

/** Metadata opcional embebida en el token SSO (p. ej. cproductor, canal). */
export type NexusMetadata = {
  cproductor?: string;
  canal?: string;
  cramo?: number;
  cusuario?: string;
  ctipo?: number;
  [key: string]: unknown;
};

export type NexusResult =
  | {
      active: true;
      empresa: NexusEmpresa;
      submodulo: NexusSubmodulo;
      metadata?: NexusMetadata;
    }
  | { active: false; reason: string };

const SESSION_KEY = '__nexus_token__';

// ── Almacenamiento del token activo ─────────────────────────────────────────

/** Devuelve el token activo en memoria (sessionStorage). */
export function getNexusToken(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

/** Guarda el token en sessionStorage (sobrescribe el anterior). */
export function setNexusToken(token: string): void {
  try {
    sessionStorage.setItem(SESSION_KEY, token);
  } catch {
    /* entorno sin sessionStorage (SSR, worker) */
  }
}

/** Lee la URL y devuelve el nexus_token si está presente. */
export function getTokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('nexus_token');
}

// ── Verificación y heartbeat ─────────────────────────────────────────────────

/**
 * Lee el nexus_token (URL → sessionStorage) y lo verifica contra Nexus.
 * Guarda el token en sessionStorage para uso posterior.
 *
 * @param nexusApiUrl  URL base del servidor Nexus. Ej: "http://192.168.8.120:3091"
 */
export async function verifyNexusAccess(
  nexusApiUrl: string,
): Promise<NexusResult> {
  const urlToken = getTokenFromUrl();
  const storedToken = getNexusToken();
  const token = urlToken ?? storedToken;

  if (!token) {
    return {
      active: false,
      reason: 'No se proporcionó token de acceso. Contacte a su administrador.',
    };
  }

  try {
    const res = await fetch(
      `${nexusApiUrl.replace(/\/$/, '')}/api/access/verify`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );

    // Token renovado en tránsito — lo guardamos
    const refreshed = res.headers.get('X-Nexus-Token-Refreshed');
    if (refreshed) setNexusToken(refreshed);
    else if (urlToken) setNexusToken(urlToken);

    const data = await res.json();

    if (data.active) {
      return {
        active: true,
        empresa: data.empresa,
        submodulo: data.submodulo,
        metadata: data.metadata,
      };
    }

    return {
      active: false,
      reason: data.reason ?? 'Servicio no disponible para esta empresa.',
    };
  } catch {
    return {
      active: false,
      reason: 'No se pudo conectar con el servidor de autorización.',
    };
  }
}

/**
 * Llama al heartbeat para renovar la sesión y guardar el nuevo token.
 * Retorna true si la sesión sigue activa, false si fue suspendida.
 * Llamar cada 5 minutos mientras la app esté en uso (useNexusAccess lo hace).
 *
 * @param nexusApiUrl  URL base del servidor Nexus.
 */
export async function heartbeatNexus(nexusApiUrl: string): Promise<boolean> {
  const token = getNexusToken();
  if (!token) return false;

  try {
    const res = await fetch(
      `${nexusApiUrl.replace(/\/$/, '')}/api/access/heartbeat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );

    if (!res.ok) return false;

    const data = await res.json();
    if (data.access_token) setNexusToken(data.access_token);
    return data.active !== false;
  } catch {
    return true; // fail-open: no cortar la sesión por fallo de red
  }
}

/**
 * Crea un fetch estándar que incluye automáticamente el token activo y
 * captura el header X-Nexus-Token-Refreshed para mantenerlo actualizado.
 *
 * Úsalo como reemplazo de fetch() en los módulos frontend:
 *   const data = await nexusFetch('/api/planes').then(r => r.json())
 *
 * @param input   URL de la petición (relativa o absoluta).
 * @param init    Opciones de fetch estándar.
 */
export function nexusFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = getNexusToken();
  const headers = new Headers(init.headers as HeadersInit | undefined);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  return fetch(input, { ...init, headers }).then((res) => {
    const refreshed = res.headers.get('X-Nexus-Token-Refreshed');
    if (refreshed) setNexusToken(refreshed);
    return res;
  });
}
