/**
 * Tareas del monitor (hora Caracas). Cada ejecución automática se registra en
 * `mkt_expediente_job_run` con único (job, fecha): si el proceso reinicia o hay
 * varias instancias, la tarea del día corre una sola vez.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { caracasParts } from './expedientes.domain';
import { expedientesJobsEnabled } from './expedientes.env';
import { tareaDiaria, tareaNocturna } from './expedientes.tareas';
import { expedientesService as svc } from './expedientes.service';
import type { JobName } from './expedientes.schema';

export interface EjecutarJobOpts {
  origen: 'auto' | 'manual';
  /** Solo manual: corre aunque ya exista la ejecución del día (clave aparte). */
  forzar?: boolean;
  actor?: string;
  ahora?: Date;
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
): Promise<Record<string, unknown>> {
  switch (job) {
    case 'conciliacion':
      return { conciliacion: await svc.conciliar() };
    case 'diaria':
      return tareaDiaria(ahora);
    case 'nocturna':
      return tareaNocturna(ahora);
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
  const clave =
    opts.origen === 'manual' && opts.forzar
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
    const resumen = await correr(job, ahora);
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
    return {
      job,
      fecha: clave,
      omitido: false,
      estado: 'error',
      resumen: { error: msg },
    };
  }
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
  } catch (err) {
    logger.error(
      `[expedientes] scheduler: ${err instanceof Error ? err.message : 'error'}`,
    );
  } finally {
    corriendo = false;
  }
  return corridos;
}

export function iniciarSchedulerExpedientes(): void {
  if (timer || !expedientesJobsEnabled()) return;
  timer = setInterval(() => {
    void tickScheduler();
  }, TICK_MS);
  timer.unref();
  logger.info('[expedientes] scheduler de tareas activo (hora Caracas)');
}

/** Solo pruebas. */
export function _resetScheduler(): void {
  for (const k of Object.keys(yaCorrio)) delete yaCorrio[k as JobName];
  corriendo = false;
  if (timer) clearInterval(timer);
  timer = null;
}
