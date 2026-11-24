/**
 * RIF de empresa compartido entre las pólizas de la MISMA empresa tomadora (24-nov-2026, punto 1).
 *
 * Si el tomador es J/G/C y en otra póliza de la misma empresa tomadora (mismo tipo y número de RIF
 * normalizados, misma empresa de Nexus) hay un requisito `cedula` validado cuya lectura es ese RIF
 * jurídico y cuyo archivo sigue siendo el analizado, ese archivo cubre el documento del tomador en
 * las demás pólizas de la empresa que estén faltante / observado / sobrescrito / recibido, o
 * validadas con un archivo que ya no es el analizado.
 *
 * Reglas:
 * - Solo el RIF jurídico del tomador. Una cédula nunca se usa, ni entre empresas distintas.
 * - No toca decisiones manuales (ni como origen cuyo archivo cambió, ni como destino).
 * - Guarda de qué póliza se tomó: texto simple en `motivo` y evento `rif_compartido`.
 * - NO envía correos, NO llama a la IA, NO cambia nada en el disco del OCR.
 * - Origen verificado: sin marca `archivoCambiado` y, si el OCR interno está configurado, su huella
 *   en el disco coincide con `archivoHash`.
 * - Vista previa por defecto en la ruta; la pasada normal solo lo aplica con EXPEDIENTES_RIF_COMPARTIDO=true.
 * - Cargar un RIF propio sigue permitido: lo validado por este camino no bloquea la carga.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import {
  contextoPoliza,
  huellaPoliza,
  lecturaEsRifDelTomador,
  numeroDocumento,
  tomadorJuridico,
} from './expedientes.ia';
import { requisitosAplicables, ESTADO_DESCARTADA } from './expedientes.domain';
import { ocrInternalConfig } from './expedientes.env';
import { huellasEnOcr, MAX_HUELLAS_OCR } from './expedientes.files';
import { marcaArchivoCambiado } from './expedientes.huellas';
import type { ExpedientesService } from './expedientes.service';

export const EVENTO_RIF_COMPARTIDO = 'rif_compartido';
export const VALIDADO_POR_RIF_COMPARTIDO = 'rif_compartido';

export function rifCompartidoActivo(): boolean {
  return (
    String(process.env.EXPEDIENTES_RIF_COMPARTIDO ?? '')
      .trim()
      .toLowerCase() === 'true'
  );
}

export interface ResumenRifCompartido {
  vistaPrevia: boolean;
  /** Empresas tomadoras (RIF) con al menos un origen válido. */
  empresas: number;
  origenes: number;
  /** Origen descartado porque su archivo ya no es el analizado. */
  origenesConArchivoCambiado: number;
  /** Filas que quedan (o quedarían) cubiertas, por estado anterior. */
  porCubrir: number;
  porEstado: Record<string, number>;
  aplicados: number;
  /** Destinos manuales: no se tocan. */
  omitidosManuales: number;
  errores: number;
  ultimoError: string | null;
  /** Hasta 50 ejemplos sin datos personales. */
  muestra: {
    expedienteId: number;
    polizaOrigen: string;
    estadoAnterior: string;
  }[];
}

function dentro(a: string, b: string): boolean {
  // Mismo número, con o sin dígito verificador final.
  if (!a || !b) return false;
  if (a === b) return true;
  return (
    (a.length === b.length + 1 && a.startsWith(b)) ||
    (b.length === a.length + 1 && b.startsWith(a))
  );
}

let corriendo = false;

export function rifCompartidoCorriendo(): boolean {
  return corriendo;
}

/** Solo pruebas. */
export function _resetRifCompartido(): void {
  corriendo = false;
}

