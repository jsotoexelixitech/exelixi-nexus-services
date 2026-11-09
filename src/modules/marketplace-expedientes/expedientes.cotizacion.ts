/**
 * v7 (9-nov): datos de la cotización del wizard (`cotizacion.cotizacion_json_data`) para el
 * contexto de la IA. Reglas puras, sin BD y de solo lectura.
 *
 * Enlace: la cotización del wizard guarda la póliza emitida en `policy.cnpoliza` / `policy.number`
 * (flow.service → syncSessionToDb). `emision.cotizacionId` no sirve: cuando la póliza llega por
 * POST /api/emisiones, Nexus crea otra cotización «huella» con el jsonData de la emisión (sin
 * vehículo ni personas). Solo se usa una cotización si es la ÚNICA del wizard con ese cnpoliza en
 * la empresa y su producto es el del expediente; si hay varias, no se usa ninguna.
 *
 * Lo que sale de aquí no entra en la huella de la póliza (como la mesa técnica en v4): solo amplía
 * contra qué se compara.
 */
import type { RolPersona } from './expedientes.ia';

/** Lo que aporta la cotización al contexto de la IA. */
export interface DatosCotizacion {
  /** Vehículo del wizard (solo RCV): placa, serial (carrocería), serialMotor, marca, modelo, anio. */
  vehiculo: Record<string, unknown> | null;
  /** Personas del wizard con su papel (tomador, asegurado, beneficiario, conductor). */
  personas: [unknown, RolPersona][];
  /** Lo que el OCR leyó al escanear (`documents[tipo].ocr`), con las claves de `ocrLeido`. */
  ocrLeido: Record<string, Record<string, unknown>> | null;
}

export type EnlaceCotizacion =
  | { estado: 'unica'; id: number; jsonData: Record<string, unknown> }
  | { estado: 'sin_cotizacion' }
  | { estado: 'ambigua'; cantidad: number }
  | { estado: 'otro_producto' };

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | null {
  if (v == null || (typeof v !== 'string' && typeof v !== 'number'))
    return null;
  const s = String(v).trim();
  return s && !/^(null|n\/a|na|none|undefined)$/i.test(s) ? s : null;
}

/** Estado completo del wizard (no la cotización «huella» que crea POST /api/emisiones). */
export function esCotizacionWizard(jd: unknown): boolean {
  const r = rec(jd);
  return r._flowMeta != null || Object.keys(rec(r.tomador)).length > 0;
}

/** Número de póliza que guardó el wizard al emitir. */
export function polizaDeCotizacion(jd: unknown): string | null {
  const p = rec(rec(jd).policy);
  return str(p.cnpoliza) ?? str(p.number);
}

/** Producto del wizard → producto del expediente (rcv | personas | patrimonial). */
function productoExpediente(product: unknown): string | null {
  const p = str(product)?.toLowerCase();
  if (!p) return null;
  if (p === 'rcv') return 'rcv';
  if (p.startsWith('patrimonial')) return 'patrimonial';
  return 'personas';
}

/**
 * La cotización de la póliza: única del wizard con ese cnpoliza (en la empresa, ya filtrada por la
 * consulta) y del mismo producto. Varias → ambigua (no se usa ninguna).
 */
export function elegirCotizacion(
  candidatas: { id: number; jsonData: unknown }[],
  exp: { cnpoliza: string; producto: string },
): EnlaceCotizacion {
  const cnpoliza = exp.cnpoliza.trim();
  const delWizard = candidatas.filter(
    (c) =>
      esCotizacionWizard(c.jsonData) &&
      polizaDeCotizacion(c.jsonData) === cnpoliza,
  );
  const ids = new Set(delWizard.map((c) => c.id));
  if (!ids.size) return { estado: 'sin_cotizacion' };
  if (ids.size > 1) return { estado: 'ambigua', cantidad: ids.size };
  const c = delWizard[0];
  const prod = productoExpediente(rec(c.jsonData).product);
  if (prod && prod !== exp.producto) return { estado: 'otro_producto' };
  return { estado: 'unica', id: c.id, jsonData: rec(c.jsonData) };
}

