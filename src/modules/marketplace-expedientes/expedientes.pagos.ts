/**
 * Sincronización del estado de pago del monitor con Sis2000 (24-nov-2026).
 *
 * El monitor guardaba `estadoPago` una sola vez al emitir. Aquí, cada hora (apagado por defecto),
 * se toman los expedientes `pendiente` con recibo, se consulta a nest-api el estado de cobro del
 * recibo (POST /api/v1/canal/recibos-estado, scope expedientes:pagos, solo lectura sobre
 * adrecibos) y los cobrados (iestadorec = 'C') pasan a `pagada`.
 *
 * Reglas:
 * - Solo pendiente → pagada, con UPDATE condicional (`where estadoPago = 'pendiente'`). Nunca al revés.
 * - P (pendiente) sin cambio; A (anulado), otros valores y no encontrados: sin cambio, contados aparte.
 * - Si el cnpoliza que devuelve Sis2000 no es el del expediente: no se marca y se cuenta.
 * - NO envía correos, NO toca documentos ni requisitos, NO llama a la IA. Deja un evento
 *   `estado_pago_sis2000` en el historial del expediente (origen Sis2000, fecha de cobro).
 * - Fallo de nest-api: no cambia nada del lote y se reintenta en la próxima pasada.
 * - Vista previa: consulta y cuenta sin escribir nada en la base.
 * - EXPEDIENTES_PAGOS_ENABLED solo habilita las rutas manuales (vista previa y aplicar); la tarea
 *   automática además exige EXPEDIENTES_PAGOS_AUTO=true, para ver el conteo antes de escribir.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { ESTADO_DESCARTADA } from './expedientes.domain';
import { expedientesEnabled, expedientesJobsEnabled } from './expedientes.env';

export const CLAVE_ESTADO_PAGOS = 'sync_pagos';
export const EVENTO_PAGO_SIS2000 = 'estado_pago_sis2000';
export const LOTE_PAGOS = 200;
const TIMEOUT_NEST_MS = 60_000;
const TICK_MS = 60 * 1000;

// ─── Configuración (variables propias; URL y key caen en las de la carga histórica) ──

export interface PagosConfig {
  nestUrl: string;
  nestKey: string;
  /** Cada cuántos minutos corre la pasada automática. */
  cadaMin: number;
  /** Pausa entre lotes de 200. */
  pausaMs: number;
  /** Tope de lotes por pasada. */
  maxLotes: number;
}

function flag(name: string): boolean {
  return (
    String(process.env[name] ?? '')
      .trim()
      .toLowerCase() === 'true'
  );
}

