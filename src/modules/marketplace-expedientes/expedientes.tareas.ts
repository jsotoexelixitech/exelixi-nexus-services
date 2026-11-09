/**
 * Lógica de las tareas diaria (recordatorios por cadencia) y nocturna (control documental
 * diario). Sin datos personales en logs; cada intento queda en mkt_expediente_notificacion.
 */
import { randomUUID } from 'crypto';
import type { MktExpediente, MktExpedienteRequisito } from '@prisma/client';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import {
  areasEnAlcance,
  cadenciaVencida,
  caracasParts,
  diasCaracasEntre,
  emailValido,
  esPendiente,
  etapaDebida,
  ExpedientesConfig,
  requisitosAplicables,
  whitelistPermite,
} from './expedientes.domain';
import {
  destinatariosReporteProductores,
  expedientesEsProduccion,
  mailWhitelist,
  reporteProductoresHabilitado,
} from './expedientes.env';
import {
  correoRecordatorio,
  correoReporteSimple,
  correoSolicitudInicial,
  entregarCorreo,
  EntregaResultado,
  ResultadoEnvio,
  sinCorreosEnTexto,
} from './expedientes.mail';
import { ExcelReporte, excelReporteSimple } from './expedientes.excel';
import {
  armarReporteSimple,
  GRUPOS_REPORTE,
  GrupoReporte,
} from './expedientes.reporte';
import {
  documentosCorreo,
  estaExcluido,
  expedientesService as svc,
  primerNombre,
} from './expedientes.service';

type Exp = MktExpediente;
type Req = MktExpedienteRequisito;

async function requisitosPorExpediente(
  ids: number[],
): Promise<Map<number, Req[]>> {
  const map = new Map<number, Req[]>();
  if (!ids.length) return map;
  const rows = await prisma.mktExpedienteRequisito.findMany({
    where: { expedienteId: { in: ids } },
  });
  for (const r of rows) {
    const l = map.get(r.expedienteId) ?? [];
    l.push(r);
    map.set(r.expedienteId, l);
  }
  return map;
}

function pendientesDe(
  e: Exp,
  reqs: Req[],
  config: ExpedientesConfig,
): string[] {
  return requisitosAplicables(e.producto, config).filter((t) =>
    esPendiente(reqs.find((r) => r.tipo === t)?.estado ?? 'faltante'),
  );
}

// ─── Diaria ─────────────────────────────────────────────────────────────────

export async function recalcularIncompletos(config: ExpedientesConfig) {
  const exps = await prisma.mktExpediente.findMany({
    where: {
      estadoDocumental: 'incompleto',
      area: { in: areasEnAlcance(config.alcance) },
    },
    select: { id: true },
  });
  let completados = 0;
  for (const e of exps) {
    const r = await svc.recalcularEstado(e.id, config);
    if (r.completadoAhora) completados++;
  }
  const cruzadosMesaTecnica = await svc.cruzarSinInformacion(config);
  return { revisados: exps.length, completados, cruzadosMesaTecnica };
}

/**
 * Recordatorios por cadencia (0/3/7/14 por defecto): una vez por etapa,
 * agrupados por asegurado, respetando exclusiones y la lista blanca.
 */
