/**
 * Archivo cambiado después de analizarse (24-nov-2026, punto 2).
 *
 * Un documento puede validarse con un archivo y, más tarde, el archivo guardado en el disco del
 * OCR ser otro (sobrescrito) o haber desaparecido. Aquí se compara la huella sha256 del archivo
 * guardado hoy (ruta del OCR de solo lectura, SIN IA) con `archivoHash`, la del archivo analizado.
 *
 * Reglas:
 * - NO cambia el estado del documento ni de la póliza, NO envía correos, NO toca decisiones.
 * - Solo deja una marca informativa en `diagnostico.archivoCambiado` y un evento. No requiere
 *   migración (diagnostico es JSON). La marca se quita sola si la huella vuelve a coincidir; un
 *   análisis nuevo (otro archivo) reemplaza el diagnóstico y con él la marca.
 * - Solo mira requisitos validados/observados cuyo diagnóstico es del archivo actual
 *   (`analisisRef === ref`) y que tienen `archivoHash`.
 * - Apagado por defecto: EXPEDIENTES_HUELLAS_ENABLED=true habilita las rutas manuales (vista previa y
 *   aplicar); la revisión nocturna además exige EXPEDIENTES_HUELLAS_AUTO=true.
 * - Fallo del OCR en un lote: no cambia nada de ese lote y la pasada se detiene.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { caracasParts } from './expedientes.domain';
import {
  expedientesEnabled,
  expedientesJobsEnabled,
  ocrInternalConfig,
} from './expedientes.env';
import { huellasEnOcr, MAX_HUELLAS_OCR } from './expedientes.files';

export const CLAVE_ESTADO_HUELLAS = 'revision_huellas';
export const EVENTO_ARCHIVO_CAMBIADO = 'archivo_cambiado';
export const EVENTO_ARCHIVO_RESTITUIDO = 'archivo_restituido';
const TICK_MS = 60 * 1000;
const MUESTRA_MAX = 50;

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

export interface HuellasConfig {
  pausaMs: number;
  maxLotes: number;
  /** Hora de Caracas (0-23) de la revisión nocturna. */
  hora: number;
}

/** Apagada salvo EXPEDIENTES_ENABLED + EXPEDIENTES_HUELLAS_ENABLED=true y OCR interno configurado. */
export function huellasConfig(): HuellasConfig | null {
  if (!expedientesEnabled() || !flag('EXPEDIENTES_HUELLAS_ENABLED'))
    return null;
  if (!ocrInternalConfig()) return null;
  return {
    pausaMs: entero('EXPEDIENTES_HUELLAS_PAUSA_MS', 1500, 0, 60_000),
    maxLotes: entero('EXPEDIENTES_HUELLAS_MAX_LOTES', 60, 1, 500),
    hora: entero('EXPEDIENTES_HUELLAS_HORA', 3, 0, 23),
  };
}

export function huellasMotivoApagado(): string | null {
  if (huellasConfig()) return null;
  if (!expedientesEnabled()) return 'EXPEDIENTES_ENABLED apagado';
  if (!flag('EXPEDIENTES_HUELLAS_ENABLED'))
    return 'EXPEDIENTES_HUELLAS_ENABLED apagado';
  return 'Faltan OCR_INTERNAL_URL o EXPEDIENTE_INTERNAL_KEY';
}

// ─── Marca en el diagnóstico ────────────────────────────────────────────────