function entero(name: string, def: number, min: number, max: number): number {
  const raw = String(process.env[name] ?? '').trim();
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function varTexto(...nombres: string[]): string {
  for (const n of nombres) {
    const v = String(process.env[n] ?? '').trim();
    if (v) return v;
  }
  return '';
}

/** Apagada salvo EXPEDIENTES_ENABLED + EXPEDIENTES_PAGOS_ENABLED=true con URL y key. */
export function pagosConfig(): PagosConfig | null {
  if (!expedientesEnabled() || !flag('EXPEDIENTES_PAGOS_ENABLED')) return null;
  const nestUrl = varTexto(
    'EXPEDIENTES_PAGOS_NEST_URL',
    'EXPEDIENTES_HISTORICO_NEST_URL',
  ).replace(/\/+$/, '');
  const nestKey = varTexto(
    'EXPEDIENTES_PAGOS_NEST_KEY',
    'EXPEDIENTES_HISTORICO_NEST_KEY',
  );
  if (!nestUrl || !nestKey) return null;
  return {
    nestUrl,
    nestKey,
    cadaMin: entero('EXPEDIENTES_PAGOS_CADA_MIN', 60, 5, 1440),
    pausaMs: entero('EXPEDIENTES_PAGOS_PAUSA_MS', 2000, 0, 60_000),
    maxLotes: entero('EXPEDIENTES_PAGOS_MAX_LOTES', 25, 1, 200),
  };
}

export function pagosMotivoApagado(): string | null {
  if (pagosConfig()) return null;
  if (!expedientesEnabled()) return 'EXPEDIENTES_ENABLED apagado';
  if (!flag('EXPEDIENTES_PAGOS_ENABLED'))
    return 'EXPEDIENTES_PAGOS_ENABLED apagado';
  return 'Faltan EXPEDIENTES_PAGOS_NEST_URL o EXPEDIENTES_PAGOS_NEST_KEY';
}

// ─── nest-api ───────────────────────────────────────────────────────────────

export interface ReciboSis2000 {
  cnrecibo: string;
  cnpoliza: string | null;
  iestadorec: string | null;
  fcobro: string | null;
}

export function urlRecibosEstado(nestUrl: string): string {
  const base = nestUrl.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${base}/api/v1/canal/recibos-estado`;
}

function texto(v: unknown): string | null {
  const s = v == null ? '' : String(v).trim();
  return s || null;
}

/** Misma normalización que el módulo para pólizas (trim); además sin distinguir mayúsculas. */
export function normPoliza(v: unknown): string {
  return String(v ?? '')
    .trim()
    .toUpperCase();
}

export async function consultarRecibos(
  cfg: Pick<PagosConfig, 'nestUrl' | 'nestKey'>,
  recibos: string[],
): Promise<Map<string, ReciboSis2000>> {
  const res = await fetch(urlRecibosEstado(cfg.nestUrl), {
    method: 'POST',
    headers: {
      apikey: cfg.nestKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ recibos }),
    signal: AbortSignal.timeout(TIMEOUT_NEST_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.status === false) {
    // Sin cuerpo en el mensaje: puede traer datos de la consulta.
    throw new Error(`nest-api respondió HTTP ${res.status}`);
  }
  const data = Array.isArray(body.data) ? body.data : null;
  if (!data) throw new Error('nest-api: respuesta sin data');
  const out = new Map<string, ReciboSis2000>();
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const cnrecibo = texto(r.cnrecibo);
    if (!cnrecibo) continue;
    out.set(cnrecibo.toUpperCase(), {
      cnrecibo,
      cnpoliza: texto(r.cnpoliza),
      iestadorec: texto(r.iestadorec)?.toUpperCase() ?? null,
      fcobro: texto(r.fcobro),
    });
  }
  return out;
}

// ─── Resumen y estado ───────────────────────────────────────────────────────

export interface ResumenPagos {
  vistaPrevia: boolean;
  origen: 'auto' | 'manual';
  inicio: string;
  fin: string;
  lotes: number;
  revisados: number;
  /** Cobrados en Sis2000 (C) y con póliza coincidente: pasan (o pasarían) a pagada. */
  cobrados: number;
  /** De los cobrados, los que la actualización condicional realmente cambió. */
  actualizados: number;
  /** P en Sis2000: siguen pendientes. */
  pendientes: number;
  anulados: number;
  noEncontrados: number;
  /** Estado de Sis2000 distinto de P/C/A. */
  otrosEstados: number;
  polizaDistinta: number;
  /** Lotes que fallaron (red, HTTP): no cambió nada en ellos. */
  errores: number;
  ultimoError: string | null;
}

function resumenVacio(
  vistaPrevia: boolean,
  origen: 'auto' | 'manual',
): ResumenPagos {
  return {
    vistaPrevia,
    origen,
    inicio: new Date().toISOString(),
    fin: '',
    lotes: 0,
    revisados: 0,
    cobrados: 0,
    actualizados: 0,
    pendientes: 0,
    anulados: 0,
    noEncontrados: 0,
    otrosEstados: 0,
    polizaDistinta: 0,
    errores: 0,
    ultimoError: null,
  };
}

let corriendo = false;
let ultimoResumen: ResumenPagos | null = null;
let dormir = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export function pagosCorriendo(): boolean {
  return corriendo;
}

/** Solo pruebas. */
export function _setDormirPagos(fn: (ms: number) => Promise<void>): void {
  dormir = fn;
}

/** Solo pruebas. */
export function _resetPagos(): void {
  corriendo = false;
  ultimoResumen = null;
  ultimaTandaPagos = null;
  if (pagosTimer) clearInterval(pagosTimer);
  pagosTimer = null;
  dormir = (ms) => new Promise((r) => setTimeout(r, ms));
}

async function guardarResumen(r: ResumenPagos): Promise<void> {
  const data = {
    valor: r as unknown as Prisma.InputJsonValue,
    actualizadoPor: 'sync_pagos',
  };
  try {
    await prisma.mktExpedienteConfig.update({
      where: { clave: CLAVE_ESTADO_PAGOS },
      data,
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2025') throw err;
    await prisma.mktExpedienteConfig.create({
      data: { clave: CLAVE_ESTADO_PAGOS, ...data },
    });
  }
}

/** Último resumen (el de la memoria si es más reciente; si no, el guardado de una corrida real). */
export async function vistaPagos() {
  let ultimo = ultimoResumen;
  if (!ultimo) {
    const row = await prisma.mktExpedienteConfig.findUnique({
      where: { clave: CLAVE_ESTADO_PAGOS },
    });
    if (row?.valor && typeof row.valor === 'object' && !Array.isArray(row.valor))
      ultimo = row.valor as unknown as ResumenPagos;
  }
  const cfg = pagosConfig();
  return {
    habilitada: !!cfg,
    automatica: !!cfg && expedientesJobsEnabled() && flag('EXPEDIENTES_PAGOS_AUTO'),
    motivoApagada: pagosMotivoApagado(),
    cadaMin: cfg?.cadaMin ?? null,
    enCurso: corriendo,
    ultimo,
  };
}

// ─── Pasada ─────────────────────────────────────────────────────────────────

export interface OpcionesPagos {
  /** true (por defecto en la ruta): consulta y cuenta sin escribir. */
  vistaPrevia: boolean;
  origen?: 'auto' | 'manual';
  actor?: string;
}

/**
 * Una pasada completa: lotes de ≤200 en orden estable por id, con pausa entre lotes. Si nest-api
 * falla en un lote, ese lote no cambia nada y la pasada se detiene (reintento en la siguiente).
 */
export async function ejecutarSincronizacionPagos(
  opts: OpcionesPagos,
): Promise<ResumenPagos | { omitido: true; motivo: string }> {
  const cfg = pagosConfig();
  if (!cfg) return { omitido: true, motivo: pagosMotivoApagado() ?? 'apagada' };
  if (corriendo) return { omitido: true, motivo: 'en_curso' };
  corriendo = true;
  const resumen = resumenVacio(opts.vistaPrevia, opts.origen ?? 'manual');
  const actor = (opts.actor ?? 'sync_pagos').slice(0, 128);
  try {
    let ultimoId = 0;
    for (let lote = 0; lote < cfg.maxLotes; lote++) {
      const exps = await prisma.mktExpediente.findMany({
        where: {
          estadoPago: 'pendiente',
          id: { gt: ultimoId },
          estadoDocumental: { not: ESTADO_DESCARTADA },
          AND: [{ cnrecibo: { not: null } }, { cnrecibo: { not: '' } }],
        },
        orderBy: { id: 'asc' },
        take: LOTE_PAGOS,
        select: { id: true, cnpoliza: true, cnrecibo: true },
      });
      if (!exps.length) break;
      ultimoId = exps[exps.length - 1].id;
      const recibos = [
        ...new Set(
          exps
            .map((e) => String(e.cnrecibo ?? '').trim())
            .filter((r) => r !== ''),
        ),
      ];
      if (!recibos.length) continue;
      resumen.lotes++;
      let sis: Map<string, ReciboSis2000>;
      try {
        sis = await consultarRecibos(cfg, recibos);
      } catch (err) {
        resumen.errores++;
        resumen.ultimoError = (
          err instanceof Error ? err.message : 'error'
        ).slice(0, 200);
        logger.warn(`[expedientes] pagos: ${resumen.ultimoError}`);
        break; // sin cambios en el lote; se reintenta en la próxima pasada
      }
      for (const e of exps) {
        const rec = sis.get(String(e.cnrecibo ?? '').trim().toUpperCase());
        resumen.revisados++;
        if (!rec) {
          resumen.noEncontrados++;
          continue;
        }
        const estado = rec.iestadorec;
        if (estado === 'P') {
          resumen.pendientes++;
          continue;
        }
        if (estado === 'A') {
          resumen.anulados++;
          continue;
        }
        if (estado !== 'C') {
          resumen.otrosEstados++;
          continue;
        }
        if (normPoliza(rec.cnpoliza) !== normPoliza(e.cnpoliza)) {
          resumen.polizaDistinta++;
          continue;
        }
        resumen.cobrados++;
        if (opts.vistaPrevia) continue;
        // Condicional: nunca pisa a un expediente que ya no está pendiente.
        const r = await prisma.mktExpediente.updateMany({
          where: { id: e.id, estadoPago: 'pendiente' },
          data: { estadoPago: 'pagada' },
        });
        if (r.count === 1) {
          resumen.actualizados++;
          await prisma.mktExpedienteEvento.create({
            data: {
              expedienteId: e.id,
              tipo: EVENTO_PAGO_SIS2000,
              actor,
              detalle: {
                origen: 'Sis2000',
                cnrecibo: rec.cnrecibo,
                fcobro: rec.fcobro,
                estadoPagoAntes: 'pendiente',
                estadoPagoDespues: 'pagada',
              } as Prisma.InputJsonValue,
            },
          });
        }
      }
      if (exps.length < LOTE_PAGOS) break;
      if (cfg.pausaMs > 0) await dormir(cfg.pausaMs);
    }
  } catch (err) {
    resumen.errores++;
    resumen.ultimoError = (err instanceof Error ? err.message : 'error').slice(
      0,
      200,
    );
    logger.error(`[expedientes] pagos: ${resumen.ultimoError}`);
  } finally {
    corriendo = false;
  }
  resumen.fin = new Date().toISOString();
  ultimoResumen = resumen;
  if (!opts.vistaPrevia) {
    try {
      await guardarResumen(resumen);
    } catch (err) {
      logger.error(
        `[expedientes] pagos: no se pudo guardar el resumen: ${err instanceof Error ? err.message : 'error'}`,
      );
    }
  }
  return resumen;
}

// ─── Programación (cada EXPEDIENTES_PAGOS_CADA_MIN minutos) ─────────────────

let ultimaTandaPagos: string | null = null;
let pagosTimer: NodeJS.Timeout | null = null;

/** Clave de la tanda: un bloque de `cadaMin` minutos desde la época. */
export function claveTandaPagos(ahora: Date, cadaMin: number): string {
  return `p${Math.floor(ahora.getTime() / 60_000 / Math.max(1, cadaMin))}`;
}

export async function tickPagos(
  ahora: Date = new Date(),
): Promise<ResumenPagos | null> {
  if (!expedientesJobsEnabled() || !flag('EXPEDIENTES_PAGOS_AUTO') || corriendo)
    return null;
  const cfg = pagosConfig();
  if (!cfg) return null;
  const clave = claveTandaPagos(ahora, cfg.cadaMin);
  if (ultimaTandaPagos === clave) return null;
  ultimaTandaPagos = clave;
  try {
    const r = await ejecutarSincronizacionPagos({
      vistaPrevia: false,
      origen: 'auto',
      actor: 'scheduler',
    });
    return 'omitido' in r ? null : r;
  } catch (err) {
    logger.error(
      `[expedientes] pagos: ${err instanceof Error ? err.message : 'error'}`,
    );
    return null;
  }
}

export function iniciarSchedulerPagos(): void {
  if (pagosTimer) return;
  pagosTimer = setInterval(() => {
    void tickPagos();
  }, TICK_MS);
  pagosTimer.unref();
}

export function detenerSchedulerPagos(): void {
  if (pagosTimer) clearInterval(pagosTimer);
  pagosTimer = null;
  ultimaTandaPagos = null;
}