export async function enviarRecordatorios(ahora: Date = new Date()) {
  const config = await svc.getConfig();
  const exps = await prisma.mktExpediente.findMany({
    where: {
      estadoDocumental: 'incompleto',
      area: { in: areasEnAlcance(config.alcance) },
      cadenciaAgotada: false,
    },
    orderBy: { emitidaEn: 'desc' },
  });
  const exclusiones = await svc.exclusionesActivas();
  const reqs = await requisitosPorExpediente(exps.map((e) => e.id));
  const resumen = {
    grupos: 0,
    enviados: 0,
    fallidos: 0,
    bloqueados: 0,
    sinCorreo: 0,
    excluidos: 0,
    agotados: 0,
  };

  const porKey = new Map<string, Exp[]>();
  const debidos = new Map<string, { exp: Exp; etapa: number }[]>();
  for (const e of exps) {
    const key = e.aseguradoKey ?? `exp:${e.id}`;
    porKey.set(key, [...(porKey.get(key) ?? []), e]);
    const dias = diasCaracasEntre(e.emitidaEn, ahora);
    const etapa = etapaDebida(dias, config.cadenciaDias, e.etapaEnviada);
    if (etapa == null) {
      if (cadenciaVencida(dias, config.cadenciaDias)) {
        await prisma.mktExpediente.update({
          where: { id: e.id },
          data: { cadenciaAgotada: true },
        });
        await svc.evento(e.id, 'cadencia_agotada', 'sistema', {
          etapaEnviada: e.etapaEnviada,
          dias,
        });
        resumen.agotados++;
      }
      continue;
    }
    debidos.set(key, [...(debidos.get(key) ?? []), { exp: e, etapa }]);
  }

  const prod = expedientesEsProduccion();
  const wl = mailWhitelist();

  for (const [key, miembros] of debidos) {
    // Reclamar la etapa antes de enviar: dos ejecuciones nunca repiten la misma etapa.
    const reclamados: { exp: Exp; etapa: number }[] = [];
    for (const m of miembros) {
      const { count } = await prisma.mktExpediente.updateMany({
        where: { id: m.exp.id, etapaEnviada: { lt: m.etapa } },
        data: { etapaEnviada: m.etapa },
      });
      if (count) reclamados.push(m);
    }
    if (!reclamados.length) continue;
    resumen.grupos++;
    const lote = randomUUID();
    const inicial = reclamados.some((m) => m.exp.etapaEnviada < 0);
    const tipoCorreo = inicial ? 'solicitud_inicial' : 'recordatorio';

    const activos = reclamados.filter((m) => !estaExcluido(m.exp, exclusiones));
    for (const m of reclamados.filter((x) => !activos.includes(x))) {
      await svc.registrarNotificacion({
        expedienteId: m.exp.id,
        aseguradoKey: m.exp.aseguradoKey,
        tipo: tipoCorreo,
        etapa: m.etapa,
        resultado: 'excluido',
        lote,
      });
      resumen.excluidos++;
    }
    if (!activos.length) continue;

    const email =
      activos.map((m) => m.exp.aseguradoEmail).find((v) => emailValido(v)) ??
      null;
    const registrar = async (
      resultado: string,
      destinatarioMasked?: string | null,
      error?: string,
    ) => {
      const cuenta = ['enviado', 'error', 'bloqueado_whitelist'].includes(
        resultado,
      );
      for (const m of activos) {
        await svc.registrarNotificacion({
          expedienteId: m.exp.id,
          aseguradoKey: m.exp.aseguradoKey,
          tipo: tipoCorreo,
          etapa: m.etapa,
          resultado,
          destinatarioMasked,
          error: error ?? null,
          lote,
        });
        if (cuenta) {
          await prisma.mktExpediente.update({
            where: { id: m.exp.id },
            data: {
              intentos: { increment: 1 },
              ...(resultado !== 'bloqueado_whitelist'
                ? { ultimoEnvio: ahora }
                : {}),
            },
          });
        }
        await svc.evento(m.exp.id, 'recordatorio', 'sistema', {
          etapa: m.etapa,
          tipo: tipoCorreo,
          resultado,
        });
      }
    };

    if (!email) {
      await registrar('sin_correo');
      resumen.sinCorreo += activos.length;
      continue;
    }
    if (!whitelistPermite(email, prod, wl)) {
      await registrar('bloqueado_whitelist', null);
      resumen.bloqueados += activos.length;
      continue;
    }

    // El enlace cubre todas las pólizas incompletas (no excluidas) del asegurado.
    const grupo = (porKey.get(key) ?? []).filter(
      (e) => !estaExcluido(e, exclusiones),
    );
    const conPendientes = grupo.filter(
      (e) => pendientesDe(e, reqs.get(e.id) ?? [], config).length > 0,
    );
    const paraEnlace = conPendientes.length
      ? conPendientes
      : activos.map((m) => m.exp);
    const link = await svc.crearEnlace(
      key.startsWith('exp:') ? null : key,
      paraEnlace.map((e) => e.id),
    );
    const nombre = primerNombre(activos[0].exp);
    const datos = {
      nombre,
      polizas: paraEnlace.map((e) => e.cnpoliza),
      documentos: documentosCorreo(paraEnlace, reqs, config),
      enlace: link.url,
    };
    const content = inicial
      ? correoSolicitudInicial(datos)
      : correoRecordatorio(datos);
    const r = await entregarCorreo([email], nombre, content);
    await registrar(r.resultado, r.destinatarioMasked, r.error);
    if (r.resultado === 'enviado') resumen.enviados += activos.length;
    else if (r.resultado === 'error') resumen.fallidos += activos.length;
    else if (r.resultado === 'bloqueado_whitelist')
      resumen.bloqueados += activos.length;
  }
  return resumen;
}