export interface MarcaArchivoCambiado {
  detectadoEn: string;
  /** 'otro' = hay un archivo con otra huella; 'no_existe' = ya no está en el disco. */
  motivo: 'otro' | 'no_existe';
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Marca vigente: solo si el diagnóstico es del archivo actual. */
export function marcaArchivoCambiado(r: {
  diagnostico?: unknown;
  analisisRef?: string | null;
  ref?: string | null;
}): MarcaArchivoCambiado | null {
  if (!r.ref || r.analisisRef !== r.ref) return null;
  const m = rec(rec(r.diagnostico).archivoCambiado);
  if (typeof m.detectadoEn !== 'string') return null;
  return {
    detectadoEn: m.detectadoEn,
    motivo: m.motivo === 'no_existe' ? 'no_existe' : 'otro',
  };
}

// ─── Resumen y estado ───────────────────────────────────────────────────────

export interface ResumenHuellas {
  vistaPrevia: boolean;
  origen: 'auto' | 'manual';
  inicio: string;
  fin: string;
  lotes: number;
  revisados: number;
  coinciden: number;
  /** Cambiados hoy y sin marca: se marcan (o se marcarían). */
  nuevosCambiados: number;
  /** Con marca previa que siguen cambiados. */
  yaMarcados: number;
  /** De los cambiados, los que ya no existen en el disco. */
  noExisten: number;
  /** Con marca previa y la huella volvió a coincidir: se quita (o se quitaría). */
  restituidos: number;
  /** Validados/observados sin diagnóstico donde guardar la marca. */
  sinDiagnostico: number;
  /** Filas realmente actualizadas (solo al aplicar). */
  actualizados: number;
  errores: number;
  ultimoError: string | null;
  /** Muestra (hasta 50) de los nuevos cambios, sin datos personales. */
  muestra: { expedienteId: number; tipo: string; motivo: string }[];
}

function resumenVacio(
  vistaPrevia: boolean,
  origen: 'auto' | 'manual',
): ResumenHuellas {
  return {
    vistaPrevia,
    origen,
    inicio: new Date().toISOString(),
    fin: '',
    lotes: 0,
    revisados: 0,
    coinciden: 0,
    nuevosCambiados: 0,
    yaMarcados: 0,
    noExisten: 0,
    restituidos: 0,
    sinDiagnostico: 0,
    actualizados: 0,
    errores: 0,
    ultimoError: null,
    muestra: [],
  };
}

let corriendo = false;
let ultimoResumen: ResumenHuellas | null = null;
let dormir = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
let ultimoDiaHuellas: string | null = null;
let huellasTimer: NodeJS.Timeout | null = null;

export function huellasCorriendo(): boolean {
  return corriendo;
}

/** Solo pruebas. */
export function _setDormirHuellas(fn: (ms: number) => Promise<void>): void {
  dormir = fn;
}

/** Solo pruebas. */
export function _resetHuellas(): void {
  corriendo = false;
  ultimoResumen = null;
  ultimoDiaHuellas = null;
  if (huellasTimer) clearInterval(huellasTimer);
  huellasTimer = null;
  dormir = (ms) => new Promise((r) => setTimeout(r, ms));
}

async function guardarResumen(r: ResumenHuellas): Promise<void> {
  const data = {
    valor: r as unknown as Prisma.InputJsonValue,
    actualizadoPor: 'revision_huellas',
  };
  try {
    await prisma.mktExpedienteConfig.update({
      where: { clave: CLAVE_ESTADO_HUELLAS },
      data,
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2025') throw err;
    await prisma.mktExpedienteConfig.create({
      data: { clave: CLAVE_ESTADO_HUELLAS, ...data },
    });
  }
}

export async function vistaHuellas() {
  let ultimo = ultimoResumen;
  if (!ultimo) {
    const row = await prisma.mktExpedienteConfig.findUnique({
      where: { clave: CLAVE_ESTADO_HUELLAS },
    });
    if (row?.valor && typeof row.valor === 'object' && !Array.isArray(row.valor))
      ultimo = row.valor as unknown as ResumenHuellas;
  }
  const cfg = huellasConfig();
  return {
    habilitada: !!cfg,
    automatica:
      !!cfg && expedientesJobsEnabled() && flag('EXPEDIENTES_HUELLAS_AUTO'),
    motivoApagada: huellasMotivoApagado(),
    horaCaracas: cfg?.hora ?? null,
    enCurso: corriendo,
    ultimo,
  };
}

// ─── Pasada ─────────────────────────────────────────────────────────────────

export interface OpcionesHuellas {
  /** true (por defecto en la ruta): consulta y cuenta sin escribir. */
  vistaPrevia: boolean;
  origen?: 'auto' | 'manual';
  actor?: string;
}

export async function revisarHuellas(
  opts: OpcionesHuellas,
): Promise<ResumenHuellas | { omitido: true; motivo: string }> {
  const cfg = huellasConfig();
  if (!cfg) return { omitido: true, motivo: huellasMotivoApagado() ?? 'apagada' };
  if (corriendo) return { omitido: true, motivo: 'en_curso' };
  corriendo = true;
  const resumen = resumenVacio(opts.vistaPrevia, opts.origen ?? 'manual');
  const actor = (opts.actor ?? 'revision_huellas').slice(0, 128);
  try {
    let ultimoId = 0;
    for (let lote = 0; lote < cfg.maxLotes; lote++) {
      const filas = await prisma.mktExpedienteRequisito.findMany({
        where: {
          id: { gt: ultimoId },
          estado: { in: ['validado', 'observado'] },
          AND: [
            { ref: { not: null } },
            { archivoHash: { not: null } },
            { analisisRef: { not: null } },
          ],
        },
        orderBy: { id: 'asc' },
        take: MAX_HUELLAS_OCR,
      });
      if (!filas.length) break;
      ultimoId = filas[filas.length - 1].id;
      // Solo el diagnóstico del archivo actual (el hash guardado es de analisisRef).
      const vigentes = filas.filter((f) => f.ref && f.analisisRef === f.ref);
      resumen.lotes++;
      if (vigentes.length) {
        let huellas: Awaited<ReturnType<typeof huellasEnOcr>>;
        try {
          huellas = await huellasEnOcr([
            ...new Set(vigentes.map((f) => f.ref as string)),
          ]);
        } catch (err) {
          resumen.errores++;
          resumen.ultimoError = (
            err instanceof Error ? err.message : 'error'
          ).slice(0, 200);
          logger.warn(`[expedientes] huellas: ${resumen.ultimoError}`);
          break; // sin cambios en el lote; se reintenta en la próxima pasada
        }
        for (const f of vigentes) {
          const h = huellas.get(f.ref as string);
          // El OCR no devolvió la ruta: no se juzga.
          if (!h) continue;
          resumen.revisados++;
          const coincide = h.existe && h.hash === f.archivoHash;
          const marca = marcaArchivoCambiado(f);
          const diag = rec(f.diagnostico);
          if (coincide) {
            resumen.coinciden++;
            if (!marca) continue;
            resumen.restituidos++;
            if (opts.vistaPrevia) continue;
            const resto = { ...diag };
            delete resto.archivoCambiado;
            await aplicar(f, resto, 'restituido', actor, resumen);
            continue;
          }
          const motivo: 'otro' | 'no_existe' = h.existe ? 'otro' : 'no_existe';
          if (marca) {
            resumen.yaMarcados++;
            continue;
          }
          if (!Object.keys(diag).length) {
            resumen.sinDiagnostico++;
            continue;
          }
          resumen.nuevosCambiados++;
          if (motivo === 'no_existe') resumen.noExisten++;
          if (resumen.muestra.length < MUESTRA_MAX)
            resumen.muestra.push({
              expedienteId: f.expedienteId,
              tipo: f.tipo,
              motivo,
            });
          if (opts.vistaPrevia) continue;
          await aplicar(
            f,
            {
              ...diag,
              archivoCambiado: {
                detectadoEn: new Date().toISOString(),
                motivo,
              },
            },
            motivo,
            actor,
            resumen,
          );
        }
      }
      if (filas.length < MAX_HUELLAS_OCR) break;
      if (cfg.pausaMs > 0) await dormir(cfg.pausaMs);
    }
  } catch (err) {
    resumen.errores++;
    resumen.ultimoError = (err instanceof Error ? err.message : 'error').slice(
      0,
      200,
    );
    logger.error(`[expedientes] huellas: ${resumen.ultimoError}`);
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
        `[expedientes] huellas: no se pudo guardar el resumen: ${err instanceof Error ? err.message : 'error'}`,
      );
    }
  }
  return resumen;
}

/** Escribe solo `diagnostico`, de forma condicional (mismo archivo y mismo estado). Sin tocar estado. */
async function aplicar(
  f: {
    id: number;
    expedienteId: number;
    tipo: string;
    estado: string;
    ref: string | null;
    analisisRef: string | null;
    archivoHash: string | null;
    validadoEn: Date | null;
  },
  diagnostico: Record<string, unknown>,
  que: 'otro' | 'no_existe' | 'restituido',
  actor: string,
  resumen: ResumenHuellas,
): Promise<void> {
  const r = await prisma.mktExpedienteRequisito.updateMany({
    where: {
      id: f.id,
      estado: f.estado,
      ref: f.ref,
      analisisRef: f.analisisRef,
      archivoHash: f.archivoHash,
    },
    data: { diagnostico: diagnostico as Prisma.InputJsonValue },
  });
  if (r.count !== 1) return;
  resumen.actualizados++;
  await prisma.mktExpedienteEvento.create({
    data: {
      expedienteId: f.expedienteId,
      tipo:
        que === 'restituido' ? EVENTO_ARCHIVO_RESTITUIDO : EVENTO_ARCHIVO_CAMBIADO,
      actor,
      detalle: {
        tipo: f.tipo,
        estado: f.estado,
        ...(que === 'restituido' ? {} : { motivo: que }),
        validadoEn: f.validadoEn ? f.validadoEn.toISOString() : null,
      } as Prisma.InputJsonValue,
    },
  });
}

// ─── Programación (una pasada por noche, hora de Caracas) ───────────────────

export async function tickHuellas(
  ahora: Date = new Date(),
): Promise<ResumenHuellas | null> {
  if (
    !expedientesJobsEnabled() ||
    !flag('EXPEDIENTES_HUELLAS_AUTO') ||
    corriendo
  )
    return null;
  const cfg = huellasConfig();
  if (!cfg) return null;
  const { fecha, hora } = caracasParts(ahora);
  if (Number(hora.slice(0, 2)) !== cfg.hora || ultimoDiaHuellas === fecha)
    return null;
  ultimoDiaHuellas = fecha;
  try {
    const r = await revisarHuellas({
      vistaPrevia: false,
      origen: 'auto',
      actor: 'scheduler',
    });
    return 'omitido' in r ? null : r;
  } catch (err) {
    logger.error(
      `[expedientes] huellas: ${err instanceof Error ? err.message : 'error'}`,
    );
    return null;
  }
}

export function iniciarSchedulerHuellas(): void {
  if (huellasTimer) return;
  huellasTimer = setInterval(() => {
    void tickHuellas();
  }, TICK_MS);
  huellasTimer.unref();
}

export function detenerSchedulerHuellas(): void {
  if (huellasTimer) clearInterval(huellasTimer);
  huellasTimer = null;
  ultimoDiaHuellas = null;
}
