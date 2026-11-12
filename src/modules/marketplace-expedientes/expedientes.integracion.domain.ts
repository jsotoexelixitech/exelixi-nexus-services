/**
 * API de documentos del expediente para integradores (Pastora, Viajero y los que vengan).
 * Reglas puras (sin BD): requisitos por producto, personas de la póliza, dueño de la póliza,
 * tipo de documento de cada requisito y estados del contrato publicado.
 *
 * Lo propio de la póliza de integración vive en `snapshot.integracion` (sin migración):
 *   { version, integrador, apiKeyId, producto, requisitos[], personas[], recibidos{} }
 * - integrador: identificador de la apikey de nest-api que emitió (dueño de la póliza).
 * - requisitos: lista de requisitos de esa póliza (Viajero: uno por viajero).
 * - personas: a quién corresponde cada requisito (documento y nombre, para la IA).
 * - recibidos: el tipo de documento que mandó el integrador en cada requisito (cedula, rif, pasaporte).
 */
import { PREFIJO_REQUISITO_VIAJERO } from './expedientes.domain';
import {
  ContextoPoliza,
  numeroDocumento,
  PersonaPoliza,
} from './expedientes.ia';

export const PRODUCTOS_INTEGRACION = ['pastora', 'viajero'] as const;
export type ProductoIntegracion = (typeof PRODUCTOS_INTEGRACION)[number];

/** Tipos del contrato publicado (`tipo` del POST). */
export const TIPOS_CONTRATO = [
  'cedula',
  'rif',
  'pasaporte',
  'licencia',
  'certificado',
  'factura',
] as const;
export type TipoContrato = (typeof TIPOS_CONTRATO)[number];

/** Tipos que pide cada producto. */
export const TIPOS_POR_PRODUCTO: Record<ProductoIntegracion, TipoContrato[]> = {
  // Cédula o RIF del tomador.
  pastora: ['cedula', 'rif'],
  // Cédula o pasaporte de cada viajero.
  viajero: ['cedula', 'pasaporte'],
};

/** Estados del contrato publicado. */
export type EstadoContrato = 'pendiente' | 'recibido' | 'validado' | 'por_corregir';

/** Máximo de viajeros por póliza (VIAJE3/VIAJE4 admiten titular + 5 dependientes). */
export const MAX_PERSONAS_INTEGRACION = 20;

export interface PersonaIntegracion {
  requisito: string;
  tipoDoc: string | null;
  documento: string;
  nombre: string | null;
  apellido: string | null;
}

export interface RecibidoIntegracion {
  tipo: string;
  documento?: string | null;
  en: string;
}

