/**
 * Tareas del monitor (hora Caracas). Cada ejecución automática se registra en
 * `mkt_expediente_job_run` con único (job, fecha): si el proceso reinicia o hay
 * varias instancias, la tarea del día corre una sola vez. Si el reporte nocturno no se entrega,
 * se reintenta hasta 3 veces esa misma noche con clave `<fecha>~reintento~<n>`.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { caracasParts } from './expedientes.domain';
import { expedientesJobsEnabled } from './expedientes.env';
import {
  alertaReporteFallido,
  MAX_REINTENTOS_NOCTURNA,
  tareaDiaria,
  tareaNocturna,
} from './expedientes.tareas';
import { expedientesService as svc } from './expedientes.service';
import type { JobName } from './expedientes.schema';

export interface EjecutarJobOpts {
  origen: 'auto' | 'manual';
  /** Solo manual: corre aunque ya exista la ejecución del día (clave aparte). */
  forzar?: boolean;
  actor?: string;
  ahora?: Date;
  /** Solo nocturna: reintento n (1 a 3) del reporte del día `fechaReporte`. */
  reintento?: number;
  /** Solo nocturna: día del reporte (YYYY-MM-DD, Caracas); por defecto, el de `ahora`. */
  fechaReporte?: string;
}

export type JobResultado =
  | { job: JobName; fecha: string; omitido: true; motivo: string }
  | {
      job: JobName;
      fecha: string;
      omitido: false;
      estado: 'ok' | 'error';
      resumen: unknown;
    };

async function correr(
  job: JobName,
  ahora: Date,
  opts: EjecutarJobOpts,
): Promise<Record<string, unknown>> {
  switch (job) {
    case 'conciliacion':
      return { conciliacion: await svc.conciliar() };
    case 'diaria':
      return tareaDiaria(ahora);
    case 'nocturna':
      return tareaNocturna(ahora, {
        fecha: opts.fechaReporte,
        intento: opts.reintento,
      });
    case 'validacion_ia':
      return {
        validacionIa: await svc.revisarConIa({ modo: 'completo', ahora }),
      };
    default:
      throw new Error(`Tarea ${String(job)} no implementada`);
  }
}

export async function ejecutarJob(
  job: JobName,
  opts: EjecutarJobOpts,
): Promise<JobResultado> {
  const ahora = opts.ahora ?? new Date();
  const { fecha } = caracasParts(ahora);
  const clave = opts.reintento
    ? `${opts.fechaReporte ?? fecha}~reintento~${opts.reintento}`
    : opts.origen === 'manual' && opts.forzar
      ? `${fecha}~manual~${ahora.getTime()}`
      : fecha;

  let runId: number;
  try {
    const run = await prisma.mktExpedienteJobRun.create({
      data: { job, fecha: clave, origen: opts.origen, estado: 'en_curso' },
    });
    runId = run.id;
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return { job, fecha: clave, omitido: true, motivo: 'ya_ejecutado_hoy' };
    }
    throw err;
  }

  try {
    const resumen = await correr(job, ahora, opts);
    await prisma.mktExpedienteJobRun.update({
      where: { id: runId },
      data: {
        estado: 'ok',
        fin: new Date(),
        resumen: {
          ...resumen,
          actor: opts.actor ?? 'scheduler',
        } as Prisma.InputJsonValue,
      },
    });
    logger.info(`[expedientes] tarea ${job} ${clave} ok`);
    return { job, fecha: clave, omitido: false, estado: 'ok', resumen };
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 500) : 'error';
    await prisma.mktExpedienteJobRun.update({
      where: { id: runId },
      data: { estado: 'error', fin: new Date(), error: msg },
    });
    await svc.eventoTecnico({ etapa: `job_${job}`, error: msg });
    logger.error(`[expedientes] tarea ${job} ${clave} falló: ${msg}`);
    // El reporte no salió: alerta y el scheduler lo reintenta esta noche.
    if (job === 'nocturna')
      await alertaReporteFallido({
        fecha: opts.fechaReporte ?? fecha,
        intento: opts.reintento ?? 0,
        error: msg,
      });
    return {
      job,
      fecha: clave,
      omitido: false,
      estado: 'error',
      resumen: { error: msg },
    };
  }
}