function lista(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function tieneDocumento(v: unknown): boolean {
  const r = rec(v);
  return !!(str(r.identificacion) ?? str(r.cedula) ?? str(r.documento));
}

/** Placa / serial: mayúsculas sin espacios, puntos ni guiones (como la emisión, contrato v1.3). */
function codigo(v: unknown): string | null {
  const s = str(v);
  return s ? s.replace(/[\s.-]/g, '').toUpperCase() || null : null;
}

function vehiculoDe(
  jd: Record<string, unknown>,
): Record<string, unknown> | null {
  const v = rec(jd.vehicle);
  const out: Record<string, unknown> = {
    placa: codigo(v.placa),
    serial: str(v.serial ?? v.serialCarroceria),
    serialMotor: str(v.serialMotor),
    marca: str(v.marca),
    modelo: str(v.modelo),
    anio: str(v['año'] ?? v.ano ?? v.anio),
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out.placa || out.serial ? out : null;
}

/** Mismo criterio que la emisión (expedienteFeed.resolveOcrLeido): solo claves de `ocrLeido`. */
function ocrLeidoDeDocumento(
  ocr: unknown,
  tipo: string,
): Record<string, unknown> | null {
  const o = rec(ocr);
  if (!Object.keys(o).length) return null;
  const pickOcr = (...keys: string[]) => {
    for (const k of keys) {
      const v = str(o[k]);
      if (v) return v;
    }
    return null;
  };
  let tipoDoc = pickOcr('tipoDoc')?.toUpperCase() ?? null;
  let raw =
    tipo === 'rif'
      ? pickOcr('rif', 'identificacion')
      : pickOcr('identificacion', 'rif');
  if (raw) {
    const m = /^\s*([VEJGPC])\s*[-.\s]?\s*(\d.*)$/i.exec(raw);
    if (m) {
      tipoDoc ??= m[1].toUpperCase();
      raw = m[2];
    }
  }
  if (tipoDoc && !/^[VEJGPC]$/.test(tipoDoc)) tipoDoc = null;
  const documento = raw
    ? tipoDoc === 'P'
      ? raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase() || null
      : raw.replace(/\D/g, '') || null
    : null;
  const anioRaw = pickOcr('año', 'ano', 'anio');
  const anio = anioRaw
    ? Number(anioRaw.replace(/\D/g, '').slice(0, 4))
    : Number.NaN;
  const campos: Record<string, unknown> = {
    tipoDoc: documento ? tipoDoc : null,
    documento,
    nombre: pickOcr('nombre', ...(tipo === 'rif' ? ['razonSocial'] : [])),
    apellido: pickOcr('apellido'),
    placa: codigo(pickOcr('placa')),
    serial: codigo(pickOcr('serial', 'serialCarroceria', 'vin')),
    serialMotor: codigo(pickOcr('serialMotor', 'numeroMotor')),
    marca: pickOcr('marca'),
    modelo: pickOcr('modelo', 'linea'),
    anio:
      Number.isFinite(anio) && anio >= 1900 && anio <= 2100
        ? String(anio)
        : null,
    vencimiento:
      tipo === 'licencia' ? pickOcr('vencimiento', 'fechaVencimiento') : null,
  };
  for (const k of Object.keys(campos)) if (campos[k] == null) delete campos[k];
  return Object.keys(campos).length ? campos : null;
}

function ocrLeidoDeDocuments(
  documents: unknown,
): Record<string, Record<string, unknown>> | null {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [tipo, d] of Object.entries(rec(documents))) {
    const leido = ocrLeidoDeDocumento(rec(d).ocr, tipo);
    if (leido) out[tipo] = leido;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Vehículo, personas y lectura del OCR de la cotización. Respeta las banderas del wizard: el
 * conductor solo con `hasDriver`, el beneficiario solo con `hasBeneficiary` y el asegurado aparte
 * solo con `sameInsured = false` (con `sameInsured = true` en RCV el tomador es el asegurado).
 */
export function datosDeCotizacion(
  jd: unknown,
  producto: string,
): DatosCotizacion {
  const r = rec(jd);
  const personas: [unknown, RolPersona][] = [];
  const add = (v: unknown, rol: RolPersona) => {
    if (tieneDocumento(v)) personas.push([v, rol]);
  };
  add(r.tomador, 'tomador');
  if (r.sameInsured === false) add(r.asegurado, 'asegurado');
  else if (r.sameInsured === true && producto === 'rcv')
    add(r.tomador, 'asegurado');
  add(r.titular, 'asegurado');
  for (const a of lista(r.asegurados)) add(a, 'asegurado');
  const funeral = rec(r.funeral);
  for (const a of lista(funeral.asegurados)) add(a, 'asegurado');
  if (r.hasBeneficiary === true) add(r.beneficiario, 'beneficiario');
  for (const b of lista(funeral.beneficiarios)) add(b, 'beneficiario');
  if (r.hasDriver === true) add(r.conductor, 'conductor');
  return {
    vehiculo: producto === 'rcv' ? vehiculoDe(r) : null,
    personas,
    ocrLeido: ocrLeidoDeDocuments(r.documents),
  };
}

/** Claves de quién emitió, en el orden en que se buscan (metadataCanal, metadata, raíz). */
const CAMPOS_ACTOR: [string, string[], number][] = [
  ['centidad', ['centidad'], 1],
  ['citem', ['citem'], 32],
  ['cgestor', ['cgestor', 'cgestor_in'], 50],
  ['ccanalalt', ['ccanalalt', 'ccanalalt_in'], 32],
  ['cusuario', ['cusuario'], 32],
  ['xlogin', ['xlogin', 'login'], 100],
  ['cproductor', ['cproductor'], 32],
];

/** Quién emitió según la cotización (metadata del SSO guardada por el wizard). */
export function actorDeCotizacion(jd: unknown): Record<string, string> {
  const r = rec(jd);
  const fuentes = [rec(r.metadataCanal), rec(r.metadata), r];
  const out: Record<string, string> = {};
  for (const [campo, keys, max] of CAMPOS_ACTOR) {
    let v: string | null = null;
    for (const k of keys) {
      for (const f of fuentes) {
        v = str(f[k]);
        if (v) break;
      }
      if (v) break;
    }
    if (v)
      out[campo] = (campo === 'centidad' ? v.toUpperCase() : v).slice(0, max);
  }
  // Como construirDatos: con centidad P, el ítem es el productor.
  if (!out.citem && out.centidad === 'P' && out.cproductor)
    out.citem = out.cproductor;
  return out;
}