export async function tareaDiaria(ahora: Date) {
  const config = await svc.getConfig();
  const conciliacion = await svc.conciliar();
  const recalculo = await recalcularIncompletos(config);
  // Revisión periódica de la IA antes de recordar: lo que valide ya no se pide al asegurado.
  const validacionIa = await svc.revisarConIa({ modo: 'completo', ahora });
  const recordatorios = await enviarRecordatorios(ahora);
  return { conciliacion, recalculo, validacionIa, recordatorios };
}

// ─── Nocturna ───────────────────────────────────────────────────────────────

/** Reintentos del reporte nocturno en la misma noche (los programa el scheduler). */
export const MAX_REINTENTOS_NOCTURNA = 3;

export type ResultadoReporte =
  | ResultadoEnvio
  /** Productores sin aprobación (EXPEDIENTES_RESUMEN_PRODUCTORES apagado). */
  | 'deshabilitado'
  /** Productores aprobado pero su alcance está apagado en la configuración. */
  | 'fuera_de_alcance'
  /** Reintento: ese reporte ya salió en un intento anterior. */
  | 'ya_enviado'
  /** Reintento: el intento anterior no fue un fallo de entrega (p. ej. sin destinatarios). */
  | 'sin_reintento';

export interface EnvioReporte {
  grupo: GrupoReporte;
  resultado: ResultadoReporte;
  plantilla?: string;
  areas?: string;
  completados?: number;
  incompletos?: number;
  canales?: { completos: number; incompletos: number };
  productores?: { completos: number; incompletos: number };
  sinDatos?: number;
  /** false: el Excel no se pudo generar y el correo salió sin él. */
  excel?: boolean;
  /** Filas que no cupieron en el Excel por tamaño. */
  omitidas?: { incompletos: number; completados: number };
}

/** Evidencia y alerta de un reporte nocturno que no salió (sin datos personales). */
export async function alertaReporteFallido(d: {
  fecha: string;
  grupo?: GrupoReporte;
  intento: number;
  error?: string;
}): Promise<void> {
  const agotado = d.intento >= MAX_REINTENTOS_NOCTURNA;
  const error = sinCorreosEnTexto(String(d.error ?? 'error')).slice(0, 300);
  try {
    await svc.evento(null, 'reporte_nocturno_fallido', 'sistema', {
      fecha: d.fecha,
      grupo: d.grupo ?? null,
      intento: d.intento,
      reintentoPendiente: !agotado,
      error,
    });
  } catch (err) {
    logger.error(
      `[expedientes] no se pudo registrar reporte_nocturno_fallido: ${err instanceof Error ? err.message : 'error'}`,
    );
  }
  logger.error(
    `[expedientes] reporte nocturno ${d.grupo ?? ''} del ${d.fecha} no se entregó ` +
      `(intento ${d.intento + 1} de ${MAX_REINTENTOS_NOCTURNA + 1}); ` +
      (agotado ? 'sin más reintentos' : 'se reintentará esta noche'),
  );
}