// ─── Reintentos del reporte nocturno ────────────────────────────────────────

/** Espera (minutos) antes de cada reintento, contada desde el intento anterior. */
export const ESPERAS_REINTENTO_NOCTURNA_MIN = [5, 15, 30];
/** Pasado este tiempo desde el primer intento ya no se reintenta (es la misma noche). */
const VENTANA_REINTENTO_MS = 3 * 60 * 60 * 1000;
/** Un intento «en curso» más viejo que esto se da por caído (el proceso se reinició a mitad). */
const EN_CURSO_CAIDO_MS = 20 * 60 * 1000;

/**
 * Reintento del reporte nocturno que toca ahora, o null. Solo si el último intento de la noche
 * falló (tarea con error o `reintentar` en su resumen), quedan reintentos y ya pasó la espera.
 * Mira el día de hoy y el de ayer (un corte tardío puede reintentarse pasada la medianoche).
 */
export async function reintentoNocturnaDebido(
  ahora: Date,
): Promise<{ fecha: string; reintento: number } | null> {
  const hoy = caracasParts(ahora).fecha;
  const ayer = caracasParts(new Date(ahora.getTime() - 86_400_000)).fecha;
  for (const fecha of [hoy, ayer]) {
    const runs = await prisma.mktExpedienteJobRun.findMany({
      where: { job: 'nocturna', fecha: { startsWith: fecha } },
      orderBy: { id: 'asc' },
    });
    const base = runs.find((r) => r.fecha === fecha);
    if (!base) continue;
    const reintentos = runs.filter((r) =>
      r.fecha.startsWith(`${fecha}~reintento~`),
    );
    const ultimo = reintentos.at(-1) ?? base;
    const caido =
      ultimo.estado === 'en_curso' &&
      ahora.getTime() - ultimo.inicio.getTime() > EN_CURSO_CAIDO_MS;
    if (ultimo.estado === 'en_curso' && !caido) return null;
    const resumen = (ultimo.resumen ?? {}) as { reintentar?: unknown };
    if (!caido && ultimo.estado !== 'error' && resumen.reintentar !== true)
      return null;
    const n = reintentos.length + 1;
    if (n > MAX_REINTENTOS_NOCTURNA) return null;
    if (ahora.getTime() - base.inicio.getTime() > VENTANA_REINTENTO_MS)
      return null;
    const espera = ESPERAS_REINTENTO_NOCTURNA_MIN[n - 1] * 60_000;
    if (ahora.getTime() - (ultimo.fin ?? ultimo.inicio).getTime() < espera)
      return null;
    return { fecha, reintento: n };
  }
  return null;
}

/** Corre el reintento que toque (único por fecha y número: nunca dos veces el mismo). */
export async function reintentarNocturna(
  ahora: Date = new Date(),
): Promise<JobResultado | null> {
  const debido = await reintentoNocturnaDebido(ahora);
  if (!debido) return null;
  logger.warn(
    `[expedientes] reintento ${debido.reintento} de ${MAX_REINTENTOS_NOCTURNA} del reporte nocturno del ${debido.fecha}`,
  );
  return ejecutarJob('nocturna', {
    origen: 'auto',
    ahora,
    actor: 'scheduler',
    reintento: debido.reintento,
    fechaReporte: debido.fecha,
  });
}

// ─── Scheduler (patrón setInterval; solo con EXPEDIENTES_JOBS_ENABLED) ──────

const TICK_MS = 60 * 1000;
const yaCorrio: Partial<Record<JobName, string>> = {};
let corriendo = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Un tick: si la hora de Caracas ya pasó la hora configurada y la tarea del día
 * no corrió, la ejecuta. El único (job, fecha) evita repetir tras reinicios.
 */
