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
    xf === 'automobile' ||
    xf === 'rcv-external' ||
    cramo === 18 ||
    cproducto === '24'
  ) {
    return {
      target: 'ocr',
      product: 'rcv',
      moduleLabel: 'OCR · inicio de flujo',
    };
  }
  if (
    xf.includes('funer') ||
    cramo === 9 ||
    cramo === 45 ||
    cproducto === '57'
  ) {
    return {
      target: 'ocr',
      product: 'funerario',
      moduleLabel: 'OCR · inicio de flujo',
    };
  }
  return {
    target: 'emision',
    product: 'patrimoniales',
    moduleLabel: 'Emisión',
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
  const xlogo = strField(row, 'xlogo', 'XLOGO');

  const flow = inferFlow(xform, cramo, cproducto);

  return {
    key: `p-${cproducto}`,
    label,
    description: label,
    ...flow,
    defaultCramo: cramo,
    cproducto,
    cramo,
    xform: xform || undefined,
    xlogo: xlogo || undefined,
    canal,
  };
}
