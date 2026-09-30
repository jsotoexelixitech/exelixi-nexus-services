import type { ResolvedPortalCanal } from './portal-channel.service';

export type PortalFlowProduct = 'rcv' | 'funerario' | 'patrimoniales';
export type PortalSsoTarget = 'ocr' | 'emision';

export interface MappedSisProduct {
  key: string;
  label: string;
  description: string;
  target: PortalSsoTarget;
  product: PortalFlowProduct;
  defaultCramo: number;
  moduleLabel: string;
  cproducto: string;
  cramo: number;
  xform?: string;
  xlogo?: string;
  mmontoInicial?: string;
  xfraccionamiento?: string;
  xurlPresentacion?: string;
  marketplaceUrl?: string;
  marketplaceQr?: string;
  canal: ResolvedPortalCanal;
}

function numField(row: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = row[k];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

function strField(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v == null) continue;
    const t = String(v).trim();
    if (t) return t;
  }
  return '';
}

/** Ramos patrimoniales extra por entorno (ej. PORTAL_PATRIMONIAL_RAMOS=10,20). */
function patrimonialRamos(): Set<number> {
  return new Set(
    String(process.env.PORTAL_PATRIMONIAL_RAMOS ?? '')
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

/**
 * Misma regla que el marketplace SysIP (resolveMarketplaceIframeConfigKey): todo entra por OCR.
 * - RCV: xform rcv/ocr (o ramo 18 / producto 24).
 * - Patrimoniales: xform patrimonial o ramo en PORTAL_PATRIMONIAL_RAMOS.
 * - Resto (funerario, vida, AP, 4 en 1, combinados, salud…): flujo funerario con el
 *   producto real (cproducto, cramo, xproducto) en la metadata del SSO.
 */
function inferFlow(
  xform: string,
  cramo: number,
  cproducto: string,
): {
  target: PortalSsoTarget;
  product: PortalFlowProduct;
  moduleLabel: string;
} {
  const xf = xform.toLowerCase();
  if (
    xf.includes('rcv') ||
    xf.includes('ocr') ||
    xf === 'automobile' ||
    cramo === 18 ||
    cproducto === '24'
  ) {
    return {
      target: 'ocr',
      product: 'rcv',
      moduleLabel: 'OCR · inicio de flujo',
    };
  }
  if (xf.includes('patrimon') || patrimonialRamos().has(cramo)) {
    return {
      target: 'ocr',
      product: 'patrimoniales',
      moduleLabel: 'OCR · inicio de flujo',
    };
  }
  return {
    target: 'ocr',
    product: 'funerario',
    moduleLabel: 'OCR · inicio de flujo',
  };
}

export function mapSisProductRow(
  row: Record<string, unknown>,
  canal: ResolvedPortalCanal,
): MappedSisProduct | null {
  const cproducto = strField(row, 'cproducto', 'CPRODUCTO');
  if (!cproducto) return null;

  const cramo = numField(row, 'cramo', 'CRAMO') || 18;
  const xform = strField(row, 'xform', 'XFORM');
  const label =
    strField(row, 'xdescripcion_l', 'xproducto', 'XPRODUCTO') ||
    `Producto ${cproducto}`;
  const xlogo = strField(row, 'xlogo', 'xdescripcion_c', 'XLOGO');
  const descLong = strField(
    row,
    'xdescripcion_prod',
    'xdescripcion_l',
    'xproducto',
  );
  const mmontoInicial = strField(row, 'mmonto_inicial', 'MMONTO_INICIAL');
  const xfraccionamiento = strField(row, 'xfraccionamiento');
  const xurlPresentacion = strField(row, 'xurl_presentacion');
  const marketplaceUrl = strField(row, 'url');
  const marketplaceQr = strField(row, 'qr');

  const flow = inferFlow(xform, cramo, cproducto);

  return {
    key: `p-${cproducto}`,
    label,
    description: descLong || label,
    ...flow,
    defaultCramo: cramo,
    cproducto,
    cramo,
    xform: xform || undefined,
    xlogo: xlogo || undefined,
    mmontoInicial: mmontoInicial || undefined,
    xfraccionamiento: xfraccionamiento || undefined,
    xurlPresentacion: xurlPresentacion || undefined,
    marketplaceUrl: marketplaceUrl || undefined,
    marketplaceQr: marketplaceQr || undefined,
    canal,
  };
}
