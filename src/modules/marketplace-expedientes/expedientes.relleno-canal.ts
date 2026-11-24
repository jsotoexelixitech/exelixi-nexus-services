/**
 * Canal siempre identificado (fix 12-nov-2026). Regla de La Mundial: toda póliza muestra su canal
 * («NOMBRE CANAL (canal N-gestor)») o su productor («Nombre (productor N)»); nunca «Canal sin
 * identificar» ni un login/correo.
 *
 * Fuentes, en orden (la primera que resuelve gana):
 *   1. poliza_sis2000: adpoliza/adrecibos de la póliza en Sis2000 (nest-api, solo lectura). Es la
 *      fuente de verdad: magestor trae el ccanalalt vacío en los gestores creados por
 *      spCreateGestorWeb.
 *   2. catalogo: magestor.ccanalalt del gestor (catálogo /v1/canal/actores, también por número).
 *   3. cotizacion: metadata del SSO guardada por el wizard (v7), para las «sin datos».
 * Lo resuelto se GUARDA en el expediente (ccanalalt / cproductor y el nombre en
 * snapshot.canalNombre / snapshot.productorNombre, con snapshot.emisorResuelto = { fuente, en })
 * para no recalcular. Idempotente: solo llena lo vacío y no vuelve a consultar lo ya resuelto.
 *
 * Vista previa (por defecto) = sin escribir. Sin datos personales en el resultado: cifras y, de
 * las que siguen sin canal, solo el número de póliza.
 */
