/**
 * `submoduloId` opcional en `sso-delegate`: el integrador server-to-server (p. ej. nest-api para el link
 * "Renovar") fija el submódulo de entrada en vez de que Nexus lo adivine por puerto/nombre.
 * Sigue exigiendo que la empresa de la API key lo tenga activo (empresa_submodulo).
 */
export type SsoSubmoduloIdParse =
  | { ok: true; submoduloId: number | null }
  | { ok: false; message: string };

export function parseSsoSubmoduloId(raw: unknown): SsoSubmoduloIdParse {
  if (raw === undefined || raw === null || raw === '') return { ok: true, submoduloId: null };
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, message: 'submoduloId debe ser un entero positivo.' };
  }
  return { ok: true, submoduloId: n };
}
