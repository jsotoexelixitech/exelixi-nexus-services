/**
 * Corrección de nombre y apellido mal guardados (24-nov-2026, punto 3): pólizas 144583 y 139376.
 *
 * Acción admin por póliza explícita (lista corta, máximo 20, vista previa por defecto): toma el
 * nombre y apellido del cliente en Sis2000 (maclient) por el documento del asegurado, con la ruta de
 * solo lectura de nest-api POST /api/v1/canal/clientes-nombre (scope expedientes:clientes).
 *
 * Reglas:
 * - Solo corrige `aseguradoNombre` y `aseguradoApellido` (y el nombre del asegurado/titular del
 *   snapshot que tenga ESE mismo documento) cuando el documento coincide.
 * - Si corregir implicaría cambiar el documento, el tipo de documento o `aseguradoKey` (que reagrupa
 *   enlaces y correos), NO lo aplica: lo muestra como «requiere decisión».
 * - Sin correos, sin IA, sin tocar requisitos ni documentos. UPDATE condicional y evento.
 * - Apagado por defecto: EXPEDIENTES_NOMBRES_ENABLED=true (solo rutas manuales).
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';
import logger from '../../utils/logger';
import { expedientesEnabled } from './expedientes.env';
import { numeroDocumento } from './expedientes.ia';

export const EVENTO_NOMBRE_CORREGIDO = 'nombre_corregido';
export const MAX_POLIZAS_NOMBRES = 20;
const PATRON_POLIZA = /^[0-9A-Za-z-]{1,64}$/;
const TIMEOUT_NEST_MS = 60_000;

function varTexto(...nombres: string[]): string {
  for (const n of nombres) {
    const v = String(process.env[n] ?? '').trim();
    if (v) return v;
  }
  return '';
}

export interface NombresConfig {
  nestUrl: string;
  nestKey: string;
}

/** Apagada salvo EXPEDIENTES_ENABLED + EXPEDIENTES_NOMBRES_ENABLED=true con URL y key. */
export function nombresConfig(): NombresConfig | null {
  if (
    !expedientesEnabled() ||
    String(process.env.EXPEDIENTES_NOMBRES_ENABLED ?? '')
      .trim()
      .toLowerCase() !== 'true'
  )
    return null;
  const nestUrl = varTexto(
    'EXPEDIENTES_NOMBRES_NEST_URL',
    'EXPEDIENTES_PAGOS_NEST_URL',
    'EXPEDIENTES_HISTORICO_NEST_URL',
  ).replace(/\/+$/, '');
  const nestKey = varTexto(
    'EXPEDIENTES_NOMBRES_NEST_KEY',
    'EXPEDIENTES_PAGOS_NEST_KEY',
    'EXPEDIENTES_HISTORICO_NEST_KEY',
  );
  return nestUrl && nestKey ? { nestUrl, nestKey } : null;
}