import type { MktExpediente, Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import {
  CatalogoCanales,
  catalogoCanales,
  EmisorPoliza,
  emisoresDePolizas,
} from './expedientes.canales';
import { actorDeCotizacion } from './expedientes.cotizacion';
import {
  areaDesdeVendedor,
  ESTADO_DESCARTADA,
  normalizarCodigoActor,
  textoEmisor,
  valorActor,
} from './expedientes.domain';
import {
  expedientesService as svc,
  nombreActorDeSnapshot,
} from './expedientes.service';

type Exp = MktExpediente;

export const FUENTES_CANAL = ['poliza_sis2000', 'catalogo', 'cotizacion'] as const;
export type FuenteCanal = (typeof FUENTES_CANAL)[number];

export interface ResumenRellenoCanal {
  ejecutado: boolean;
  /** Expedientes revisados (no descartados). */
  revisados: number;
  /** Ya tenían canal o productor identificado. */
  yaIdentificados: number;
  /** Resueltos ahora, por fuente. */
  resueltos: Record<FuenteCanal, number>;
  /** De los resueltos: cuántos quedaron en Canales y cuántos en Productores. */
  resueltosPorGrupo: { canal: number; productor: number };
  /** Siguen sin canal ni productor después de todas las fuentes. */
  sinCanal: number;
  /** Número de póliza de los que siguen sin canal (sin datos personales). */
  polizasSinCanal: string[];
  /** Filas escritas (solo al ejecutar). */
  actualizados: number;
  /** nest-api respondió la consulta de pólizas (false: ruta ausente o caída). */
  sis2000Disponible: boolean;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function nombresSnapshot(e: Pick<Exp, 'snapshot'>) {
  return {
    canal: nombreActorDeSnapshot(e.snapshot, 'canal'),
    productor: nombreActorDeSnapshot(e.snapshot, 'intermediario'),
  };
}

function nombresDe(cat: CatalogoCanales | null) {
  return cat
    ? { canal: cat.nombres, gestor: cat.gestorNombre ?? null, gestorCanal: cat.gestorCanal }
    : null;
}

/** «Emitida por» de un expediente con catálogo y nombres guardados en el snapshot. */
export function emisorDe(e: Exp, cat: CatalogoCanales | null) {
  return textoEmisor(e, nombresDe(cat), nombresSnapshot(e));
}

/**
 * Hay que consultar Sis2000 si no tiene canal propio guardado y: no se identifica, o es de un
 * gestor (su canal real está en la póliza aunque el catálogo o el productor den un texto).
 * Lo ya resuelto por una fuente (snapshot.emisorResuelto) no se vuelve a consultar.
 */
export function necesitaResolverCanal(e: Exp, cat: CatalogoCanales | null): boolean {
  if (rec(e.snapshot).emisorResuelto) return emisorDe(e, cat).grupo === null;
  if (valorActor(e, 'canal')) return false;
  const r = emisorDe(e, cat);
  if (r.grupo === null) return true;
  return !!(e.cgestor || String(e.centidad ?? '').toUpperCase() === 'G');
}

interface Propuesta {
  cambios: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  fuente: FuenteCanal;
}

function deSis2000(e: Exp, p: EmisorPoliza | undefined): Propuesta | null {
  if (!p) return null;
  const cambios: Record<string, unknown> = {};
  const snap: Record<string, unknown> = {};
  if (p.ccanalalt) {
    cambios.ccanalalt = p.ccanalalt;
    if (p.xcanalalt) snap.canalNombre = p.xcanalalt;
  }
  if (p.cproductor && !e.cproductor) cambios.cproductor = p.cproductor;
  const prod = (cambios.cproductor as string | undefined) ?? e.cproductor;
  if (p.xproductor && prod && prod === p.cproductor) snap.productorNombre = p.xproductor;
  if (!cambios.ccanalalt && !cambios.cproductor && !snap.productorNombre) return null;
  return { cambios, snapshot: snap, fuente: 'poliza_sis2000' };
}

function deCatalogo(e: Exp, cat: CatalogoCanales | null): Propuesta | null {
  const r = emisorDe(e, cat);
  if (r.grupo !== 'canal' || !r.canal || valorActor(e, 'canal')) return null;
  const nombre = cat?.nombres.get(normalizarCodigoActor(r.canal) ?? '');
  return {
    cambios: { ccanalalt: r.canal },
    snapshot: nombre ? { canalNombre: nombre } : {},
    fuente: 'catalogo',
  };
}

async function deCotizacion(e: Exp): Promise<Propuesta | null> {
  if (e.producto !== 'rcv' && e.producto !== 'personas') return null;
  const enlace = await svc.cotizacionDe(e);
  if (enlace.estado !== 'unica') return null;
  const actor = actorDeCotizacion(enlace.jsonData);
  const cambios: Record<string, unknown> = {};
  for (const k of ['centidad', 'citem', 'cgestor', 'ccanalalt', 'cusuario', 'xlogin', 'cproductor'] as const) {
    if ((e[k] == null || e[k] === '') && actor[k]) cambios[k] = actor[k];
  }
  return Object.keys(cambios).length
    ? { cambios, snapshot: {}, fuente: 'cotizacion' }
    : null;
}

/** Aplica una propuesta en memoria; el área solo sale de «desconocida» hacia canal o gestor. */
function aplicar(e: Exp, p: Propuesta): Exp {
  const out = {
    ...e,
    ...p.cambios,
    snapshot: { ...rec(e.snapshot), ...p.snapshot },
  } as Exp;
  if (e.area === 'desconocida') {
    const area = areaDesdeVendedor(out);
    // Productor no entra: «desconocida» está en el alcance y «productor» puede no estarlo; el
    // grupo visible (Productores) sale igual de textoEmisor.
    if (area === 'canal' || area === 'gestor') out.area = area;
  }
  return out;
}

/**
 * Resuelve el canal/productor de los expedientes dados y, si `ejecutar`, lo guarda. Devuelve
 * los expedientes ya completados (en memoria) para que el reporte los use en la misma corrida.
 * Nunca lanza por nest-api caído: quedan como estaban.
 */
export async function resolverCanales(
  exps: Exp[],
  opts: { ejecutar?: boolean; catalogo?: CatalogoCanales | null; usarCotizacion?: boolean } = {},
): Promise<{ exps: Exp[]; resumen: ResumenRellenoCanal }> {
  const ejecutar = opts.ejecutar === true;
  const cat = opts.catalogo === undefined ? await catalogoCanales() : opts.catalogo;
  const resumen: ResumenRellenoCanal = {
    ejecutado: ejecutar,
    revisados: exps.length,
    yaIdentificados: 0,
    resueltos: { poliza_sis2000: 0, catalogo: 0, cotizacion: 0 },
    resueltosPorGrupo: { canal: 0, productor: 0 },
    sinCanal: 0,
    polizasSinCanal: [],
    actualizados: 0,
    sis2000Disponible: false,
  };
  const pendientes = exps.filter((e) => necesitaResolverCanal(e, cat));
  const sis = pendientes.length
    ? await emisoresDePolizas(pendientes.map((e) => e.cnpoliza))
    : new Map<string, EmisorPoliza>();
  resumen.sis2000Disponible = sis.size > 0;
  const pend = new Set(pendientes.map((e) => e.id));
  const out: Exp[] = [];
  const ahora = new Date().toISOString();
  for (const e of exps) {
    if (!pend.has(e.id)) {
      if (emisorDe(e, cat).grupo) resumen.yaIdentificados++;
      else {
        resumen.sinCanal++;
        resumen.polizasSinCanal.push(e.cnpoliza);
      }
      out.push(e);
      continue;
    }
    let actual = e;
    let fuente: FuenteCanal | null = null;
    const props: Propuesta[] = [];
    const candidatos: (() => Promise<Propuesta | null> | Propuesta | null)[] = [
      () => deSis2000(actual, sis.get(e.cnpoliza.trim())),
      () => deCatalogo(actual, cat),
      ...(opts.usarCotizacion === false ? [] : [() => deCotizacion(actual)]),
    ];
    for (const c of candidatos) {
      let p: Propuesta | null = null;
      try {
        p = await c();
      } catch {
        p = null;
      }
      if (!p) continue;
      actual = aplicar(actual, p);
      props.push(p);
      if (emisorDe(actual, cat).grupo) {
        fuente = p.fuente;
        break;
      }
    }
    const grupo = emisorDe(actual, cat).grupo;
    if (grupo && fuente) {
      resumen.resueltos[fuente]++;
      resumen.resueltosPorGrupo[grupo]++;
    } else if (grupo) {
      resumen.yaIdentificados++;
    } else {
      resumen.sinCanal++;
      resumen.polizasSinCanal.push(e.cnpoliza);
    }
    if (ejecutar && props.length) {
      const cambios: Record<string, unknown> = {};
      for (const p of props) Object.assign(cambios, p.cambios);
      if (actual.area !== e.area) cambios.area = actual.area;
      const snapshot = {
        ...rec(actual.snapshot),
        ...(fuente ? { emisorResuelto: { fuente, en: ahora } } : {}),
      };
      try {
        await prisma.mktExpediente.update({
          where: { id: e.id },
          data: { ...cambios, snapshot } as Prisma.MktExpedienteUpdateInput,
        });
        await svc.evento(e.id, 'expediente_actualizado', 'conciliacion', {
          campos: Object.keys(cambios),
          fuente: fuente ?? props[props.length - 1].fuente,
        });
        resumen.actualizados++;
        actual = { ...actual, snapshot } as Exp;
      } catch (err) {
        logger.warn(
          `[expedientes] canal: no se pudo guardar el expediente ${e.id}: ${err instanceof Error ? err.name : 'error'}`,
        );
      }
    }
    out.push(actual);
  }
  if (resumen.sinCanal)
    logger.warn(
      `[expedientes] ALERTA: ${resumen.sinCanal} póliza(s) sin canal ni productor identificado`,
    );
  return { exps: out, resumen };
}

/**
 * Relleno idempotente de canal/productor de todos los expedientes no descartados.
 *   Vista previa:  rellenoCanales()            (no escribe)
 *   Ejecutar:      rellenoCanales({ ejecutar: true })
 */
export async function rellenoCanales(
  opts: { ejecutar?: boolean } = {},
): Promise<ResumenRellenoCanal> {
  const exps = await prisma.mktExpediente.findMany({
    where: { estadoDocumental: { not: ESTADO_DESCARTADA } },
    orderBy: { id: 'asc' },
  });
  const { resumen } = await resolverCanales(exps, { ejecutar: opts.ejecutar === true });
  return resumen;
}

/** Contador para Configuración/Monitor: expedientes (no descartados) sin canal ni productor. */
export async function contarPendientesCanal(): Promise<{
  pendientes: number;
  polizas: string[];
}> {
  const cat = await catalogoCanales();
  const exps = await prisma.mktExpediente.findMany({
    where: { estadoDocumental: { not: ESTADO_DESCARTADA } },
  });
  const polizas = exps.filter((e) => emisorDe(e, cat).grupo === null).map((e) => e.cnpoliza);
  return { pendientes: polizas.length, polizas: polizas.slice(0, 200) };
}
