/** Catálogo compartido srv001 (dev) / srv001qa (QA). */
export const MODULO_RCV_CLASSIC = 7;
export const MODULO_RCV_QA = 14;

export const SUBS_RCV_CLASSIC = new Set([17, 18, 19, 20]);
export const SUBS_RCV_CIERRE = new Set([33, 34, 35, 36]);
export const SUBS_RCV_QA = new Set([37, 38, 39, 40]);

export type NexusDeployEnv = 'qa' | 'dev' | 'production' | 'neutral';

export function detectNexusDeployEnv(): NexusDeployEnv {
  const origin = (process.env.NEXUS_PUBLIC_ORIGIN || '').trim().toLowerCase();
  if (origin.includes('nexusqa')) return 'qa';
  if (origin.includes('cierrelmds')) return 'dev';
  if (
    origin.includes('exelixitech.com') &&
    !origin.includes('nexusqa') &&
    !origin.includes('cierrelmds')
  ) {
    return 'production';
  }
  return 'neutral';
}

function nombreEsCierre(nombre: string): boolean {
  return /\bcierre\b/i.test(nombre);
}

function urlEsCierrelmds(url: string | null | undefined): boolean {
  return (url || '').toLowerCase().includes('cierrelmds.exelixitech.com');
}

export interface SubmoduloCatalogRef {
  id: number;
  nombre?: string | null;
  url?: string | null;
  moduloId?: number | null;
}

/** Oculta duplicados dev/QA en pantallas de administración (no afecta verify/flow). */
export function isSubmoduloVisibleInAdminCatalog(
  sub: SubmoduloCatalogRef,
  env: NexusDeployEnv = detectNexusDeployEnv(),
): boolean {
  if (env === 'neutral') return true;

  const { id } = sub;
  const nombre = String(sub.nombre || '');
  const moduloId = sub.moduloId ?? undefined;

  if (env === 'qa') {
    if (moduloId === MODULO_RCV_CLASSIC) return false;
    if (SUBS_RCV_CLASSIC.has(id) || SUBS_RCV_CIERRE.has(id)) return false;
    if (nombreEsCierre(nombre)) return false;
    if (urlEsCierrelmds(sub.url)) return false;
  }

  if (env === 'dev') {
    if (moduloId === MODULO_RCV_QA || SUBS_RCV_QA.has(id)) return false;
    if (SUBS_RCV_CIERRE.has(id) || nombreEsCierre(nombre)) return false;
  }

  return true;
}

export function isModuloVisibleInAdminCatalog(
  modulo: { id: number },
  env: NexusDeployEnv = detectNexusDeployEnv(),
): boolean {
  if (env === 'neutral') return true;
  if (env === 'qa' && modulo.id === MODULO_RCV_CLASSIC) return false;
  if (env === 'dev' && modulo.id === MODULO_RCV_QA) return false;
  return true;
}

export function filterModulosForAdminCatalog<
  T extends { id: number; submodulos?: SubmoduloCatalogRef[] },
>(modulos: T[], env?: NexusDeployEnv): T[] {
  const deployEnv = env ?? detectNexusDeployEnv();
  if (deployEnv === 'neutral') return modulos;

  return modulos
    .filter((m) => isModuloVisibleInAdminCatalog(m, deployEnv))
    .map((m) => ({
      ...m,
      submodulos: (m.submodulos || []).filter((s) =>
        isSubmoduloVisibleInAdminCatalog(
          { ...s, moduloId: s.moduloId ?? m.id },
          deployEnv,
        ),
      ),
    }));
}
