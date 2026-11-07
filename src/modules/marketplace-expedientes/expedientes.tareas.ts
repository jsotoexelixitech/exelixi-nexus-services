/**
 * Lógica de las tareas diaria (recordatorios por cadencia) y nocturna (resumen).
 * Sin datos personales en logs; cada intento queda en mkt_expediente_notificacion.
 */
import { randomUUID } from 'crypto';
import type { MktExpediente, MktExpedienteRequisito } from '@prisma/client';
import prisma from '../../config/prisma';
import {
  areasEnAlcance,
  cadenciaVencida,
  caracasInicioDia,
  caracasParts,
  diasCaracasEntre,
  emailValido,
  esPendiente,
  etapaDebida,
  ExpedientesConfig,
  requisitoLabel,
  requisitosAplicables,
  whitelistPermite,
} from './expedientes.domain';
import {
  expedientesEsProduccion,
  mailWhitelist,
  publicBaseUrl,
} from './expedientes.env';
import {
  correoRecordatorio,
  correoResumenNocturno,
  correoSolicitudInicial,
  entregarCorreo,
} from './expedientes.mail';
import {
  estaExcluido,
  expedientesService as svc,
  polizaOResumen,
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
    const pendientes = paraEnlace.map((e) => {
      const docs = pendientesDe(e, reqs.get(e.id) ?? [], config).map(
        requisitoLabel,
      );
      const lista = docs.length ? docs.join(', ') : 'documentos en validación';
      return paraEnlace.length > 1
        ? `Póliza N° ${e.cnpoliza}: ${lista}`
        : lista;
    });
    const link = await svc.crearEnlace(
      key.startsWith('exp:') ? null : key,
      paraEnlace.map((e) => e.id),
    );
    const nombre = primerNombre(activos[0].exp);
    const content = inicial
      ? correoSolicitudInicial({
          nombre,
          polizaOResumen: polizaOResumen(paraEnlace),
          pendientes,
          enlace: link.url,
        })
      : correoRecordatorio({ nombre, pendientes, enlace: link.url });
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

const RE_ILEGIBLE = /leer|legib|nitid|borros/i;

function areasLabel(config: ExpedientesConfig): string {
  const a = config.alcance;
  const partes = [
    a.canales ? 'Canales' : null,
    a.gestores ? 'Gestores' : null,
    a.productores ? 'Productores' : null,
  ].filter(Boolean) as string[];
  if (!partes.length) return 'Marketplace';
  return partes.length === 1
    ? partes[0]
    : `${partes.slice(0, -1).join(', ')} y ${partes.at(-1)}`;
}

/** Correo 6. Se envía aunque haya cero; sin datos personales en el cuerpo. */
export async function tareaNocturna(ahora: Date) {
  const config = await svc.getConfig();
  const { fecha, hora } = caracasParts(ahora);
  const inicio = caracasInicioDia(fecha);
  const fin = new Date(inicio.getTime() + 86_400_000);
  const todos = await prisma.mktExpediente.findMany({
    where: { area: { in: areasEnAlcance(config.alcance) } },
  });
  const hoy = todos.filter((e) => e.emitidaEn >= inicio && e.emitidaEn < fin);
  const reqs = await requisitosPorExpediente(hoy.map((e) => e.id));
  const exclusiones = await svc.exclusionesActivas();
  const incompletasHoy = hoy.filter((e) => e.estadoDocumental === 'incompleto');
  const obs = (e: Exp) =>
    (reqs.get(e.id) ?? []).filter((r) => r.estado === 'observado');

  const notifs = await prisma.mktExpedienteNotificacion.findMany({
    where: {
      createdAt: { gte: inicio, lt: fin },
      tipo: { notIn: ['resumen_nocturno', 'prueba'] },
    },
  });
  const errores = await prisma.mktExpedienteEvento.count({
    where: { tipo: 'error_tecnico', createdAt: { gte: inicio, lt: fin } },
  });
  const [totalEmisiones, totalExpedientes] = await Promise.all([
    prisma.emision.count(),
    prisma.mktExpediente.count(),
  ]);

  const [dd, mm, yyyy] = [
    fecha.slice(8, 10),
    fecha.slice(5, 7),
    fecha.slice(0, 4),
  ];
  const fechaLocal = `${dd}/${mm}/${yyyy}`;
  const base = publicBaseUrl();
  const datos = {
    fechaLocal,
    fechaHoraCaracas: `${fechaLocal} ${hora} (hora de Caracas)`,
    areasLabel: areasLabel(config),
    emitidas: hoy.length,
    completas: hoy.filter((e) => e.estadoDocumental === 'completo').length,
    incompletas: incompletasHoy.length,
    pendientesPago: hoy.filter((e) => e.estadoPago === 'pendiente').length,
    sinDocumentos: incompletasHoy.filter((e) =>
      requisitosAplicables(e.producto, config).every(
        (t) =>
          ((reqs.get(e.id) ?? []).find((r) => r.tipo === t)?.estado ??
            'faltante') === 'faltante',
      ),
    ).length,
    ilegibles: hoy.filter((e) =>
      obs(e).some((r) => RE_ILEGIBLE.test(r.motivo ?? '')),
    ).length,
    inconsistentes: hoy.filter((e) =>
      obs(e).some((r) => !RE_ILEGIBLE.test(r.motivo ?? '')),
    ).length,
    porValidar: hoy.filter((e) =>
      (reqs.get(e.id) ?? []).some((r) => r.estado === 'recibido'),
    ).length,
    intentos: notifs.filter((n) =>
      ['enviado', 'error', 'bloqueado_whitelist'].includes(n.resultado),
    ).length,
    entregados: notifs.filter((n) => n.resultado === 'enviado').length,
    rebotes: notifs.filter(
      (n) => n.resultado === 'error' || n.resultado === 'rebotado',
    ).length,
    excluidos: todos.filter(
      (e) => e.estadoDocumental !== 'completo' && estaExcluido(e, exclusiones),
    ).length,
    totalCartera: todos.length,
    totalCompletos: todos.filter((e) => e.estadoDocumental === 'completo')
      .length,
    totalIncompletos: todos.filter((e) => e.estadoDocumental === 'incompleto')
      .length,
    sinInformacion: todos.filter(
      (e) => e.estadoDocumental === 'sin_informacion',
    ).length,
    sinVinculo: Math.max(0, totalEmisiones - totalExpedientes),
    errores,
    enlaceReporte: base ? `${base}/monitor-expedientes` : null,
  };

  let resultado: string;
  let destinatarioMasked: string | null = null;
  let error: string | undefined;
  if (!config.destinatariosResumen.length) {
    resultado = 'sin_correo';
  } else {
    const r = await entregarCorreo(
      config.destinatariosResumen,
      undefined,
      correoResumenNocturno(datos),
    );
    resultado = r.resultado;
    destinatarioMasked = r.destinatarioMasked;
    error = r.error;
  }
  await svc.registrarNotificacion({
    expedienteId: null,
    tipo: 'resumen_nocturno',
    resultado,
    destinatarioMasked,
    error: error ?? null,
  });
  const { enlaceReporte: _enlace, ...metricas } = datos;
  return { ...metricas, resultado };
}