async function reporteDeGrupo(
  grupo: GrupoReporte,
  ctx: {
    config: ExpedientesConfig;
    fecha: string;
    ahora: Date;
    intento: number;
    exclusiones: Awaited<ReturnType<typeof svc.exclusionesActivas>>;
  },
): Promise<EnvioReporte> {
  const { config, fecha, intento } = ctx;
  // Intermediarios: plantilla y tarea listas, pero sin aprobación no se genera.
  if (grupo === 'productores') {
    if (!reporteProductoresHabilitado())
      return { grupo, resultado: 'deshabilitado' };
    if (!config.alcance.productores)
      return { grupo, resultado: 'fuera_de_alcance' };
  }
  const lote = `nocturna:${fecha}:${grupo}`;
  if (intento > 0) {
    const previas = await prisma.mktExpedienteNotificacion.findMany({
      where: { tipo: 'resumen_nocturno', lote },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    // Nunca se duplica: si un intento anterior salió, el reintento no lo repite.
    if (previas.some((n) => n.resultado === 'enviado'))
      return { grupo, resultado: 'ya_enviado' };
    if (previas[0] && previas[0].resultado !== 'error')
      return { grupo, resultado: 'sin_reintento' };
  }

  const reporte = await armarReporteSimple(grupo, {
    config,
    fecha,
    ahora: ctx.ahora,
    exclusiones: ctx.exclusiones,
  });
  let excel: ExcelReporte | null = null;
  const destinatarios =
    grupo === 'productores'
      ? destinatariosReporteProductores()
      : config.destinatariosResumen;
  let r: EntregaResultado = {
    resultado: 'sin_correo',
    destinatarioMasked: null,
  };
  if (destinatarios.length) {
    try {
      excel = await excelReporteSimple(reporte);
    } catch (err) {
      // Sin el Excel el correo sale igual con las cifras (y no menciona el adjunto).
      logger.error(
        `[expedientes] no se pudo generar el Excel del reporte ${grupo}: ${err instanceof Error ? err.name : 'error'}`,
      );
    }
    // Varios destinatarios del reporte: en copia oculta, nadie ve a los demás.
    r = await entregarCorreo(
      destinatarios,
      undefined,
      correoReporteSimple(reporte, excel),
      { ocultarDestinatarios: true },
    );
  }
  await svc.registrarNotificacion({
    expedienteId: null,
    tipo: 'resumen_nocturno',
    // etapa = intento (0 = primer envío de la noche; 1 a 3 = reintentos).
    etapa: intento,
    resultado: r.resultado,
    destinatarioMasked: r.destinatarioMasked,
    error: r.error ?? null,
    lote,
  });
  if (r.resultado === 'error')
    await alertaReporteFallido({ fecha, grupo, intento, error: r.error });
  return {
    grupo,
    resultado: r.resultado,
    ...(r.plantilla ? { plantilla: r.plantilla } : {}),
    areas: reporte.areas,
    ...reporte.cifras,
    ...(destinatarios.length
      ? {
          excel: !!excel,
          ...(excel ? { omitidas: excel.omitidas } : {}),
        }
      : {}),
  };
}

/**
 * Correo 6, «Control documental diario» (versión simple desde el 9-nov-2026): completados e
 * incompletos de toda la cartera del alcance, de canales y de productores, con el detalle en un
 * Excel adjunto. Se envía aunque haya cero incompletos. Un reporte para Canales (cubre todo el
 * alcance) y otro para Productores (apagado hasta su aprobación). Si la entrega falla, `reintentar` = true y el
 * scheduler reintenta (expedientes.jobs). La evidencia queda en el registro de la tarea y en
 * mkt_expediente_notificacion (lote `nocturna:<fecha>:<grupo>`, etapa = intento).
 */
export async function tareaNocturna(
  ahora: Date,
  opts: { fecha?: string; intento?: number } = {},
) {
  const config = await svc.getConfig();
  const fecha = opts.fecha ?? caracasParts(ahora).fecha;
  const intento = opts.intento ?? 0;
  const exclusiones = await svc.exclusionesActivas();
  const reportes: EnvioReporte[] = [];
  for (const grupo of GRUPOS_REPORTE) {
    reportes.push(
      await reporteDeGrupo(grupo, {
        config,
        fecha,
        ahora,
        intento,
        exclusiones,
      }),
    );
  }
  const canales = reportes.find((x) => x.grupo === 'canales');
  return {
    fecha,
    intento,
    /** Resultado del reporte de Canales. */
    resultado: canales?.resultado ?? 'sin_correo',
    reintentar: reportes.some((x) => x.resultado === 'error'),
    reportes,
  };
}