export async function tickScheduler(
  ahora: Date = new Date(),
): Promise<JobName[]> {
  if (!expedientesJobsEnabled() || corriendo) return [];
  corriendo = true;
  const corridos: JobName[] = [];
  try {
    const config = await svc.getConfig();
    const { fecha, hora } = caracasParts(ahora);
    const plan: [JobName, string][] = [
      ['diaria', config.horaDiaria],
      ['nocturna', config.horaResumen],
    ];
    for (const [job, horaJob] of plan) {
      if (hora < horaJob || yaCorrio[job] === fecha) continue;
      const r = await ejecutarJob(job, {
        origen: 'auto',
        ahora,
        actor: 'scheduler',
      });
      yaCorrio[job] = fecha;
      if (!r.omitido) corridos.push(job);
    }
    const reintento = await reintentarNocturna(ahora);
    if (reintento && !reintento.omitido) corridos.push('nocturna');
  } catch (err) {
    logger.error(
      `[expedientes] scheduler: ${err instanceof Error ? err.message : 'error'}`,
    );
  } finally {
    corriendo = false;
  }
  return corridos;
}

// ─── Validación automática con IA (fuera del registro diario) ───────────────

/** Reintentos de errores técnicos y documentos recién recibidos: cada 5 minutos. */
const IA_TICK_MS = 5 * 60 * 1000;
/** Pasada completa al arrancar, cuando el proceso ya está estable. */
const IA_ARRANQUE_MS = 30 * 1000;
let iaCorriendo = false;
let iaTimer: NodeJS.Timeout | null = null;
let iaArranque: NodeJS.Timeout | null = null;

/**
 * Una pasada de la IA (solo con EXPEDIENTES_JOBS_ENABLED). 'recibidos' = lo pendiente y los
 * reintentos vencidos; 'completo' = además, lo decidido por la IA si cambió el archivo o la póliza.
 * Nunca se solapa consigo misma; el tope de 2 análisis simultáneos lo pone la cola del servicio.
 */
export async function tickIa(
  modo: 'recibidos' | 'completo' = 'recibidos',
): Promise<unknown> {
  if (!expedientesJobsEnabled() || iaCorriendo) return null;
  iaCorriendo = true;
  try {
    const r = await svc.revisarConIa({ modo });
    if (r.analizados)
      logger.info(
        `[expedientes] IA ${modo}: ${r.analizados} analizados, ${r.validados} validados, ${r.observados} observados, ${r.erroresTecnicos} errores técnicos`,
      );
    return r;
  } catch (err) {
    logger.error(
      `[expedientes] IA ${modo}: ${err instanceof Error ? err.message : 'error'}`,
    );
    return null;
  } finally {
    iaCorriendo = false;
  }
}

export function iniciarSchedulerExpedientes(): void {
  if (timer || !expedientesJobsEnabled()) return;
  timer = setInterval(() => {
    void tickScheduler();
  }, TICK_MS);
  timer.unref();
  iaTimer = setInterval(() => {
    void tickIa('recibidos');
  }, IA_TICK_MS);
  iaTimer.unref();
  iaArranque = setTimeout(() => {
    void tickIa('completo');
  }, IA_ARRANQUE_MS);
  iaArranque.unref();
  logger.info('[expedientes] scheduler de tareas activo (hora Caracas)');
}

/** Solo pruebas. */
export function _resetScheduler(): void {
  for (const k of Object.keys(yaCorrio)) delete yaCorrio[k as JobName];
  corriendo = false;
  iaCorriendo = false;
  if (timer) clearInterval(timer);
  if (iaTimer) clearInterval(iaTimer);
  if (iaArranque) clearTimeout(iaArranque);
  timer = null;
  iaTimer = null;
  iaArranque = null;
}