export async function ejecutarRifCompartido(
  svc: ExpedientesService,
  opts: { vistaPrevia: boolean; actor?: string },
): Promise<ResumenRifCompartido | { omitido: true; motivo: string }> {
  if (corriendo) return { omitido: true, motivo: 'en_curso' };
  corriendo = true;
  const actor = (opts.actor ?? 'rif_compartido').slice(0, 128);
  const r: ResumenRifCompartido = {
    vistaPrevia: opts.vistaPrevia,
    empresas: 0,
    origenes: 0,
    origenesConArchivoCambiado: 0,
    porCubrir: 0,
    porEstado: {},
    aplicados: 0,
    omitidosManuales: 0,
    errores: 0,
    ultimoError: null,
    muestra: [],
  };
  try {
    // 1. Orígenes posibles: cédula validada, con lectura propia del archivo actual.
    const validadas = await prisma.mktExpedienteRequisito.findMany({
      where: {
        tipo: 'cedula',
        estado: 'validado',
        AND: [
          { ref: { not: null } },
          { analisisRef: { not: null } },
          { archivoHash: { not: null } },
        ],
      },
    });
    const propias = validadas.filter(
      (q) =>
        q.analisisRef === q.ref &&
        q.validadoPor !== VALIDADO_POR_RIF_COMPARTIDO &&
        q.ocrDatos &&
        typeof q.ocrDatos === 'object',
    );
    const expIdsOrigen = [...new Set(propias.map((q) => q.expedienteId))];
    const expsOrigen = new Map(
      (
        await prisma.mktExpediente.findMany({
          where: { id: { in: expIdsOrigen } },
        })
      ).map((e) => [e.id, e]),
    );
    type Origen = {
      req: (typeof propias)[number];
      cnpoliza: string;
      empresaId: number;
      rif: string;
      tipoRif: string;
    };
    const candidatos: Origen[] = [];
    for (const q of propias) {
      const e = expsOrigen.get(q.expedienteId);
      if (!e || e.estadoDocumental === ESTADO_DESCARTADA) continue;
      const ctx = contextoPoliza(e);
      const tom = tomadorJuridico(ctx);
      if (!tom?.documento) continue;
      if (!lecturaEsRifDelTomador(q.ocrDatos as Record<string, unknown>, ctx))
        continue;
      candidatos.push({
        req: q,
        cnpoliza: e.cnpoliza,
        empresaId: e.empresaId,
        rif: numeroDocumento(tom.documento),
        tipoRif: String(tom.tipoDoc ?? '').toUpperCase(),
      });
    }
    // 2. Archivo todavía el analizado: sin marca y, con OCR, huella coincidente.
    const sinMarca = candidatos.filter((c) => {
      if (marcaArchivoCambiado(c.req)) {
        r.origenesConArchivoCambiado++;
        return false;
      }
      return true;
    });
    let origenes = sinMarca;
    if (ocrInternalConfig() && sinMarca.length) {
      const refs = [...new Set(sinMarca.map((c) => c.req.ref as string))];
      const huellas = new Map<string, { existe: boolean; hash: string | null }>();
      for (let i = 0; i < refs.length; i += MAX_HUELLAS_OCR) {
        const m = await huellasEnOcr(refs.slice(i, i + MAX_HUELLAS_OCR));
        for (const [k, v] of m) huellas.set(k, v);
      }
      origenes = sinMarca.filter((c) => {
        const h = huellas.get(c.req.ref as string);
        const ok = !!h && h.existe && h.hash === c.req.archivoHash;
        if (!ok) r.origenesConArchivoCambiado++;
        return ok;
      });
    }
    r.origenes = origenes.length;
    if (!origenes.length) return r;

    // Un origen por empresa tomadora (el validado más reciente).
    const porEmpresa: Origen[] = [];
    for (const o of [...origenes].sort(
      (a, b) =>
        (b.req.validadoEn?.getTime() ?? 0) - (a.req.validadoEn?.getTime() ?? 0),
    )) {
      if (
        !porEmpresa.some(
          (x) =>
            x.empresaId === o.empresaId &&
            x.tipoRif === o.tipoRif &&
            dentro(x.rif, o.rif),
        )
      )
        porEmpresa.push(o);
    }
    r.empresas = porEmpresa.length;

    // 3. Destinos: cédula faltante/observado/sobrescrito/recibido, o validada con archivo cambiado.
    const filas = await prisma.mktExpedienteRequisito.findMany({
      where: { tipo: 'cedula' },
    });
    const destinosCandidatos = filas.filter(
      (f) =>
        ['faltante', 'observado', 'sobrescrito', 'recibido'].includes(
          f.estado,
        ) ||
        (f.estado === 'validado' &&
          !!marcaArchivoCambiado(f) &&
          f.validadoPor !== VALIDADO_POR_RIF_COMPARTIDO),
    );
    const idsDest = [...new Set(destinosCandidatos.map((f) => f.expedienteId))];
    const expsDest = new Map(
      (
        await prisma.mktExpediente.findMany({ where: { id: { in: idsDest } } })
      ).map((e) => [e.id, e]),
    );
    const config = await svc.getConfig();
    for (const f of destinosCandidatos) {
      const e = expsDest.get(f.expedienteId);
      if (!e || e.estadoDocumental === ESTADO_DESCARTADA) continue;
      if (!requisitosAplicables(e.producto, config).includes('cedula'))
        continue;
      const tom = tomadorJuridico(contextoPoliza(e));
      if (!tom?.documento) continue;
      const rifE = numeroDocumento(tom.documento);
      const tipoE = String(tom.tipoDoc ?? '').toUpperCase();
      const origen = porEmpresa.find(
        (o) =>
          o.empresaId === e.empresaId &&
          o.tipoRif === tipoE &&
          dentro(o.rif, rifE),
      );
      if (!origen || origen.req.expedienteId === e.id) continue;
      // La decisión manual del administrador prevalece siempre.
      if (f.decision === 'manual') {
        r.omitidosManuales++;
        continue;
      }
      r.porCubrir++;
      r.porEstado[f.estado] = (r.porEstado[f.estado] ?? 0) + 1;
      if (r.muestra.length < 50)
        r.muestra.push({
          expedienteId: e.id,
          polizaOrigen: origen.cnpoliza,
          estadoAnterior: f.estado,
        });
      if (opts.vistaPrevia) continue;
      try {
        const ctx = await svc.contextoDe(e);
        const motivo = `RIF de la empresa, ya validado en la póliza ${origen.cnpoliza}`;
        const diagOrigen =
          origen.req.diagnostico &&
          typeof origen.req.diagnostico === 'object' &&
          !Array.isArray(origen.req.diagnostico)
            ? { ...(origen.req.diagnostico as Record<string, unknown>) }
            : {};
        delete diagOrigen.archivoCambiado;
        const upd = await prisma.mktExpedienteRequisito.updateMany({
          where: {
            id: f.id,
            estado: f.estado,
            ref: f.ref,
            decision: f.decision,
          },
          data: {
            estado: 'validado',
            motivo,
            ref: origen.req.ref,
            analisisRef: origen.req.ref,
            archivoHash: origen.req.archivoHash,
            ocrDatos: origen.req.ocrDatos as Prisma.InputJsonValue,
            ocrConfianza: origen.req.ocrConfianza,
            diagnostico: {
              ...diagOrigen,
              rifCompartido: {
                polizaOrigen: origen.cnpoliza,
                expedienteOrigen: origen.req.expedienteId,
              },
            } as Prisma.InputJsonValue,
            huellaPoliza: huellaPoliza(ctx),
            validadoEn: new Date(),
            validadoPor: VALIDADO_POR_RIF_COMPARTIDO,
            decision: 'ia',
            proximoAnalisis: null,
            analisisIntentos: 0,
          },
        });
        if (upd.count !== 1) continue;
        r.aplicados++;
        await svc.evento(e.id, EVENTO_RIF_COMPARTIDO, actor, {
          tipo: 'cedula',
          anterior: f.estado,
          nuevo: 'validado',
          motivo,
          polizaOrigen: origen.cnpoliza,
          expedienteOrigen: origen.req.expedienteId,
          refAnterior: f.ref,
        });
        await svc.recalcularEstado(e.id, config);
      } catch (err) {
        r.errores++;
        r.ultimoError = (err instanceof Error ? err.message : 'error').slice(
          0,
          200,
        );
        logger.warn(`[expedientes] rif compartido: ${r.ultimoError}`);
      }
    }
  } catch (err) {
    r.errores++;
    r.ultimoError = (err instanceof Error ? err.message : 'error').slice(
      0,
      200,
    );
    logger.error(`[expedientes] rif compartido: ${r.ultimoError}`);
  } finally {
    corriendo = false;
  }
  return r;
}
