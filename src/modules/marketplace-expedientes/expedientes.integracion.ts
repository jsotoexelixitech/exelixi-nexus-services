/**
 * API de documentos del expediente para integradores (nest-api → Nexus, 12-nov-2026).
 *
 * - registrar: nest-api avisa cada póliza emitida por una API de integración (Pastora: riesgos-generales
 *   ramo 25; Viajero: viajero-*). Crea el expediente con sus requisitos (área canal del integrador) y
 *   queda en el monitor y el reporte diario como cualquier otra póliza.
 * - estado: documentos de la póliza con los estados del contrato publicado.
 * - cargar: guarda el documento con el mismo flujo de la página pública (OCR /documento → IA →
 *   validado/observado). Responde enseguida («recibido»); la lectura y la IA siguen en segundo plano.
 *
 * Solo el integrador que emitió la póliza la ve o le carga documentos (snapshot.integracion.integrador);
 * cualquier otra póliza responde 404, exista o no.
 */
import type { MktExpediente, Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { AppError } from '../../utils/app-error';
import {
  areaDesdeVendedor,
  aseguradoKey,
  requisitoLabel,
  requisitosAplicables,
} from './expedientes.domain';
import { ArchivoCargado } from './expedientes.files';
import { diagnosticoVigente, motivoParaAsegurado } from './expedientes.ia';
import {
  armarRequisitos,
  esDuenoDe,
  estadoContrato,
  EstadoContrato,
  IntegracionSnapshot,
  integracionDe,
  personaPorDocumento,
  PRODUCTOS_INTEGRACION,
  TIPOS_CONTRATO,
  TIPOS_POR_PRODUCTO,
  tipoPorDefecto,
} from './expedientes.integracion.domain';
import { expedientesService as svc } from './expedientes.service';

/** Máximo del archivo en la API de integradores (contrato: 10 MB). */
export const MAX_ARCHIVO_INTEGRACION = 10 * 1024 * 1024;

const MENSAJE_NO_ENCONTRADA = 'Póliza no encontrada.';

/**
 * Empresa (Nexus) de las pólizas de integración: EXPEDIENTES_INTEGRACION_EMPRESA_ID o, si falta,
 * la del portal Sis2000 (PORTAL_SIS2000_EMPRESA_ID), que es La Mundial.
 */
export function empresaIntegracion(): number | null {
  for (const k of [
    'EXPEDIENTES_INTEGRACION_EMPRESA_ID',
    'PORTAL_SIS2000_EMPRESA_ID',
  ]) {
    const n = Number(process.env[k]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

function empresaObligatoria(): number {
  const id = empresaIntegracion();
  if (!id)
    throw new AppError(
      'API de expedientes sin empresa: defina EXPEDIENTES_INTEGRACION_EMPRESA_ID o PORTAL_SIS2000_EMPRESA_ID en nexus-api.',
      503,
    );
  return id;
}

// ─── Esquemas ─────────────────────────────────────────────────────────────

const optStr = (max: number) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().max(max))
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const personaSchema = z.object({
  tipoDoc: optStr(2),
  documento: optStr(32),
  nombre: optStr(150),
  apellido: optStr(150),
});

export const integradorSchema = z.string().trim().min(8).max(128);

export const registroIntegracionSchema = z.object({
  integrador: integradorSchema,
  apiKeyId: optStr(64),
  producto: z.enum(PRODUCTOS_INTEGRACION),
  cnpoliza: z.string().trim().min(1).max(64),
  cnrecibo: optStr(64),
  cramo: z.coerce.number().int().optional().nullable(),
  cplan: optStr(16),
  canal: z
    .object({
      centidad: optStr(1),
      citem: optStr(32),
      ccanalalt: optStr(32),
      cscanalalt: optStr(32),
      cgestor: optStr(50),
      cproductor: optStr(32),
      xcanalVenta: optStr(100),
    })
    .partial()
    .optional()
    .nullable(),
  tomador: personaSchema.optional().nullable(),
  personas: z.array(personaSchema).max(50).optional().default([]),
});
export type RegistroIntegracion = z.infer<typeof registroIntegracionSchema>;

export const cargaIntegracionSchema = z.object({
  integrador: integradorSchema,
  tipo: z.enum(TIPOS_CONTRATO, {
    errorMap: () => ({
      message: `tipo inválido. Use: ${TIPOS_CONTRATO.join(', ')}.`,
    }),
  }),
  documento: optStr(32),
});

// ─── Registro ─────────────────────────────────────────────────────────────

async function buscar(cnpoliza: string): Promise<MktExpediente | null> {
  const empresaId = empresaObligatoria();
  return prisma.mktExpediente.findUnique({
    where: {
      empresaId_cnpoliza: { empresaId, cnpoliza: String(cnpoliza).trim() },
    },
  });
}

/** Expediente del integrador o 404 (también si existe y es de otro: no se revela). */
async function delIntegrador(
  integrador: string,
  cnpoliza: string,
): Promise<{ exp: MktExpediente; integ: IntegracionSnapshot }> {
  const exp = await buscar(cnpoliza);
  const integ = exp ? integracionDe(exp.snapshot) : null;
  if (!exp || !integ || !esDuenoDe(exp.snapshot, integrador))
    throw new AppError(MENSAJE_NO_ENCONTRADA, 404);
  return { exp, integ };
}

/**
 * Registra (idempotente) la póliza emitida por una API de integración. Una póliza ya registrada
 * por otro integrador o por otra vía (Emisión, conciliación) no se toca: 409.
 */
export async function registrarIntegracion(
  input: RegistroIntegracion,
): Promise<{ id: number; creado: boolean }> {
  const empresaId = empresaObligatoria();
  const cnpoliza = input.cnpoliza.trim();
  const existente = await prisma.mktExpediente.findUnique({
    where: { empresaId_cnpoliza: { empresaId, cnpoliza } },
  });
  if (existente) {
    if (esDuenoDe(existente.snapshot, input.integrador))
      return { id: existente.id, creado: false };
    logger.warn(
      `[expedientes] integración: póliza ${cnpoliza} ya registrada (expediente ${existente.id}, origen ${existente.origen}); no se cambia de dueño`,
    );
    throw new AppError('La póliza ya está registrada en el monitor.', 409);
  }

  const { requisitos, personas } = armarRequisitos(
    input.producto,
    input.tomador,
    input.personas ?? [],
  );
  if (!requisitos.length)
    throw new AppError(
      'La póliza no trae personas con documento para el expediente.',
      400,
    );

  const canal = input.canal ?? {};
  const ccanalalt = canal.ccanalalt ?? null;
  const vendedor = {
    centidad: (canal.centidad ?? 'C').toUpperCase(),
    // Sin código de canal en la apikey: el nombre del canal de venta identifica al integrador.
    citem: canal.citem ?? ccanalalt ?? canal.xcanalVenta?.slice(0, 32) ?? null,
    cgestor: canal.cgestor ?? null,
    ccanalalt,
    cproductor: canal.cproductor ?? null,
  };
  const area = areaDesdeVendedor(vendedor);
  // Asegurado del monitor: el tomador en Pastora; el primer viajero (titular) en Viajero.
  const principal = personas[0] ?? null;
  const integracion: IntegracionSnapshot = {
    version: 1,
    integrador: input.integrador,
    apiKeyId: input.apiKeyId ?? null,
    producto: input.producto,
    requisitos,
    personas,
    recibidos: {},
  };
  const snapshot = {
    tomador: input.tomador
      ? {
          tipoDoc: input.tomador.tipoDoc,
          documento: input.tomador.documento,
          nombre: input.tomador.nombre,
          apellido: input.tomador.apellido,
        }
      : null,
    ...(input.producto === 'viajero'
      ? {
          asegurados: personas.map((p) => ({
            tipoDoc: p.tipoDoc,
            documento: p.documento,
            nombre: p.nombre,
            apellido: p.apellido,
          })),
        }
      : {}),
    plan: input.cplan ?? null,
    canalNombre: canal.xcanalVenta ?? null,
    // Los documentos los carga el integrador: sin correos al cliente (recordatorios ni avisos).
    correos: [],
    integracion,
  };

  let exp: MktExpediente;
  try {
    exp = await prisma.mktExpediente.create({
      data: {
        empresaId,
        cnpoliza,
        cnrecibo: input.cnrecibo ?? null,
        producto: input.producto,
        cramo: input.cramo ?? null,
        area,
        ...vendedor,
        xlogin: canal.xcanalVenta?.slice(0, 100) ?? null,
        estadoDocumental: 'incompleto',
        infoDocumental: true,
        aseguradoKey: principal
          ? aseguradoKey({
              tipoDoc: principal.tipoDoc,
              documento: principal.documento,
            })
          : null,
        aseguradoTipoDoc: principal?.tipoDoc?.slice(0, 2) ?? null,
        aseguradoDocumento: principal?.documento.slice(0, 32) ?? null,
        aseguradoNombre: principal?.nombre ?? null,
        aseguradoApellido: principal?.apellido ?? null,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        origen: 'integracion',
        emitidaEn: new Date(),
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    // Carrera con otro aviso de la misma póliza.
    const otro = await prisma.mktExpediente.findUnique({
      where: { empresaId_cnpoliza: { empresaId, cnpoliza } },
    });
    if (otro && esDuenoDe(otro.snapshot, input.integrador))
      return { id: otro.id, creado: false };
    throw new AppError('La póliza ya está registrada en el monitor.', 409);
  }
  await svc.evento(exp.id, 'expediente_creado', 'integracion', {
    area: exp.area,
    producto: exp.producto,
    origen: 'integracion',
    requisitos,
    apiKeyId: input.apiKeyId ?? null,
  });
  // Crea los requisitos (faltante) y deja el estado documental al día.
  await svc.recalcularEstado(exp.id);
  return { id: exp.id, creado: true };
}

// ─── Estado ───────────────────────────────────────────────────────────────

export interface DocumentoContrato {
  tipo: string;
  documento?: string;
  estado: EstadoContrato;
  motivo?: string;
}

export interface EstadoExpedienteContrato {
  cnpoliza: string;
  estado: 'completo' | 'incompleto';
  documentos: DocumentoContrato[];
}

export async function estadoIntegracion(
  integrador: string,
  cnpoliza: string,
): Promise<EstadoExpedienteContrato> {
  const { exp, integ } = await delIntegrador(integrador, cnpoliza);
  const config = await svc.getConfig();
  const reqs = await prisma.mktExpedienteRequisito.findMany({
    where: { expedienteId: exp.id },
  });
  const documentos = requisitosAplicables(exp, config).map((tipoReq) => {
    const r = reqs.find((x) => x.tipo === tipoReq);
    const persona = integ.personas.find((p) => p.requisito === tipoReq);
    const estado = estadoContrato(r?.estado ?? 'faltante');
    const tipo =
      integ.recibidos[tipoReq]?.tipo ?? tipoPorDefecto(integ.producto, persona);
    const out: DocumentoContrato = { tipo, estado };
    if (integ.producto === 'viajero' && persona)
      out.documento = persona.documento;
    if (estado === 'por_corregir') {
      const diag = r ? diagnosticoVigente(r) : null;
      // Al integrador, como al asegurado: nunca el resumen de la IA (trae datos de la póliza).
      const motivo = diag ? motivoParaAsegurado(diag) : r?.motivo;
      if (motivo) out.motivo = motivo;
    }
    return out;
  });
  return {
    cnpoliza: exp.cnpoliza,
    estado: exp.estadoDocumental === 'completo' ? 'completo' : 'incompleto',
    documentos,
  };
}

// ─── Carga ────────────────────────────────────────────────────────────────

const colas = new Map<number, Promise<unknown>>();

/** Ejecuta las escrituras del snapshot de una misma póliza una tras otra (este proceso). */
function enSerie<T>(id: number, fn: () => Promise<T>): Promise<T> {
  const previa = colas.get(id) ?? Promise.resolve();
  const actual = previa.catch(() => undefined).then(fn);
  colas.set(id, actual);
  void actual
    .catch(() => undefined)
    .finally(() => {
      if (colas.get(id) === actual) colas.delete(id);
    });
  return actual;
}

export const MENSAJE_REENVIAR =
  'No se pudo guardar el documento. Envíelo de nuevo.';

/**
 * Valida y deja el requisito «recibido»; la lectura OCR y la IA siguen en segundo plano con el mismo
 * flujo de la página pública (cargarDocumento). Reenviar reemplaza al anterior.
 * `procesar` permite a las pruebas esperar el segundo plano.
 */
export async function cargarIntegracion(
  params: {
    integrador: string;
    cnpoliza: string;
    tipo: string;
    documento?: string | null;
    file: ArchivoCargado;
  },
  procesar: (tarea: () => Promise<void>) => void = (t) => {
    setImmediate(() => void t());
  },
): Promise<{ tipo: string; documento?: string; estado: 'recibido' }> {
  const { exp, integ } = await delIntegrador(
    params.integrador,
    params.cnpoliza,
  );
  const tipo = params.tipo;
  const permitidos = TIPOS_POR_PRODUCTO[integ.producto];
  if (!(permitidos as string[]).includes(tipo))
    throw new AppError(
      `El tipo ${tipo} no se pide en esta póliza. Use: ${permitidos.join(', ')}.`,
      400,
    );
  if (params.file.size > MAX_ARCHIVO_INTEGRACION)
    throw new AppError('El archivo supera el máximo de 10 MB.', 413);

  let requisito: string;
  let documento: string | undefined;
  if (integ.producto === 'viajero') {
    if (!params.documento)
      throw new AppError(
        'documento es obligatorio en Viajero (número de la persona).',
        400,
      );
    const persona = personaPorDocumento(integ, params.documento);
    if (!persona)
      throw new AppError(
        'El documento no corresponde a ningún viajero de la póliza.',
        400,
      );
    requisito = persona.requisito;
    documento = persona.documento;
  } else {
    requisito = integ.requisitos[0] ?? 'cedula';
  }

  // Tipo declarado (cédula, RIF o pasaporte): lo usan el OCR y el comparador de este requisito.
  // En serie por póliza: dos viajeros cargados a la vez no se pisan el snapshot.
  const actualizado = await enSerie(exp.id, async () => {
    const actual =
      (await prisma.mktExpediente.findUnique({ where: { id: exp.id } })) ??
      exp;
    const snap = (
      actual.snapshot && typeof actual.snapshot === 'object'
        ? actual.snapshot
        : {}
    ) as Record<string, unknown>;
    const integActual = integracionDe(actual.snapshot) ?? integ;
    const integNueva: IntegracionSnapshot = {
      ...integActual,
      recibidos: {
        ...integActual.recibidos,
        [requisito]: {
          tipo,
          documento: documento ?? null,
          en: new Date().toISOString(),
        },
      },
    };
    return prisma.mktExpediente.update({
      where: { id: exp.id },
      data: {
        snapshot: {
          ...snap,
          integracion: integNueva,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  });

  // Recibido desde ya: la consulta no muestra «pendiente» mientras el OCR lee.
  await svc.recalcularEstado(exp.id);
  await prisma.mktExpedienteRequisito.updateMany({
    where: { expedienteId: exp.id, tipo: requisito },
    data: {
      estado: 'recibido',
      motivo: null,
      origen: 'integracion',
      // Reemplaza al anterior: sin archivo hasta que el OCR guarde el nuevo (nadie analiza el viejo).
      ref: null,
      ocrConfianza: null,
      analisisRef: null,
      archivoHash: null,
      analisisIntentos: 0,
      proximoAnalisis: null,
      recibidoEn: new Date(),
      validadoEn: null,
      validadoPor: null,
      decision: null,
    },
  });
  await svc.recalcularEstado(exp.id);

  const file = params.file;
  procesar(async () => {
    try {
      await svc.cargarDocumento({
        expedientes: [actualizado],
        tipo: requisito,
        file,
        origen: 'integracion',
        actor: `integracion:${integ.producto}`,
      });
    } catch (err) {
      const msg =
        err instanceof AppError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'error';
      logger.warn(
        `[expedientes] integración: no se pudo guardar ${requisitoLabel(requisito)} del expediente ${exp.id}: ${msg}`,
      );
      // El integrador lo ve «por_corregir» con el motivo y lo reenvía.
      await prisma.mktExpedienteRequisito
        .updateMany({
          where: { expedienteId: exp.id, tipo: requisito, ref: null },
          data: {
            estado: 'observado',
            motivo:
              err instanceof AppError && err.statusCode < 500
                ? err.message
                : MENSAJE_REENVIAR,
          },
        })
        .catch(() => undefined);
      await svc
        .eventoTecnico(
          {
            etapa: 'carga_integracion',
            tipo: requisito,
            error: msg.slice(0, 300),
          },
          exp.id,
        )
        .catch(() => undefined);
      await svc.recalcularEstado(exp.id).catch(() => undefined);
    }
  });

  return {
    tipo,
    ...(documento ? { documento } : {}),
    estado: 'recibido',
  };
}
