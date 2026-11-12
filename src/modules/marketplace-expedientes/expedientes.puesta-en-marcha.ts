/**
 * Puesta en marcha (una sola vez, 11-nov-2026): mientras producción no tenía
 * EXPEDIENTES_ENTORNO=produccion, la lista blanca bloqueó los correos al cliente y cada etapa quedó
 * marcada como enviada. Esta acción manda UNA solicitud inicial a cada expediente rezagado:
 *   - incompleto, en el alcance del monitor y no excluido;
 *   - con algo que pedir al cliente: faltan documentos, hay que corregir alguno, o ambos
 *     (lo único observado «datos_modificados» o todo «en revisión» se reporta aparte y no se envía);
 *   - con al menos un correo válido (tomador y asegurado/titular, v1.4);
 *   - sin ninguna notificación con resultado `enviado` todavía (idempotente: dos corridas no duplican).
 * Aunque tenga la cadencia agotada o la etapa marcada por el bloqueo. Después la cadencia sigue normal:
 * la etapa queda en la que corresponde por días (no se reenvían etapas viejas en cascada).
 *
 * Vista previa (por defecto) = sin enviar ni escribir nada. Ejecutar = por tandas con pausa.
 * Sin datos personales en el resultado (solo cifras).
 */
import { randomUUID } from 'crypto';
import type { MktExpediente, MktExpedienteRequisito } from '@prisma/client';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import {
  areasEnAlcance,
  diasCaracasEntre,
  whitelistPermite,
} from './expedientes.domain';
import { expedientesEsProduccion, mailWhitelist } from './expedientes.env';
import { correoSolicitudInicial, entregarCorreo } from './expedientes.mail';
import {
  documentosCorreo,
  estaExcluido,
  expedientesService as svc,
  primerNombre,
} from './expedientes.service';
import { requisitosPorExpediente } from './expedientes.tareas';
import {
  ClasificacionExpediente,
  clasificarExpediente,
  hayQuePedirAlCliente,
  MotivoSolicitud,
} from './expedientes.clasificacion';
import { unirCorreos } from './expedientes.correos';

type Exp = MktExpediente;
type Req = MktExpedienteRequisito;

export const LOTE_PUESTA_EN_MARCHA = 'puesta_en_marcha';

export interface OpcionesPuestaEnMarcha {
  /** false (por defecto) = vista previa: no envía ni escribe nada. */
  ejecutar?: boolean;
  /** Correos por tanda (1 a 100; por defecto 20). */
  tamanoLote?: number;
  /** Pausa entre tandas en ms (0 a 60000; por defecto 3000). */
  pausaMs?: number;
  /** Máximo de correos en esta corrida (para ir por partes). Sin límite por defecto. */
  limite?: number;
  ahora?: Date;
  /** Solo pruebas. */
  dormir?: (ms: number) => Promise<void>;
}

interface Grupo {
  key: string;
  exps: Exp[];
  correos: string[];
}

function contar(map: Record<string, number>, k: string, n = 1) {
  map[k] = (map[k] ?? 0) + n;
}