export interface IntegracionSnapshot {
  version: 1;
  integrador: string;
  apiKeyId: string | null;
  producto: ProductoIntegracion;
  requisitos: string[];
  personas: PersonaIntegracion[];
  recibidos: Record<string, RecibidoIntegracion>;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function texto(v: unknown): string | null {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
}

export function esProductoIntegracion(v: unknown): v is ProductoIntegracion {
  return (PRODUCTOS_INTEGRACION as readonly string[]).includes(String(v));
}

/**
 * Tipo de documento V/E/J/G/C/P: el informado o el prefijo del número (V-12345678, P-EM123).
 */
export function tipoDocDe(tipoDoc: unknown, documento: unknown): string | null {
  const t = texto(tipoDoc)?.toUpperCase().slice(0, 1) ?? null;
  if (t && /^[VEJGCP]$/.test(t)) return t;
  const m = /^([VEJGCP])[-\s]?[A-Z0-9]/i.exec(String(documento ?? '').trim());
  return m ? m[1].toUpperCase() : null;
}

/**
 * Número comparable de una persona: sin prefijo V/E/J/G/C/P, sin separadores ni ceros a la
 * izquierda. El pasaporte conserva las letras (P-EM2849387 → EM2849387).
 */
export function documentoComparable(v: unknown): string {
  const s = String(v ?? '')
    .trim()
    .toUpperCase()
    .replace(/^P[-\s]+/, '');
  return numeroDocumento(s);
}

/** Lee la parte de integración del snapshot; null si la póliza no es de integración. */
export function integracionDe(snapshot: unknown): IntegracionSnapshot | null {
  const i = rec(rec(snapshot).integracion);
  const integrador = texto(i.integrador);
  if (!integrador || !esProductoIntegracion(i.producto)) return null;
  const requisitos = Array.isArray(i.requisitos)
    ? i.requisitos.filter((t): t is string => typeof t === 'string')
    : [];
  const personas = (Array.isArray(i.personas) ? i.personas : [])
    .map((p) => rec(p))
    .filter((p) => texto(p.requisito) && texto(p.documento))
    .map(
      (p): PersonaIntegracion => ({
        requisito: String(p.requisito),
        tipoDoc: texto(p.tipoDoc),
        documento: String(p.documento),
        nombre: texto(p.nombre),
        apellido: texto(p.apellido),
      }),
    );
  const recibidos: Record<string, RecibidoIntegracion> = {};
  for (const [k, v] of Object.entries(rec(i.recibidos))) {
    const r = rec(v);
    const tipo = texto(r.tipo);
    if (tipo)
      recibidos[k] = {
        tipo,
        documento: texto(r.documento),
        en: texto(r.en) ?? '',
      };
  }
  return {
    version: 1,
    integrador,
    apiKeyId: texto(i.apiKeyId),
    producto: i.producto as ProductoIntegracion,
    requisitos,
    personas,
    recibidos,
  };
}

/** La póliza es de este integrador (misma apikey que la emitió). */
export function esDuenoDe(snapshot: unknown, integrador: string): boolean {
  const i = integracionDe(snapshot);
  return !!i && !!integrador && i.integrador === integrador;
}

export interface PersonaEntrada {
  tipoDoc?: string | null;
  documento?: string | number | null;
  nombre?: string | null;
  apellido?: string | null;
}

/**
 * Requisitos y personas de la póliza al registrarla:
 * - pastora: un requisito `cedula` (cédula o RIF) del tomador.
 * - viajero: un requisito `viajero_N` por viajero (sin repetir documento), en orden.
 */
export function armarRequisitos(
  producto: ProductoIntegracion,
  tomador: PersonaEntrada | null | undefined,
  personas: PersonaEntrada[],
): { requisitos: string[]; personas: PersonaIntegracion[] } {
  const persona = (
    p: PersonaEntrada,
    requisito: string,
  ): PersonaIntegracion | null => {
    const documento = documentoComparable(p.documento);
    if (!documento) return null;
    return {
      requisito,
      tipoDoc: tipoDocDe(p.tipoDoc, p.documento),
      documento,
      nombre: texto(p.nombre),
      apellido: texto(p.apellido),
    };
  };
  if (producto === 'pastora') {
    const t = tomador ? persona(tomador, 'cedula') : null;
    return { requisitos: ['cedula'], personas: t ? [t] : [] };
  }
  const out: PersonaIntegracion[] = [];
  for (const p of personas) {
    if (out.length >= MAX_PERSONAS_INTEGRACION) break;
    const doc = documentoComparable(p.documento);
    if (!doc || out.some((x) => x.documento === doc)) continue;
    const r = persona(p, `${PREFIJO_REQUISITO_VIAJERO}${out.length + 1}`);
    if (r) out.push(r);
  }
  return { requisitos: out.map((p) => p.requisito), personas: out };
}

/** Tipo del contrato que se informa para un requisito todavía sin documento. */
export function tipoPorDefecto(
  producto: ProductoIntegracion,
  persona: Pick<PersonaIntegracion, 'tipoDoc'> | null | undefined,
): TipoContrato {
  const t = persona?.tipoDoc ?? null;
  if (producto === 'pastora')
    return t === 'J' || t === 'G' || t === 'C' ? 'rif' : 'cedula';
  return t === 'P' ? 'pasaporte' : 'cedula';
}

/**
 * Tipo de documento real de un requisito (lo que se manda al OCR y al comparador): el que informó
 * el integrador al cargarlo; si no, el que corresponde a la persona; fuera de integración, el mismo
 * requisito (RCV, personas y patrimoniales no cambian).
 */
export function tipoDocumentoDeRequisito(
  exp: { snapshot?: unknown },
  tipoRequisito: string,
): string {
  const i = integracionDe(exp.snapshot);
  if (!i) return tipoRequisito;
  const recibido = i.recibidos[tipoRequisito]?.tipo;
  if (recibido) return recibido;
  if (i.producto === 'viajero') {
    const p = i.personas.find((x) => x.requisito === tipoRequisito);
    return tipoPorDefecto('viajero', p);
  }
  return tipoRequisito;
}

/**
 * Viajero: el documento de cada requisito se compara SOLO con su viajero (no con cualquiera de la
 * póliza). Lo demás devuelve el contexto sin cambios.
 */
export function contextoDeRequisito(
  ctx: ContextoPoliza,
  exp: { snapshot?: unknown },
  tipoRequisito: string,
): ContextoPoliza {
  const i = integracionDe(exp.snapshot);
  if (!i || i.producto !== 'viajero') return ctx;
  const p = i.personas.find((x) => x.requisito === tipoRequisito);
  if (!p) return ctx;
  const persona: PersonaPoliza = {
    rol: 'tomador',
    roles: ['tomador', 'asegurado'],
    tipoDoc: p.tipoDoc,
    documento: p.documento,
    nombre: p.nombre,
    apellido: p.apellido,
  };
  return { personas: [persona], vehiculo: null, producto: ctx.producto };
}

/** Estado interno del requisito → estado del contrato. */
export function estadoContrato(estado: string): EstadoContrato {
  if (estado === 'validado') return 'validado';
  if (estado === 'observado') return 'por_corregir';
  if (estado === 'recibido') return 'recibido';
  return 'pendiente';
}

/** Persona del requisito de Viajero según el número que manda el integrador. */
export function personaPorDocumento(
  i: IntegracionSnapshot,
  documento: unknown,
): PersonaIntegracion | null {
  const doc = documentoComparable(documento);
  if (!doc) return null;
  return i.personas.find((p) => p.documento === doc) ?? null;
}
