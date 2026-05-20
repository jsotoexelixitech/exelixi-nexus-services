/**
 * nexus-core.ts — Núcleo framework-agnostic del NexusGuard SDK.
 *
 * Sin dependencias externas. Funciona en cualquier entorno JS/TS:
 * React, Vue, Svelte, Angular, Next.js, Vanilla JS, etc.
 *
 * Solo necesitas:
 *   - NEXUS_API_URL: la URL de tu servidor Nexus
 *   - El ?nexus_token= en la URL del navegador
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

export type NexusResult =
  | { active: true;  empresa: NexusEmpresa; submodulo: NexusSubmodulo }
  | { active: false; reason: string };

/**
 * Lee el nexus_token de la URL y lo verifica contra Nexus.
 * Retorna el resultado de la verificación.
 *
 * @param nexusApiUrl  URL base del servidor Nexus (sin /api al final)
 *                     Ej: "http://192.168.8.120:3091"
 */
export async function verifyNexusAccess(nexusApiUrl: string): Promise<NexusResult> {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('nexus_token');

  if (!token) {
    return {
      active: false,
      reason: 'No se proporcionó token de acceso. Contacte a su administrador.',
    };
  }

  try {
    const res = await fetch(`${nexusApiUrl.replace(/\/$/, '')}/api/access/verify`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await res.json();

    if (data.active) {
      return {
        active: true,
        empresa: data.empresa,
        submodulo: data.submodulo,
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