export function urlClientesNombre(nestUrl: string): string {
  const base = nestUrl.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${base}/api/v1/canal/clientes-nombre`;
}

export interface ClienteSis2000 {
  cci_rif: string;
  ipersona: string | null;
  xnombre: string | null;
  xapellido: string | null;
}

function texto(v: unknown): string | null {
  const s = v == null ? '' : String(v).trim();
  return s || null;
}

export async function consultarNombres(
  cfg: NombresConfig,
  documentos: string[],
): Promise<Map<string, ClienteSis2000>> {
  const res = await fetch(urlClientesNombre(cfg.nestUrl), {
    method: 'POST',
    headers: {
      apikey: cfg.nestKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ documentos }),
    signal: AbortSignal.timeout(TIMEOUT_NEST_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.status === false)
    throw new Error(`nest-api respondió HTTP ${res.status}`);
  const data = Array.isArray(body.data) ? body.data : null;
  if (!data) throw new Error('nest-api: respuesta sin data');
  const out = new Map<string, ClienteSis2000>();
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const cci = texto(r.cci_rif);
    if (!cci) continue;
    out.set(numeroDocumento(cci), {
      cci_rif: cci,
      ipersona: texto(r.ipersona)?.toUpperCase() ?? null,
      xnombre: texto(r.xnombre),
      xapellido: texto(r.xapellido),
    });
  }
  return out;
}

export type EstadoPropuesta =
  | 'corregible'
  | 'sin_cambio'
  | 'requiere_decision'
  | 'no_encontrado'
  | 'poliza_no_encontrada'
  | 'poliza_ambigua';

export interface PropuestaNombre {
  cnpoliza: string;
  expedienteId: number | null;
  estado: EstadoPropuesta;
  motivo: string | null;
  actual: { nombre: string | null; apellido: string | null } | null;
  sis2000: { nombre: string | null; apellido: string | null } | null;
  aplicado: boolean;
}

export interface ResumenNombres {
  vistaPrevia: boolean;
  propuestas: PropuestaNombre[];
  aplicados: number;
}

const TIPOS_JURIDICOS = ['J', 'G', 'C'];

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Tomador, asegurado y titular del snapshot con ese MISMO documento: corrige su nombre y apellido. */
function snapshotCorregido(
  snapshot: unknown,
  docNum: string,
  nombre: string | null,
  apellido: string | null,
): Record<string, unknown> | null {
  const snap = { ...rec(snapshot) };
  let cambio = false;
  for (const k of ['tomador', 'asegurado', 'titular']) {
    const p = rec(snap[k]);
    const d = numeroDocumento(
      String(p.documento ?? p.identificacion ?? p.cedula ?? ''),
    );
    if (!d || d !== docNum) continue;
    snap[k] = {
      ...p,
      ...(nombre ? { nombre } : {}),
      ...(apellido ? { apellido } : {}),
    };
    cambio = true;
  }
  return cambio ? snap : null;
}

export async function corregirNombres(opts: {
  polizas: string[];
  vistaPrevia: boolean;
  actor?: string;
  empresaId?: number;
}): Promise<ResumenNombres> {
  const cfg = nombresConfig();
  if (!cfg) throw new AppError('Corrección de nombres apagada o sin configurar.', 409);
  const polizas = [...new Set(opts.polizas.map((p) => p.trim()))].filter(Boolean);
  if (!polizas.length) throw new AppError('Indique al menos una póliza.', 400);
  if (polizas.length > MAX_POLIZAS_NOMBRES)
    throw new AppError(`Máximo ${MAX_POLIZAS_NOMBRES} pólizas por vez.`, 400);
  if (polizas.some((p) => !PATRON_POLIZA.test(p)))
    throw new AppError('Póliza con formato inválido.', 400);
  const actor = (opts.actor ?? 'nombres').slice(0, 128);

  const exps = await prisma.mktExpediente.findMany({
    where: {
      cnpoliza: { in: polizas },
      ...(opts.empresaId ? { empresaId: opts.empresaId } : {}),
    },
  });
  const docs = [
    ...new Set(
      exps
        .map((e) => numeroDocumento(e.aseguradoDocumento))
        .filter((d) => /^\d{1,20}$/.test(d)),
    ),
  ];
  let sis = new Map<string, ClienteSis2000>();
  if (docs.length) sis = await consultarNombres(cfg, docs);

  const resumen: ResumenNombres = {
    vistaPrevia: opts.vistaPrevia,
    propuestas: [],
    aplicados: 0,
  };
  for (const cnpoliza of polizas) {
    const lista = exps.filter((e) => e.cnpoliza === cnpoliza);
    const base = {
      cnpoliza,
      expedienteId: null as number | null,
      motivo: null as string | null,
      actual: null as PropuestaNombre['actual'],
      sis2000: null as PropuestaNombre['sis2000'],
      aplicado: false,
    };
    if (!lista.length) {
      resumen.propuestas.push({ ...base, estado: 'poliza_no_encontrada' });
      continue;
    }
    if (lista.length > 1) {
      resumen.propuestas.push({
        ...base,
        estado: 'poliza_ambigua',
        motivo: 'Hay expedientes de varias empresas con ese número; indique empresaId.',
      });
      continue;
    }
    const e = lista[0];
    const prop: PropuestaNombre = {
      ...base,
      expedienteId: e.id,
      estado: 'no_encontrado',
      actual: { nombre: e.aseguradoNombre, apellido: e.aseguradoApellido },
    };
    resumen.propuestas.push(prop);
    const docNum = numeroDocumento(e.aseguradoDocumento);
    if (!/^\d{1,20}$/.test(docNum)) {
      prop.estado = 'requiere_decision';
      prop.motivo = 'El expediente no tiene un documento numérico para buscar en Sis2000.';
      continue;
    }
    const c = sis.get(docNum);
    if (!c) {
      prop.motivo = 'No hay un cliente en Sis2000 con ese documento.';
      continue;
    }
    prop.sis2000 = { nombre: c.xnombre, apellido: c.xapellido };
    if (!c.xnombre && !c.xapellido) {
      prop.estado = 'requiere_decision';
      prop.motivo = 'El cliente de Sis2000 no tiene nombre ni apellido.';
      continue;
    }
    // El tipo de documento forma parte de aseguradoKey: si no cuadra, corregir no basta.
    const tipoE = String(e.aseguradoTipoDoc ?? '').toUpperCase();
    const juridicoSis = c.ipersona === 'J';
    const juridicoE = TIPOS_JURIDICOS.includes(tipoE);
    if (c.ipersona && (c.ipersona === 'J' || c.ipersona === 'N') && juridicoSis !== juridicoE) {
      prop.estado = 'requiere_decision';
      prop.motivo =
        'El tipo de documento del expediente no es el de Sis2000; corregirlo cambiaría la clave del asegurado (enlaces y correos).';
      continue;
    }
    const nombre = c.xnombre ?? e.aseguradoNombre;
    const apellido = c.xapellido ?? e.aseguradoApellido;
    if (nombre === e.aseguradoNombre && apellido === e.aseguradoApellido) {
      prop.estado = 'sin_cambio';
      continue;
    }
    prop.estado = 'corregible';
    if (opts.vistaPrevia) continue;
    const snap = snapshotCorregido(e.snapshot, docNum, nombre, apellido);
    const upd = await prisma.mktExpediente.updateMany({
      where: {
        id: e.id,
        aseguradoDocumento: e.aseguradoDocumento,
        aseguradoNombre: e.aseguradoNombre,
        aseguradoApellido: e.aseguradoApellido,
      },
      data: {
        aseguradoNombre: nombre,
        aseguradoApellido: apellido,
        ...(snap ? { snapshot: snap as Prisma.InputJsonValue } : {}),
      },
    });
    if (upd.count !== 1) continue;
    prop.aplicado = true;
    resumen.aplicados++;
    await prisma.mktExpedienteEvento.create({
      data: {
        expedienteId: e.id,
        tipo: EVENTO_NOMBRE_CORREGIDO,
        actor,
        detalle: {
          origen: 'Sis2000',
          anterior: { nombre: e.aseguradoNombre, apellido: e.aseguradoApellido },
          nuevo: { nombre, apellido },
          snapshotActualizado: !!snap,
        } as Prisma.InputJsonValue,
      },
    });
    logger.info(`[expedientes] nombre corregido en el expediente ${e.id}`);
  }
  return resumen;
}