function entero(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Índice de la última etapa de la cadencia cuyo día ya llegó (-1 si ninguna). */
export function etapaAlDia(dias: number, cadencia: number[]): number {
  let idx = -1;
  for (let i = 0; i < cadencia.length; i++) if (cadencia[i] <= dias) idx = i;
  return idx;
}

function productoClave(e: Pick<Exp, 'producto' | 'cramo'>): string {
  return e.cramo != null ? `${e.producto} (ramo ${e.cramo})` : e.producto;
}

let enCurso = false;

export async function puestaEnMarcha(opts: OpcionesPuestaEnMarcha = {}) {
  if (enCurso) throw new Error('La puesta en marcha ya se está ejecutando.');
  enCurso = true;
  try {
    return await correr(opts);
  } finally {
    enCurso = false;
  }
}

async function yaNotificados(ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await prisma.mktExpedienteNotificacion.findMany({
    where: {
      expedienteId: { in: ids },
      resultado: 'enviado',
      tipo: { not: 'prueba' },
    },
    select: { expedienteId: true },
  });
  return new Set(
    rows.map((r) => r.expedienteId).filter((x): x is number => x != null),
  );
}

async function correr(opts: OpcionesPuestaEnMarcha) {
  const ejecutar = opts.ejecutar === true;
  const ahora = opts.ahora ?? new Date();
  const tamanoLote = entero(opts.tamanoLote, 20, 1, 100);
  const pausaMs = entero(opts.pausaMs, 3000, 0, 60000);
  const limite =
    opts.limite == null ? Infinity : entero(opts.limite, 0, 0, 1_000_000);
  const dormir =
    opts.dormir ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const config = await svc.getConfig();
  // Primero el relleno de correos de todo el monitor (cotización del wizard y mesa técnica):
  // en vista previa solo cuenta; al ejecutar, guarda (idempotente).
  const relleno = await svc.rellenarCorreos({ ejecutar });
  const exps = await prisma.mktExpediente.findMany({
    where: {
      estadoDocumental: 'incompleto',
      area: { in: areasEnAlcance(config.alcance) },
    },
    orderBy: { emitidaEn: 'desc' },
  });
  const exclusiones = await svc.exclusionesActivas();
  const reqs: Map<number, Req[]> = await requisitosPorExpediente(
    exps.map((e) => e.id),
  );
  const notificados = await yaNotificados(exps.map((e) => e.id));

  const noSeEnvian = {
    excluidos: 0,
    yaNotificados: 0,
    soloDatosModificados: 0,
    soloEnRevision: 0,
    sinCorreo: 0,
  };
  const porMotivo: Record<MotivoSolicitud, number> = {
    faltan_documentos: 0,
    corregir: 0,
    ambos: 0,
  };
  const porProducto: Record<string, number> = {};
  const porArea: Record<string, number> = {};
  const clasif = new Map<number, ClasificacionExpediente>();

  const grupos = new Map<string, Grupo>();
  for (const e of exps) {
    if (estaExcluido(e, exclusiones)) {
      noSeEnvian.excluidos++;
      continue;
    }
    if (notificados.has(e.id)) {
      noSeEnvian.yaNotificados++;
      continue;
    }
    const c = clasificarExpediente(e, reqs.get(e.id) ?? [], config);
    clasif.set(e.id, c);
    if (c === 'solo_datos_modificados') {
      noSeEnvian.soloDatosModificados++;
      continue;
    }
    if (!hayQuePedirAlCliente(c)) {
      noSeEnvian.soloEnRevision++;
      continue;
    }
    // Vista previa: busca en la cotización sin escribir; al ejecutar, deja el resultado en el snapshot.
    const correos = await svc.correosDestino(e, { persistir: ejecutar });
    if (!correos.length) {
      noSeEnvian.sinCorreo++;
      continue;
    }
    porMotivo[c as MotivoSolicitud]++;
    contar(porProducto, productoClave(e));
    contar(porArea, e.area);
    const key = e.aseguradoKey ?? `exp:${e.id}`;
    const g = grupos.get(key) ?? { key, exps: [], correos: [] };
    g.exps.push(e);
    g.correos = unirCorreos([...g.correos, ...correos]);
    grupos.set(key, g);
  }

  const prod = expedientesEsProduccion();
  const wl = mailWhitelist();
  const lista = Array.from(grupos.values());
  const bloqueadosPorListaBlanca = lista.filter(
    (g) => !g.correos.some((c) => whitelistPermite(c, prod, wl)),
  ).length;

  const resumen = {
    modo: ejecutar ? 'ejecucion' : 'vista_previa',
    entornoProduccion: prod,
    incompletosEnAlcance: exps.length,
    /** Correos recuperados de la cotización del wizard / mesa técnica (todo el monitor). */
    relleno,
    seEnvian: {
      expedientes: lista.reduce((n, g) => n + g.exps.length, 0),
      /** Un correo por asegurado (agrupa sus pólizas), a tomador y asegurado a la vez. */
      correos: lista.length,
      destinatarios: lista.reduce((n, g) => n + g.correos.length, 0),
      porMotivo,
      porProducto,
      porArea,
    },
    noSeEnvian,
    /** Fuera de producción declarada solo salen los de EXPEDIENTES_MAIL_WHITELIST. */
    listaBlanca: { aplica: !prod, correosBloqueados: bloqueadosPorListaBlanca },
  };
  if (!ejecutar) return resumen;

  const lote = `${LOTE_PUESTA_EN_MARCHA}:${randomUUID()}`;
  const resultado = {
    lote,
    enviados: 0,
    fallidos: 0,
    bloqueados: 0,
    omitidosYaEnviados: 0,
    pendientesPorLimite: 0,
  };
  let enTanda = 0;
  let salieron = 0;
  for (const g of lista) {
    if (salieron >= limite) {
      resultado.pendientesPorLimite++;
      continue;
    }
    // Idempotencia: lo que ya salió (otra corrida, la diaria o un aviso) no se repite.
    const ya = await yaNotificados(g.exps.map((e) => e.id));
    const exps = g.exps.filter((e) => !ya.has(e.id));
    resultado.omitidosYaEnviados += g.exps.length - exps.length;
    if (!exps.length) continue;

    try {
      const link = await svc.crearEnlace(
        g.key.startsWith('exp:') ? null : g.key,
        exps.map((e) => e.id),
      );
      const nombre = primerNombre(exps[0]);
      const content = correoSolicitudInicial({
        nombre,
        polizas: exps.map((e) => e.cnpoliza),
        documentos: documentosCorreo(exps, reqs, config),
        enlace: link.url,
      });
      const r = await entregarCorreo(g.correos, nombre, content);
      for (const e of exps) {
        const etapa = Math.max(
          e.etapaEnviada,
          etapaAlDia(diasCaracasEntre(e.emitidaEn, ahora), config.cadenciaDias),
          0,
        );
        await svc.registrarNotificacion({
          expedienteId: e.id,
          aseguradoKey: e.aseguradoKey,
          tipo: 'solicitud_inicial',
          etapa,
          resultado: r.resultado,
          destinatarioMasked: r.destinatarioMasked,
          error: r.error ?? null,
          lote,
        });
        if (r.resultado === 'enviado') {
          // La cadencia sigue desde la etapa que corresponde por días (sin cascada de etapas viejas).
          await prisma.mktExpediente.update({
            where: { id: e.id },
            data: {
              etapaEnviada: etapa,
              intentos: { increment: 1 },
              ultimoEnvio: ahora,
            },
          });
        }
        await svc.evento(e.id, 'puesta_en_marcha', 'sistema', {
          resultado: r.resultado,
          etapa,
          motivo: clasif.get(e.id) ?? null,
        });
      }
      if (r.resultado === 'enviado') resultado.enviados++;
      else if (r.resultado === 'bloqueado_whitelist') resultado.bloqueados++;
      else resultado.fallidos++;
    } catch (err) {
      resultado.fallidos++;
      logger.warn(
        `[expedientes] puesta en marcha: un grupo falló (${err instanceof Error ? err.name : 'error'})`,
      );
    }
    salieron++;
    enTanda++;
    if (enTanda >= tamanoLote) {
      enTanda = 0;
      if (pausaMs > 0) await dormir(pausaMs);
    }
  }
  logger.info(
    `[expedientes] puesta en marcha ${lote}: enviados=${resultado.enviados} fallidos=${resultado.fallidos} bloqueados=${resultado.bloqueados}`,
  );
  return { ...resumen, resultado };
}
