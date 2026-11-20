/**
 * Entrada al flujo por Emisión cuando el token trae una cotización de SysIP.
 *
 * Emitir RCV desde cotización: SysIP abre Emisión directamente (la cotización ya trae
 * plan, vehículo y tomador), así que OCR y Formulario no aplican. Sin esta regla,
 * start-from-token responde 409 ("no es el punto de entrada") y Emisión no puede
 * avanzar a Pagos.
 *
 * Solo se acepta si:
 *   - metadata.cotizacionID (o cotizacionId) es un número entero positivo de hasta 13 dígitos
 *     (la metadata viene del token firmado, no del body);
 *   - el submódulo del token está en la cadena y es Emisión;
 *   - hay al menos un submódulo después (Pagos).
 */

export interface FlowSlotRef {
  order: number;
  submoduloId: number;
  nombre: string;
  accessUrl: string;
}

const COTIZACION_ID_RE = /^\d{1,13}$/;

export function readCotizacionIdFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const meta = metadata as Record<string, unknown>;
  const raw = meta.cotizacionID ?? meta.cotizacionId;
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!COTIZACION_ID_RE.test(value) || Number(value) <= 0) return null;
  return value;
}

export function isEmisionSubmodulo(
  nombre: string,
  url: string | null,
): boolean {
  if (/emisi[oó]n/i.test(nombre)) return true;
  if (!url) return false;
  try {
    return /\/emision(\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Devuelve el slot de Emisión desde el que arranca la sesión, o null si no aplica
 * (en ese caso se mantiene la regla de siempre: solo el primer slot inicia el flujo).
 */
export function resolveCotizacionEntrySlot<T extends FlowSlotRef>(
  metadata: unknown,
  tokenSubmodulo: { id: number; nombre: string; url: string | null },
  rawSlots: T[],
): T | null {
  if (!readCotizacionIdFromMetadata(metadata)) return null;
  if (!isEmisionSubmodulo(tokenSubmodulo.nombre, tokenSubmodulo.url))
    return null;
  const slot = rawSlots.find((s) => s.submoduloId === tokenSubmodulo.id);
  if (!slot) return null;
  const hasNext = rawSlots.some((s) => s.order > slot.order);
  return hasNext ? slot : null;
}
