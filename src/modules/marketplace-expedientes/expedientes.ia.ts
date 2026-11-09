/**
 * Validación automática con IA (reglas puras, sin BD): compara lo que el OCR leyó del
 * documento contra los datos de la póliza y arma un diagnóstico campo por campo.
 *
 * Resultado → estado del requisito:
 * - coincide (confianza alta)          → validado (actor `ia`)
 * - no_coincide | ilegible              → observado con el resumen como motivo
 * - sin_certeza                         → observado con «Revisar: …»
 * - datos_modificados (v3)              → observado: el dato se cambió a mano en el formulario
 *                                         respecto a lo que el OCR leyó del documento al emitir
 * - error_tecnico                       → sigue recibido; se reintenta con espera creciente
 */
import { createHash } from 'crypto';
import { caracasParts, requisitoLabel } from './expedientes.domain';

export const RESULTADOS_IA = [
  'coincide',
  'no_coincide',
  'ilegible',
  'sin_certeza',
  'error_tecnico',
  'datos_modificados',
] as const;
export type ResultadoIa = (typeof RESULTADOS_IA)[number];

export type MotivoAnalisis =
  | 'nuevo'
  | 'reintento'
  | 'cambio_poliza'
  | 'cambio_archivo'
  | 'cambio_comparador'
  | 'carga';

/**
 * Versión de las reglas de comparación. Al subirla, los diagnósticos guardados con una versión
 * anterior se vuelven a COMPARAR con lo ya extraído (sin llamar otra vez al OCR).
 * v2 (7-nov): comparación por rol del documento y posible error de lectura de un dígito.
 * v3 (7-nov): datos cambiados en el formulario (`ocrLeido` de la emisión vs documento vs póliza).
 * v4 (9-nov): personas — la cédula se compara contra todas las personas naturales de la póliza
 *   (titular, tomador V/E/P y asegurados, también los de la mesa técnica); con tomador J vale su RIF.
 */
export const VERSION_COMPARADOR = 4;

/**
 * La v4 solo cambia contra quién se compara la cédula en personas: lo ya validado por la IA con la
 * v3 no se vuelve a comparar (lo validado no se toca).
 */
const VERSION_COMPARADOR_VALIDADOS = 3;

/** Persona de la póliza según su papel. */
export type RolPersona = 'tomador' | 'asegurado' | 'beneficiario' | 'conductor';

/** Estado de cada dato comparado (además de `coincide`). */
export type EstadoCampo =
  | 'coincide'
  | 'no_coincide'
  | 'sin_dato_poliza'
  | 'sin_dato_documento'
  | 'parecido'
  | 'no_aplica'
  /** v3: la póliza no dice lo que el OCR leyó del documento al emitir (se cambió a mano). */
  | 'modificado_en_formulario';

export interface CampoDiagnostico {
  campo: string;
  etiqueta: string;
  enPoliza: string | null;
  enDocumento: string | null;
  /** null = no se pudo comparar (sin dato en la póliza o en el documento). */
  coincide: boolean | null;
  estado: EstadoCampo;
  /** v3: lo que el OCR leyó de este dato al emitir (documentos enmascarados). */
  enOcrAlEmitir?: string | null;
}

export interface Diagnostico {
  version: 1;
  tipo: string;
  analizadoEn: string;
  proveedor: string | null;
  /** 0 a 1 (el OCR responde 0, 0.5 o 1). */
  confianza: number | null;
  resultado: ResultadoIa;
  campos: CampoDiagnostico[];
  resumen: string;
  /** Versión de las reglas de comparación (ausente = 1). */
  comparador?: number;
  /** Persona de la póliza contra la que se comparó (puede ser la siguiente disponible). */
  comparadoCon?: RolPersona | 'vehiculo' | null;
  /** Persona a la que debe pertenecer el documento según su tipo. */
  rolEsperado?: RolPersona | null;
  motivoAnalisis?: MotivoAnalisis;
  /** Solo error_tecnico: número de intento y cuándo se reintenta. */
  intento?: number;
  proximoIntento?: string | null;
}

export interface LecturaOcr {
  extraido?: unknown;
  confianza?: number | null;
  motivo?: string | null;
  proveedor?: string | null;
  /** 'tecnica' = sin lectura real; 'tipo_documento' = no es el documento pedido. */
  falla?: string | null;
}

export interface PersonaPoliza {
  /** Papel principal (el primero con que aparece). */
  rol: RolPersona;
  /** Todos sus papeles en la póliza (el tomador puede ser también el asegurado). */
  roles: RolPersona[];
  tipoDoc: string | null;
  documento: string | null;
  nombre: string | null;
  apellido: string | null;
}

export interface ContextoPoliza {
  personas: PersonaPoliza[];
  vehiculo: Record<string, unknown> | null;
  /**
   * v3: lo que el OCR leyó de cada documento al emitir (`expediente.documentos[tipo].ocrLeido`
   * de Emisión), por requisito. Ausente en emisiones viejas.
   */
  ocrLeido?: Record<string, Record<string, unknown>>;
  /** Producto del expediente (rcv | personas | patrimonial). */
  producto?: string;
  /**
   * v4: personas de la póliza que no están en el snapshot del expediente (`funeral.asegurados` y
   * la solicitud de la mesa técnica). Fuera de la huella: no reabren lo ya decidido; solo amplían
   * contra quién se compara la cédula en personas.
   */
  adicionales?: PersonaPoliza[];
}

/** Confianza mínima para validar sin intervención humana. */
export const CONFIANZA_ALTA = 0.9;

// ─── Normalización ─────────────────────────────────────────────────────────

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function texto(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s ? s : null;
}

function pick(obj: unknown, keys: string[]): string | null {
  const r = rec(obj);
  for (const k of keys) {
    const v = texto(r[k]);
    if (v) return v;
  }
  return null;
}

export function normTexto(v?: string | null): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PARTICULAS = new Set([
  'DE',
  'DEL',
  'LA',
  'LAS',
  'LOS',
  'Y',
  'DA',
  'DOS',
  'DI',
  'VAN',
  'VON',
]);

function tokens(v?: string | null): string[] {
  return normTexto(v)
    .split(' ')
    .filter((t) => t.length > 1 && !PARTICULAS.has(t));
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Igualdad de palabra con tolerancia a una letra mal leída en palabras largas. */
function palabraIgual(a: string, b: string): boolean {
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 5 && levenshtein(a, b) <= 1;
}

/** El conjunto más corto está contenido en el más largo (orden y nombres compuestos). */
function contenido(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const [menor, mayor] = a.length <= b.length ? [a, b] : [b, a];
  return menor.every((t) => mayor.some((u) => palabraIgual(t, u)));
}

/** Comparte al menos una palabra significativa (marca y modelo: el catálogo varía). */
function comparte(a: string[], b: string[]): boolean {
  return a.some((t) => t.length >= 3 && b.some((u) => palabraIgual(t, u)));
}

/** Número de documento comparable: sin prefijo V/E/J/G/P/C, sin separadores ni ceros a la izquierda. */
export function numeroDocumento(v?: string | null): string {
  let s = String(v ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (/^[VEJGPC]\d+$/.test(s)) s = s.slice(1);
  return s.replace(/^0+(?=.)/, '');
}

function tipoDocDe(v?: string | null): string | null {
  const s = String(v ?? '')
    .trim()
    .toUpperCase();
  const m = s.match(/^([VEJGPC])\b|^([VEJGPC])[-\s]?\d/);
  if (m) return (m[1] ?? m[2]) || null;
  return /^[VEJGPC]$/.test(s) ? s : null;
}

function documentosIguales(a: string, b: string, conDigitoRif: boolean) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (!conDigitoRif) return false;
  // RIF: el dígito verificador final no está en la cédula (V-12345678 ↔ V-12345678-9).
  return (
    (a.length === b.length + 1 && a.startsWith(b)) ||
    (b.length === a.length + 1 && b.startsWith(a))
  );
}

/** Placa y seriales: mayúsculas sin separadores; O/Q→0 e I→1 (confusiones típicas del OCR). */
function normSerial(v?: string | null): string {
  return String(v ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[OQ]/g, '0')
    .replace(/I/g, '1');
}

/** Números de documento en textos: solo los últimos 4 (V-****5678). */
export function maskDocumento(
  tipoDoc?: string | null,
  documento?: string | null,
): string | null {
  const n = numeroDocumento(documento);
  if (!n) return null;
  const tipo = tipoDoc ? `${String(tipoDoc).toUpperCase()}-` : '';
  return n.length <= 4 ? `${tipo}****` : `${tipo}****${n.slice(-4)}`;
}

// ─── Contexto de la póliza ────────────────────────────────────────────────

function personaDe(v: unknown, rol: RolPersona): PersonaPoliza | null {
  const r = rec(v);
  if (!Object.keys(r).length) return null;
  const ident = pick(r, ['identificacion', 'cedula', 'rif']);
  const documento = pick(r, ['documento']) ?? ident;
  const tipoDoc =
    pick(r, ['tipoDoc', 'tipo_doc'])?.toUpperCase().slice(0, 1) ??
    tipoDocDe(ident);
  const p: PersonaPoliza = {
    rol,
    roles: [rol],
    tipoDoc: tipoDoc ?? null,
    documento: documento ? numeroDocumento(documento) || null : null,
    nombre: pick(r, ['nombre', 'nombres', 'razonSocial']),
    apellido: pick(r, ['apellido', 'apellidos']),
  };
  return p.documento || p.nombre || p.apellido ? p : null;
}

function lista(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v ? [v] : [];
}

/**
 * Personas de la póliza con sus papeles: tomador, asegurado (titular), beneficiario y conductor
 * habitual. La misma cédula en varios papeles es una sola persona con varios roles.
 */
export function contextoPoliza(
  exp: {
    producto: string;
    snapshot?: unknown;
    aseguradoTipoDoc?: string | null;
    aseguradoDocumento?: string | null;
    aseguradoNombre?: string | null;
    aseguradoApellido?: string | null;
  },
  /**
   * v4: otras fuentes con las personas de la póliza (snapshot de la mesa técnica, jsonData de la
   * emisión). Solo se usan para la cédula en personas y no entran en la huella.
   */
  otrasFuentes: unknown[] = [],
): ContextoPoliza {
  const snap = rec(exp.snapshot);
  const guardado = personaDe(
    {
      tipoDoc: exp.aseguradoTipoDoc,
      documento: exp.aseguradoDocumento,
      nombre: exp.aseguradoNombre,
      apellido: exp.aseguradoApellido,
    },
    'asegurado',
  );
  const fuentes: [unknown, RolPersona][] = [
    [snap.tomador, 'tomador'],
    [snap.asegurado, 'asegurado'],
    [snap.titular, 'asegurado'],
    ...lista(snap.asegurados).map((a): [unknown, RolPersona] => [
      a,
      'asegurado',
    ]),
    ...lista(snap.beneficiario).map((b): [unknown, RolPersona] => [
      b,
      'beneficiario',
    ]),
    ...lista(snap.beneficiarios).map((b): [unknown, RolPersona] => [
      b,
      'beneficiario',
    ]),
    ...[snap.conductor, snap.conductorHabitual, snap.conductor_habitual].map(
      (c): [unknown, RolPersona] => [c, 'conductor'],
    ),
  ];
  const orden = fuentes.map(([v, rol]) => personaDe(v, rol));
  // El asegurado guardado va después del tomador y el asegurado del snapshot (completa lo que falte).
  orden.splice(2, 0, guardado);
  const personas: PersonaPoliza[] = [];
  for (const p of orden) {
    if (!p) continue;
    const igual = personas.find(
      (x) =>
        (p.documento && x.documento === p.documento) ||
        (!p.documento &&
          !x.documento &&
          normTexto(`${x.nombre} ${x.apellido}`) ===
            normTexto(`${p.nombre} ${p.apellido}`)),
    );
    if (igual) {
      igual.tipoDoc ??= p.tipoDoc;
      igual.nombre ??= p.nombre;
      igual.apellido ??= p.apellido;
      if (!igual.roles.includes(p.rol)) igual.roles.push(p.rol);
      continue;
    }
    personas.push({ ...p, roles: [...p.roles] });
  }
  const veh = rec(snap.vehiculo);
  const ocrLeido = ocrLeidoDe(snap.ocrLeido);
  const adicionales = personasAdicionales(snap, otrasFuentes, personas);
  return {
    personas,
    vehiculo: Object.keys(veh).length ? veh : null,
    ...(ocrLeido ? { ocrLeido } : {}),
    producto: exp.producto,
    ...(adicionales.length ? { adicionales } : {}),
  };
}

/**
 * v4: personas de `funeral.asegurados` / `funeral.beneficiarios` del snapshot y de las otras fuentes
 * (mesa técnica, jsonData: tomador, asegurado/titular, asegurados, beneficiarios y los de `funeral`)
 * que no estén ya en la póliza. Los menores sin cédula (cédula del titular + correlativo) no cuentan.
 */
function personasAdicionales(
  snap: Record<string, unknown>,
  otrasFuentes: unknown[],
  yaEstan: PersonaPoliza[],
): PersonaPoliza[] {
  const fuentes: [unknown, RolPersona][] = [];
  const deFuneral = (f: Record<string, unknown>) => {
    for (const a of lista(f.asegurados)) fuentes.push([a, 'asegurado']);
    for (const b of lista(f.beneficiarios)) fuentes.push([b, 'beneficiario']);
  };
  deFuneral(rec(snap.funeral));
  for (const fuente of otrasFuentes) {
    for (const m of [rec(fuente), rec(rec(fuente).data)]) {
      fuentes.push(
        [m.tomador, 'tomador'],
        [m.asegurado, 'asegurado'],
        [m.titular, 'asegurado'],
      );
      deFuneral(m);
      deFuneral(rec(m.funeral));
    }
  }
  const out: PersonaPoliza[] = [];
  for (const [v, rol] of fuentes) {
    if (rec(v).sinCedula === true) continue;
    const p = personaDe(v, rol);
    if (!p?.documento) continue;
    const igual = [...yaEstan, ...out].find((x) => x.documento === p.documento);
    if (igual) {
      // Solo se completan los papeles de las adicionales (las del snapshot van en la huella).
      if (out.includes(igual) && !igual.roles.includes(rol))
        igual.roles.push(rol);
      continue;
    }
    out.push(p);
  }
  return out;
}

/** Todas las personas de la póliza: las del snapshot y las adicionales (v4). */
function todasLasPersonas(ctx: ContextoPoliza): PersonaPoliza[] {
  return [...ctx.personas, ...(ctx.adicionales ?? [])];
}

/** Tipo de documento de persona jurídica (empresa u organismo). */
function esJuridico(tipoDoc?: string | null): boolean {
  return ['J', 'G', 'C'].includes(String(tipoDoc ?? '').toUpperCase());
}

/** Tomador persona jurídica (J/G/C) de la póliza, si lo hay. */
export function tomadorJuridico(ctx: ContextoPoliza): PersonaPoliza | null {
  return (
    todasLasPersonas(ctx).find(
      (p) => p.roles.includes('tomador') && esJuridico(p.tipoDoc),
    ) ?? null
  );
}

/** v4: en personas, la cédula de la póliza puede ser de cualquiera de sus personas naturales. */
function cedulaDePersonas(tipo: string, ctx: ContextoPoliza): boolean {
  return tipo === 'cedula' && ctx.producto === 'personas';
}

/** Claves de `ocrLeido` (contrato v1.3). */
export const CLAVES_OCR_LEIDO = [
  'tipoDoc',
  'documento',
  'nombre',
  'apellido',
  'placa',
  'serial',
  'serialMotor',
  'marca',
  'modelo',
  'anio',
  'vencimiento',
] as const;

/** `ocrLeido` por requisito: solo claves conocidas con valor; null si no queda nada. */
export function ocrLeidoDe(
  v: unknown,
): Record<string, Record<string, unknown>> | null {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [tipo, campos] of Object.entries(rec(v))) {
    const r = rec(campos);
    const limpio: Record<string, unknown> = {};
    for (const k of CLAVES_OCR_LEIDO) {
      const t = texto(r[k]);
      if (t) limpio[k] = t;
    }
    if (Object.keys(limpio).length) out[tipo] = limpio;
  }
  return Object.keys(out).length ? out : null;
}

function estable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(estable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, estable((v as Record<string, unknown>)[k])]),
    );
  }
  return v ?? null;
}

/** Huella de los datos de la póliza que usa la comparación: si cambia, se vuelve a comparar. */
export function huellaPoliza(ctx: ContextoPoliza): string {
  const v = ctx.vehiculo ?? {};
  const vehiculo = Object.fromEntries(
    [
      'placa',
      'serial',
      'serialCarroceria',
      'serialMotor',
      'marca',
      'modelo',
      'anio',
      'propietario',
      'identificacionPropietario',
    ].map((k) => [k, texto(v[k])]),
  );
  // v3: lo leído al emitir también cuenta (si llega después, se vuelve a comparar). Sin él, la
  // huella es la misma de antes (no reanaliza emisiones viejas por esto).
  const ocrLeido =
    ctx.ocrLeido && Object.keys(ctx.ocrLeido).length ? ctx.ocrLeido : null;
  return createHash('sha256')
    .update(
      JSON.stringify(
        estable({
          personas: ctx.personas,
          vehiculo,
          ...(ocrLeido ? { ocrLeido } : {}),
        }),
      ),
    )
    .digest('hex');
}

// ─── Comparación ──────────────────────────────────────────────────────────

const ETIQUETA_DOC: Record<string, string> = {
  cedula: 'Número de cédula',
  cedula_titular: 'Número de cédula',
  cedula_beneficiario: 'Número de cédula',
  rif: 'Número de RIF',
  pasaporte: 'Número de pasaporte',
  licencia: 'Cédula del titular',
};

/** Frase de diferencia por campo (números de documento ya enmascarados). */
function fraseDiferencia(
  tipo: string,
  c: CampoDiagnostico,
  rol: string,
): string {
  const doc = c.enDocumento ?? 'sin dato';
  const pol = c.enPoliza ?? 'sin dato';
  const de = `del ${rol}`;
  switch (c.campo) {
    case 'documento':
      if (tipo === 'rif')
        return `El RIF del documento (${doc}) no coincide con el ${de} (${pol}).`;
      if (tipo === 'pasaporte')
        return `El número de pasaporte (${doc}) no coincide con el ${de} (${pol}).`;
      if (tipo === 'licencia')
        return `La cédula del titular de la licencia (${doc}) no coincide con la ${de} (${pol}).`;
      return `La cédula del documento (${doc}) no coincide con la ${de} (${pol}).`;
    case 'tipoDoc':
      return `El tipo de documento (${doc}) no coincide con el ${de} (${pol}).`;
    case 'nombre':
      return `El nombre del documento (${doc}) no coincide con el ${de} (${pol}).`;
    case 'apellido':
      return `El apellido del documento (${doc}) no coincide con el ${de} (${pol}).`;
    case 'vencimiento':
      return `La licencia está vencida desde el ${doc}.`;
    case 'placa':
      return `La placa del certificado (${doc}) no coincide con la del vehículo asegurado (${pol}).`;
    case 'serialCarroceria':
      return `El serial de carrocería del certificado (${doc}) no coincide con el de la póliza (${pol}).`;
    case 'serialMotor':
      return `El serial de motor del certificado (${doc}) no coincide con el de la póliza (${pol}).`;
    case 'marca':
      return `La marca del certificado (${doc}) no coincide con la de la póliza (${pol}).`;
    case 'modelo':
      return `El modelo del certificado (${doc}) no coincide con el de la póliza (${pol}).`;
    case 'anio':
      return `El año del certificado (${doc}) no coincide con el de la póliza (${pol}).`;
    case 'propietario':
      return `El propietario del certificado (${doc}) no coincide con el de la póliza (${pol}).`;
    default:
      return `${c.etiqueta}: el documento (${doc}) no coincide con la póliza (${pol}).`;
  }
}

function campo(
  c: string,
  etiqueta: string,
  enPoliza: string | null,
  enDocumento: string | null,
  igual: (() => boolean | 'parecido' | null) | null,
): CampoDiagnostico {
  if (!enPoliza)
    return {
      campo: c,
      etiqueta,
      enPoliza: null,
      enDocumento,
      coincide: null,
      estado: 'sin_dato_poliza',
    };
  if (!enDocumento)
    return {
      campo: c,
      etiqueta,
      enPoliza,
      enDocumento: null,
      coincide: null,
      estado: 'sin_dato_documento',
    };
  const r = igual ? igual() : null;
  if (r === 'parecido')
    return {
      campo: c,
      etiqueta,
      enPoliza,
      enDocumento,
      coincide: null,
      estado: 'parecido',
    };
  if (r === null)
    return {
      campo: c,
      etiqueta,
      enPoliza,
      enDocumento,
      coincide: null,
      estado: 'no_aplica',
    };
  return {
    campo: c,
    etiqueta,
    enPoliza,
    enDocumento,
    coincide: r,
    estado: r ? 'coincide' : 'no_coincide',
  };
}

function fechaIso(v?: string | null): string | null {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})[/.-](\d{2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

const TIPOS_PERSONA = new Set([
  'cedula',
  'cedula_titular',
  'cedula_beneficiario',
  'licencia',
  'rif',
  'pasaporte',
]);

/**
 * A quién pertenece cada documento (como lo usa la emisión: `cedula` = tomador, `cedula_titular`
 * = titular) y con quién se compara si la póliza no trae a esa persona. RCV no fija de quién es la
 * licencia (conductor habitual, tomador o titular): vale cualquiera de ellos.
 */
const ROLES_DOCUMENTO: Record<
  string,
  { esperados: RolPersona[]; respaldo: RolPersona[] }
> = {
  cedula: { esperados: ['tomador'], respaldo: ['asegurado'] },
  rif: { esperados: ['tomador'], respaldo: ['asegurado'] },
  pasaporte: { esperados: ['tomador'], respaldo: ['asegurado'] },
  cedula_titular: { esperados: ['asegurado'], respaldo: ['tomador'] },
  cedula_beneficiario: {
    esperados: ['beneficiario'],
    respaldo: ['asegurado', 'tomador'],
  },
  licencia: { esperados: ['conductor', 'tomador', 'asegurado'], respaldo: [] },
};

function textoRoles(roles: RolPersona[]): string {
  if (roles.length <= 1) return roles[0] ?? 'titular';
  return `${roles.slice(0, -1).join(', ')} ni ${roles[roles.length - 1]}`;
}

/** Rótulos que a veces devuelve el OCR en lugar del dato (lectura fallida, no otra persona). */
const ROTULOS_OCR = new Set([
  'NOMBRE',
  'NOMBRES',
  'APELLIDO',
  'APELLIDOS',
  'NOMBRE APELLIDO',
  'NOMBRES APELLIDOS',
  'NULL',
  'UNDEFINED',
  'N A',
]);

/** Un solo dígito distinto (lectura dudosa del OCR) en un número de 6 o más dígitos. */
function casiIgual(a: string, b: string): boolean {
  return (
    Math.min(a.length, b.length) >= 6 && a !== b && levenshtein(a, b) === 1
  );
}

interface ComparacionPersona {
  campos: CampoDiagnostico[];
  rol: RolPersona | null;
  rolEsperado: RolPersona | null;
  /** Diferencia que no basta para decir «no coincide»: el resultado es sin_certeza. */
  aviso: string | null;
  /** Aclaración para el resumen (p. ej. se comparó con la persona de respaldo). */
  nota: string | null;
  /** v3: valores sin enmascarar por campo (póliza y documento) para detectar datos cambiados. */
  crudos: Crudos;
  conDv: boolean;
  /** Se comparó con la persona de respaldo (la esperada no está en la póliza). */
  respaldo: boolean;
}

/** Valores sin enmascarar de cada campo comparado: póliza y lo que lee ahora el documento. */
type Crudos = Record<string, { pol: string | null; doc: string | null }>;

function compararPersona(
  tipo: string,
  ex: Record<string, unknown>,
  ctx: ContextoPoliza,
  hoy: string,
): ComparacionPersona {
  const rifOcr = pick(ex, ['rif']);
  const docRaw =
    pick(ex, [
      'identificacion',
      'documento',
      'cedula',
      'numeroDocumento',
      'numeroPasaporte',
    ]) ?? rifOcr;
  const docOcr = docRaw
    ? tipo === 'pasaporte'
      ? normSerial(docRaw).replace(/^0+(?=.)/, '')
      : numeroDocumento(docRaw)
    : '';
  const tipoOcr =
    pick(ex, ['tipoDoc'])?.toUpperCase().slice(0, 1) ??
    tipoDocDe(rifOcr ?? docRaw);
  const conDv =
    tipo === 'rif' ||
    !!rifOcr ||
    ['J', 'G', 'C'].includes(String(tipoOcr ?? ''));
  const docDe = (p: PersonaPoliza) =>
    tipo === 'pasaporte' ? normSerial(p.documento ?? '') : (p.documento ?? '');

  // Personas a las que debe pertenecer el documento; si la póliza no las trae, la de respaldo.
  const todas = todasLasPersonas(ctx);
  const enPersonas = cedulaDePersonas(tipo, ctx);
  const reglas = enPersonas
    ? { esperados: ['tomador', 'asegurado'] as RolPersona[], respaldo: [] }
    : (ROLES_DOCUMENTO[tipo] ?? ROLES_DOCUMENTO.cedula);
  const conRol = (roles: RolPersona[]) => {
    const out: PersonaPoliza[] = [];
    for (const r of roles)
      for (const p of ctx.personas)
        if (p.documento && p.roles.includes(r) && !out.includes(p)) out.push(p);
    return out;
  };
  let objetivos: PersonaPoliza[];
  let respaldo: RolPersona | null = null;
  /** v4 personas: aviso cuando no hay contra quién comparar (sin_certeza, nunca no_coincide). */
  let sinComparar: string | null = null;
  if (enPersonas) {
    // Cédula en personas: vale la de cualquier persona natural de la póliza (titular, tomador
    // V/E/P o asegurado). Con tomador J, el documento de identidad del tomador es su RIF.
    const tomJ = tomadorJuridico(ctx);
    const naturales = todas.filter(
      // El asegurado guardado en el expediente puede ser el mismo tomador J (sin titular): las
      // personas jurídicas nunca cuentan como naturales.
      (p) =>
        !!p.documento &&
        !esJuridico(p.tipoDoc) &&
        (p.roles.includes('asegurado') || p.roles.includes('tomador')),
    );
    if (tomJ && esJuridico(tipoOcr)) objetivos = [tomJ];
    else objetivos = naturales;
    if (!objetivos.length) {
      sinComparar = tomJ
        ? 'El tomador es una persona jurídica y la póliza no trae la cédula del titular ni de los asegurados para comparar.'
        : null;
    }
  } else {
    objetivos = conRol(reglas.esperados);
    if (!objetivos.length) {
      for (const r of reglas.respaldo) {
        const o = conRol([r]);
        if (o.length) {
          objetivos = o;
          respaldo = r;
          break;
        }
      }
    }
  }
  const rolesValidos = respaldo ? [respaldo] : reglas.esperados;
  const rolDe = (p: PersonaPoliza) =>
    rolesValidos.find((r) => p.roles.includes(r)) ?? p.rol;

  const igualA = (p: PersonaPoliza) =>
    !!p.documento && documentosIguales(docDe(p), docOcr, conDv);
  const exacto = docOcr
    ? enPersonas
      ? (objetivos.find(igualA) ?? todas.find(igualA) ?? null)
      : (ctx.personas.find(igualA) ?? null)
    : null;
  const persona =
    exacto && objetivos.includes(exacto)
      ? exacto
      : enPersonas
        ? // Sin coincidencia exacta: la que difiere en un dígito (posible error de lectura) o la
          // primera; sin personas naturales no se compara contra el tomador J.
          (objetivos.find((p) => casiIgual(docOcr, docDe(p))) ??
          objetivos[0] ??
          null)
        : (objetivos[0] ??
          ctx.personas.find((p) => p.documento) ??
          ctx.personas[0] ??
          null);
  const rol = persona ? rolDe(persona) : null;

  const campos: CampoDiagnostico[] = [];
  const etiquetaDoc = ETIQUETA_DOC[tipo] ?? 'Número de documento';

  // Tipo de documento (V/E/J/G): solo cédula y RIF; pasaporte (P) no se compara con V/E.
  if (tipo !== 'licencia' && tipo !== 'pasaporte') {
    const tp = persona?.tipoDoc ?? null;
    campos.push(
      campo('tipoDoc', 'Tipo de documento', tp, tipoOcr ?? null, () => {
        if (tp === 'P' || tipoOcr === 'P') return null;
        return tp === tipoOcr;
      }),
    );
  }

  const docPol = persona?.documento ?? null;
  const docCampo = campo(
    'documento',
    etiquetaDoc,
    docPol ? maskDocumento(persona?.tipoDoc, docPol) : null,
    docOcr ? maskDocumento(tipoOcr, docOcr) : null,
    () => (persona ? documentosIguales(docDe(persona), docOcr, conDv) : false),
  );
  campos.push(docCampo);

  const nOcr = tokens(pick(ex, ['nombre', 'nombres', 'razonSocial']));
  const aOcr = tokens(pick(ex, ['apellido', 'apellidos']));
  const nPol = tokens(persona?.nombre);
  const aPol = tokens(persona?.apellido);
  const todosOcr = [...nOcr, ...aOcr];
  const todosPol = [...nPol, ...aPol];
  const comunes = todosOcr.filter((t) =>
    todosPol.some((u) => palabraIgual(t, u)),
  ).length;
  const completo =
    contenido(todosOcr, todosPol) &&
    comunes >= Math.min(2, todosOcr.length, todosPol.length);
  const original = (k: string[]) => pick(ex, k);
  campos.push(
    campo(
      'nombre',
      'Nombre',
      persona?.nombre ?? null,
      original(['nombre', 'nombres', 'razonSocial']),
      () => contenido(nOcr, nPol) || completo,
    ),
  );
  if (aOcr.length || aPol.length) {
    campos.push(
      campo(
        'apellido',
        'Apellido',
        persona?.apellido ?? null,
        original(['apellido', 'apellidos']),
        () => contenido(aOcr, aPol) || completo,
      ),
    );
  }

  if (tipo === 'licencia') {
    const vence = fechaIso(pick(ex, ['vencimiento', 'fechaVencimiento']));
    if (vence) {
      campos.push({
        campo: 'vencimiento',
        etiqueta: 'Vigencia de la licencia',
        enPoliza: `Vigente al ${hoy}`,
        enDocumento: vence,
        coincide: vence >= hoy,
        estado: vence >= hoy ? 'coincide' : 'no_coincide',
      });
    }
  }

  const rolEsperado = reglas.esperados[0] ?? null;
  const esperadoTexto = textoRoles(reglas.esperados);
  const nombres = campos.filter(
    (c) => c.campo === 'nombre' || c.campo === 'apellido',
  );
  const nombreOk =
    nombres.some((c) => c.coincide === true) &&
    nombres.every((c) => c.coincide !== false);
  let aviso: string | null = null;
  let nota: string | null = null;
  const sinTomador =
    enPersonas && !todas.some((p) => p.roles.includes('tomador'));
  // El OCR devolvió el rótulo del campo («nombre») en vez del dato: lectura fallida.
  const rotulo = [
    original(['nombre', 'nombres', 'razonSocial']),
    original(['apellido', 'apellidos']),
  ].some((v) => !!v && ROTULOS_OCR.has(normTexto(v)));
  if (sinComparar) {
    aviso = sinComparar;
  } else if (rotulo) {
    aviso =
      'El OCR no leyó el nombre del documento (devolvió el rótulo del campo); hay que revisarlo.';
  } else if (exacto && !objetivos.includes(exacto)) {
    // Es de otra persona de la póliza: no es un documento falso, pero tampoco el pedido.
    aviso = enPersonas
      ? `El documento corresponde al ${exacto.rol}, no al titular, al tomador ni a un asegurado.`
      : `El documento corresponde al ${exacto.rol}, no al ${esperadoTexto}.`;
  } else if (
    !exacto &&
    docCampo.coincide === false &&
    persona &&
    casiIgual(docOcr, docDe(persona)) &&
    nombreOk
  ) {
    docCampo.coincide = null;
    docCampo.estado = 'parecido';
    aviso =
      `Posible error de lectura: el número del documento (${docCampo.enDocumento}) ` +
      `difiere en un dígito del ${rol ?? 'titular'} (${docCampo.enPoliza}) y el nombre coincide.`;
  } else if (respaldo) {
    const sinRol = `La póliza no trae la cédula del ${esperadoTexto}; se comparó con la del ${respaldo}.`;
    if (docCampo.coincide === false) aviso = sinRol;
    else nota = sinRol;
  } else if (sinTomador && !exacto && docCampo.coincide === false && rol) {
    // Personas sin datos del tomador: la cédula puede ser la suya; no se afirma que no coincide.
    aviso = `La póliza no trae la cédula del tomador; se comparó con la del ${rol}.`;
  } else if (
    enPersonas &&
    tomadorJuridico(ctx) &&
    !esJuridico(tipoOcr) &&
    !exacto &&
    docCampo.coincide === false
  ) {
    // Tomador empresa: la cédula o pasaporte puede ser del representante legal, que la póliza
    // no trae. No coincide con nadie de la póliza, pero tampoco se afirma que sea ajena: revisar.
    aviso =
      'El tomador es una persona jurídica y el documento no coincide con el titular ni con los asegurados (puede ser del representante legal).';
  }
  const crudos: Crudos = {
    tipoDoc: { pol: persona?.tipoDoc ?? null, doc: tipoOcr ?? null },
    documento: {
      pol: persona ? docDe(persona) || null : null,
      doc: docOcr || null,
    },
    nombre: {
      pol: persona?.nombre ?? null,
      doc: original(['nombre', 'nombres', 'razonSocial']),
    },
    apellido: {
      pol: persona?.apellido ?? null,
      doc: original(['apellido', 'apellidos']),
    },
  };
  return {
    campos,
    rol,
    rolEsperado,
    aviso,
    nota,
    crudos,
    conDv,
    respaldo: !!respaldo,
  };
}

function compararVehiculo(
  ex: Record<string, unknown>,
  ctx: ContextoPoliza,
): { campos: CampoDiagnostico[]; crudos: Crudos } {
  const v = ctx.vehiculo ?? {};
  const serialIgual =
    (a: string, b: string, largoMin: number) => (): boolean | 'parecido' => {
      const x = normSerial(a);
      const y = normSerial(b);
      if (x === y) return true;
      // Un carácter distinto en un serial largo suele ser lectura del OCR: revisar, no errar.
      if (Math.min(x.length, y.length) >= largoMin && levenshtein(x, y) === 1)
        return 'parecido';
      return false;
    };

  const placaPol = pick(v, ['placa', 'xplaca']);
  const placaDoc = pick(ex, ['placa', 'xplaca']);
  const carrPol = pick(v, [
    'serialCarroceria',
    'serial_carroceria',
    'xserialcarroceria',
    'serial',
    'serialNiv',
  ]);
  const carrDoc = pick(ex, [
    'serialCarroceria',
    'serial_carroceria',
    'serial',
    'serialNiv',
  ]);
  const motorPol = pick(v, ['serialMotor', 'serial_motor', 'xserialmotor']);
  const motorDoc = pick(ex, ['serialMotor', 'serial_motor']);
  const marcaPol = pick(v, ['marca', 'xmarca']);
  const marcaDoc = pick(ex, ['marca']);
  const modeloPol = pick(v, ['modelo', 'xmodelo']);
  const modeloDoc =
    [pick(ex, ['modelo']), pick(ex, ['linea'])].filter(Boolean).join(' ') ||
    null;
  const anioPol = pick(v, ['anio', 'año', 'ano', 'fano']);
  const anioDoc = pick(ex, ['anio', 'año', 'ano']);

  const campos = [
    campo('placa', 'Placa', placaPol, placaDoc, () =>
      placaPol && placaDoc
        ? normSerial(placaPol) === normSerial(placaDoc)
        : false,
    ),
    campo(
      'serialCarroceria',
      'Serial de carrocería',
      carrPol,
      carrDoc,
      serialIgual(carrPol ?? '', carrDoc ?? '', 10),
    ),
    campo(
      'serialMotor',
      'Serial de motor',
      motorPol,
      motorDoc,
      serialIgual(motorPol ?? '', motorDoc ?? '', 8),
    ),
    campo('marca', 'Marca', marcaPol, marcaDoc, () =>
      comparte(tokens(marcaPol), tokens(marcaDoc)),
    ),
    campo('modelo', 'Modelo', modeloPol, modeloDoc, () =>
      comparte(tokens(modeloPol), tokens(modeloDoc)),
    ),
    campo('anio', 'Año', anioPol, anioDoc, () => {
      const a = Number(String(anioPol).replace(/\D/g, ''));
      const b = Number(String(anioDoc).replace(/\D/g, ''));
      return Number.isFinite(a) && a > 0 && a === b;
    }),
  ];

  // Propietario: se compara si la póliza trae el del vehículo; si no, queda sin dato.
  const propDocOcr = pick(ex, ['identificacionPropietario']);
  const tipoPropOcr = pick(ex, ['tipoDocPropietario']);
  const propPol = pick(v, [
    'identificacionPropietario',
    'propietarioDocumento',
  ]);
  if (propDocOcr || propPol) {
    const tipoPropPol = pick(v, ['tipoDocPropietario']) ?? tipoDocDe(propPol);
    campos.push(
      campo(
        'propietario',
        'Propietario (cédula o RIF)',
        propPol ? maskDocumento(tipoPropPol, propPol) : null,
        propDocOcr ? maskDocumento(tipoPropOcr, propDocOcr) : null,
        () =>
          documentosIguales(
            numeroDocumento(propPol),
            numeroDocumento(propDocOcr),
            true,
          ),
      ),
    );
  }
  const crudos: Crudos = {
    placa: { pol: placaPol, doc: placaDoc },
    serialCarroceria: { pol: carrPol, doc: carrDoc },
    serialMotor: { pol: motorPol, doc: motorDoc },
    marca: { pol: marcaPol, doc: marcaDoc },
    modelo: { pol: modeloPol, doc: modeloDoc },
    anio: { pol: anioPol, doc: anioDoc },
  };
  return { campos, crudos };
}

// ─── v3: datos cambiados en el formulario ──────────────────────────────────

/** Campo del diagnóstico → clave de `ocrLeido` (lo que el OCR leyó al emitir). */
const CLAVE_OCR_LEIDO: Record<string, string> = {
  tipoDoc: 'tipoDoc',
  documento: 'documento',
  nombre: 'nombre',
  apellido: 'apellido',
  placa: 'placa',
  serialCarroceria: 'serial',
  serialMotor: 'serialMotor',
  marca: 'marca',
  modelo: 'modelo',
  anio: 'anio',
};

/**
 * ¿Es el mismo dato? Mismas tolerancias del comparador: documentos sin prefijo (RIF con o sin
 * dígito verificador), nombres sin acentos ni orden, placa y seriales sin separadores (un carácter
 * distinto en un serial largo se toma como la misma lectura), marca y modelo con una palabra común.
 */
function mismoDato(
  c: string,
  a: string,
  b: string,
  o: { tipo: string; conDv: boolean },
): boolean {
  switch (c) {
    case 'tipoDoc':
      return (
        a.trim().toUpperCase().slice(0, 1) ===
        b.trim().toUpperCase().slice(0, 1)
      );
    case 'documento': {
      const n = (v: string) =>
        o.tipo === 'pasaporte'
          ? normSerial(v).replace(/^0+(?=.)/, '')
          : numeroDocumento(v);
      return documentosIguales(n(a), n(b), o.conDv);
    }
    case 'nombre':
    case 'apellido':
      return contenido(tokens(a), tokens(b));
    case 'placa':
      return normSerial(a) === normSerial(b);
    case 'serialCarroceria':
    case 'serialMotor': {
      const x = normSerial(a);
      const y = normSerial(b);
      const largo = c === 'serialCarroceria' ? 10 : 8;
      return (
        x === y ||
        (Math.min(x.length, y.length) >= largo && levenshtein(x, y) === 1)
      );
    }
    case 'marca':
    case 'modelo':
      return comparte(tokens(a), tokens(b));
    case 'anio': {
      const x = Number(a.replace(/\D/g, ''));
      const y = Number(b.replace(/\D/g, ''));
      return Number.isFinite(x) && x > 0 && x === y;
    }
    default:
      return false;
  }
}

/** Texto de lo leído al emitir: documentos enmascarados; placas y seriales completos. */
function mostrarOcrLeido(
  c: string,
  v: string,
  ol: Record<string, unknown>,
  tipo: string,
): string | null {
  if (c === 'documento') {
    if (tipo === 'pasaporte') {
      const n = normSerial(v);
      return n.length <= 4 ? '****' : `****${n.slice(-4)}`;
    }
    return maskDocumento(texto(ol.tipoDoc), v);
  }
  if (c === 'tipoDoc') return v.toUpperCase().slice(0, 1);
  return v;
}

/**
 * Marca `modificado_en_formulario` cada campo en que el documento (lo que lee ahora la IA o, si
 * no lo leyó, lo que leyó el OCR al emitir) difiere de la póliza Y lo leído al emitir coincide con
 * el documento: el dato se cambió a mano en el formulario. Agrega `enOcrAlEmitir` a todo campo con
 * lectura al emitir. Devuelve los campos modificados.
 */
function marcarModificados(
  tipo: string,
  campos: CampoDiagnostico[],
  crudos: Crudos,
  ol: Record<string, unknown>,
  o: { conDv: boolean; detectar: boolean },
): CampoDiagnostico[] {
  const out: CampoDiagnostico[] = [];
  for (const c of campos) {
    const clave = CLAVE_OCR_LEIDO[c.campo];
    const leido = clave ? texto(ol[clave]) : null;
    if (!leido) continue;
    c.enOcrAlEmitir = mostrarOcrLeido(c.campo, leido, ol, tipo);
    const cr = crudos[c.campo];
    if (!o.detectar || !cr?.pol) continue;
    const igual = (a: string, b: string) =>
      mismoDato(c.campo, a, b, { tipo, conDv: o.conDv });
    const difiere = cr.doc
      ? c.estado === 'no_coincide'
      : c.estado === 'sin_dato_documento' && !igual(cr.pol, leido);
    if (!difiere) continue;
    // Lo leído al emitir es lo que dice el documento: no es una lectura distinta del OCR.
    if (cr.doc && !igual(cr.doc, leido)) continue;
    c.estado = 'modificado_en_formulario';
    c.coincide = false;
    out.push(c);
  }
  return out;
}

/** «del certificado», «de la cédula»… para el resumen. */
const DEL_DOCUMENTO: Record<string, string> = {
  certificado: 'del certificado',
  cedula: 'de la cédula',
  cedula_titular: 'de la cédula del titular',
  cedula_beneficiario: 'de la cédula del beneficiario',
  licencia: 'de la licencia',
  rif: 'del RIF',
  pasaporte: 'del pasaporte',
};

function articuloCampo(tipo: string, c: CampoDiagnostico): string {
  switch (c.campo) {
    case 'documento':
      // «el número V-****5678 de la cédula»; en la licencia es la cédula del titular.
      return tipo === 'licencia' ? 'la cédula' : 'el número';
    case 'tipoDoc':
      return 'el tipo de documento';
    case 'nombre':
      return 'el nombre';
    case 'apellido':
      return 'el apellido';
    case 'placa':
      return 'la placa';
    case 'serialCarroceria':
      return 'el serial de carrocería';
    case 'serialMotor':
      return 'el serial de motor';
    case 'marca':
      return 'la marca';
    case 'modelo':
      return 'el modelo';
    case 'anio':
      return 'el año';
    default:
      return c.etiqueta.toLowerCase();
  }
}

/**
 * «Datos cambiados en el formulario: el OCR leyó la placa AC124KB del certificado, pero la póliza
 * se emitió con WDSFG3G3; el serial de carrocería …, pero la póliza se emitió con ….»
 */
function resumenModificados(
  tipo: string,
  modificados: CampoDiagnostico[],
): string {
  const del = DEL_DOCUMENTO[tipo] ?? `del documento`;
  const partes = modificados.map((c, i) => {
    const dato = `${articuloCampo(tipo, c)} ${c.enOcrAlEmitir ?? 'sin dato'}`;
    const pol = `pero la póliza se emitió con ${c.enPoliza ?? 'otro dato'}`;
    return i === 0 ? `el OCR leyó ${dato} ${del}, ${pol}` : `${dato}, ${pol}`;
  });
  return `Datos cambiados en el formulario: ${partes.join('; ')}.`;
}

function listaEtiquetas(campos: CampoDiagnostico[]): string {
  const e = campos.map((c) => c.etiqueta.toLowerCase());
  if (e.length <= 1) return e.join('');
  return `${e.slice(0, -1).join(', ')} y ${e[e.length - 1]}`;
}

export interface OpcionesDiagnostico {
  ahora?: Date;
  motivoAnalisis?: MotivoAnalisis;
}

/**
 * Diagnóstico de un documento: lectura OCR vs datos de la póliza.
 * Si la póliza no trae un dato, ese campo queda `sin_dato_poliza` y no cuenta como error.
 */
export function diagnosticar(
  tipo: string,
  ocr: LecturaOcr | null | undefined,
  ctx: ContextoPoliza,
  opts: OpcionesDiagnostico = {},
): Diagnostico {
  const ahora = opts.ahora ?? new Date();
  const confianzaRaw = Number(ocr?.confianza);
  const confianza = Number.isFinite(confianzaRaw)
    ? Math.min(1, Math.max(0, confianzaRaw))
    : null;
  const base = {
    version: 1 as const,
    tipo,
    analizadoEn: ahora.toISOString(),
    proveedor: texto(ocr?.proveedor),
    confianza,
    comparador: VERSION_COMPARADOR,
    rolEsperado: null as RolPersona | null,
    motivoAnalisis: opts.motivoAnalisis,
  };
  const motivoOcr = texto(ocr?.motivo)?.slice(0, 300) ?? null;

  if (ocr?.falla === 'tecnica') {
    return diagnosticoErrorTecnico(
      tipo,
      motivoOcr ?? 'El OCR no pudo leer el documento.',
      {
        ahora,
        motivoAnalisis: opts.motivoAnalisis,
        proveedor: base.proveedor,
      },
    );
  }
  if (ocr?.falla === 'tipo_documento') {
    return {
      ...base,
      resultado: 'no_coincide',
      campos: [
        {
          campo: 'tipoDocumento',
          etiqueta: 'Tipo de documento',
          enPoliza: requisitoLabel(tipo),
          enDocumento: null,
          coincide: false,
          estado: 'no_coincide',
        },
      ],
      resumen:
        motivoOcr ??
        `El archivo no es un(a) ${requisitoLabel(tipo).toLowerCase()}.`,
      comparadoCon: null,
    };
  }

  const ex = rec(ocr?.extraido);
  if (!Object.keys(ex).length || confianza === 0) {
    return {
      ...base,
      resultado: 'ilegible',
      campos: [],
      resumen:
        motivoOcr ??
        'No se pudo leer el documento. Hace falta una imagen más nítida.',
      comparadoCon: null,
    };
  }

  const hoy = caracasParts(ahora).fecha;
  let campos: CampoDiagnostico[] = [];
  let rol: Diagnostico['comparadoCon'] = null;
  let clave: string[] = [];
  let aviso: string | null = null;
  let nota: string | null = null;
  let crudos: Crudos = {};
  let conDv = false;
  let respaldo = false;
  if (tipo === 'certificado') {
    const r = compararVehiculo(ex, ctx);
    campos = r.campos;
    crudos = r.crudos;
    rol = 'vehiculo';
    clave = ['placa', 'serialCarroceria'];
  } else if (TIPOS_PERSONA.has(tipo)) {
    const r = compararPersona(tipo, ex, ctx, hoy);
    campos = r.campos;
    rol = r.rol;
    base.rolEsperado = r.rolEsperado;
    aviso = r.aviso;
    nota = r.nota;
    crudos = r.crudos;
    conDv = r.conDv;
    respaldo = r.respaldo;
    clave = ['documento'];
  }
  const conNota = (t: string) => (nota ? `${t} ${nota}` : t);

  // v3: lo que el OCR leyó al emitir. Sin él (emisiones viejas) todo sigue como antes. Con la
  // persona de respaldo o un documento de otra persona de la póliza no se afirma que se cambió.
  const ol = rec(ctx.ocrLeido?.[tipo]);
  const modificados = Object.keys(ol).length
    ? marcarModificados(tipo, campos, crudos, ol, {
        conDv,
        detectar:
          !aviso && !respaldo && !(tipo === 'certificado' && !ctx.vehiculo),
      })
    : [];

  const fallan = campos.filter((c) => c.coincide === false);
  const parecidos = campos.filter((c) => c.estado === 'parecido');
  const coinciden = campos.filter((c) => c.coincide === true);
  const rolTexto = rol === 'vehiculo' || !rol ? 'asegurado' : rol;

  if (modificados.length) {
    const otros = fallan.filter((c) => c.estado === 'no_coincide');
    const frases = [
      resumenModificados(tipo, modificados),
      ...otros.slice(0, 2).map((c) => fraseDiferencia(tipo, c, rolTexto)),
    ];
    if (otros.length > 2)
      frases.push(`Hay ${otros.length - 2} diferencia(s) más.`);
    return {
      ...base,
      resultado: 'datos_modificados',
      campos,
      resumen: conNota(frases.join(' ')),
      comparadoCon: rol,
    };
  }

  if (aviso) {
    // Documento de otra persona de la póliza, sin la persona esperada o un dígito distinto:
    // no se afirma que no coincide; revisar. Lo demás que falle (p. ej. vencida) sí es error.
    const identidad = ['tipoDoc', 'documento', 'nombre', 'apellido'];
    const otros = fallan.filter((c) => !identidad.includes(c.campo));
    return {
      ...base,
      resultado: otros.length ? 'no_coincide' : 'sin_certeza',
      campos,
      resumen: [
        aviso,
        ...otros.map((c) => fraseDiferencia(tipo, c, rolTexto)),
      ].join(' '),
      comparadoCon: rol,
    };
  }

  if (fallan.length) {
    const frases = fallan
      .slice(0, 3)
      .map((c) => fraseDiferencia(tipo, c, rolTexto));
    if (fallan.length > 3)
      frases.push(`Hay ${fallan.length - 3} diferencia(s) más.`);
    return {
      ...base,
      resultado: 'no_coincide',
      campos,
      resumen: conNota(frases.join(' ')),
      comparadoCon: rol,
    };
  }

  const claveOk = campos.some((c) => clave.includes(c.campo) && c.coincide);
  if (!campos.length || !claveOk) {
    const c = campos.find((x) => clave.includes(x.campo));
    let resumen: string;
    if (!campos.length || (tipo === 'certificado' && !ctx.vehiculo)) {
      resumen =
        tipo === 'certificado'
          ? 'La póliza no trae los datos del vehículo para comparar.'
          : `No hay datos de la póliza para comparar ${requisitoLabel(tipo).toLowerCase()}.`;
    } else if (c?.estado === 'sin_dato_poliza') {
      resumen = `La póliza no trae ${c.etiqueta.toLowerCase()} para comparar.`;
    } else if (tipo === 'certificado') {
      resumen = parecidos.length
        ? `${listaEtiquetas(parecidos)}: casi igual a la póliza (un carácter distinto).`
        : 'No se leyó la placa ni el serial de carrocería en el documento.';
    } else {
      resumen = `No se leyó ${(c?.etiqueta ?? 'el número de documento').toLowerCase()} en el documento.`;
    }
    return {
      ...base,
      resultado: 'sin_certeza',
      campos,
      resumen,
      comparadoCon: rol,
    };
  }
  if (parecidos.length) {
    return {
      ...base,
      resultado: 'sin_certeza',
      campos,
      resumen: `${listaEtiquetas(parecidos)}: casi igual a la póliza (un carácter distinto).`,
      comparadoCon: rol,
    };
  }
  if (confianza == null || confianza < CONFIANZA_ALTA) {
    return {
      ...base,
      resultado: 'sin_certeza',
      campos,
      resumen:
        'Los datos coinciden, pero la lectura del documento fue parcial.',
      comparadoCon: rol,
    };
  }
  const sinDato = campos.filter((c) => c.estado === 'sin_dato_poliza');
  return {
    ...base,
    resultado: 'coincide',
    campos,
    resumen: conNota(
      `Coincide con la póliza: ${listaEtiquetas(coinciden)}.` +
        (sinDato.length
          ? ` Sin dato en la póliza: ${listaEtiquetas(sinDato)}.`
          : ''),
    ),
    comparadoCon: rol,
  };
}

/** Espera antes de reintentar un error técnico: 5 min, 15 min, 1 h, 4 h y luego cada 12 h. */
export function esperaReintentoMs(intento: number): number {
  const minutos = [5, 15, 60, 240, 720];
  const i = Math.min(Math.max(intento, 1), minutos.length) - 1;
  return minutos[i] * 60_000;
}

export function diagnosticoErrorTecnico(
  tipo: string,
  motivo: string,
  opts: {
    ahora?: Date;
    motivoAnalisis?: MotivoAnalisis;
    proveedor?: string | null;
  } = {},
): Diagnostico {
  return {
    version: 1,
    tipo,
    analizadoEn: (opts.ahora ?? new Date()).toISOString(),
    proveedor: opts.proveedor ?? null,
    confianza: null,
    resultado: 'error_tecnico',
    comparador: VERSION_COMPARADOR,
    campos: [],
    resumen: `No se pudo analizar el documento: ${motivo.slice(0, 200)}`,
    comparadoCon: null,
    motivoAnalisis: opts.motivoAnalisis,
  };
}

export type EstadoPorIa = 'validado' | 'observado' | 'recibido';

/** Estado del requisito y motivo visible en el monitor según el resultado de la IA. */
export function estadoPorDiagnostico(d: Diagnostico): {
  estado: EstadoPorIa;
  motivo: string | null;
} {
  switch (d.resultado) {
    case 'coincide':
      return { estado: 'validado', motivo: null };
    case 'no_coincide':
    case 'ilegible':
    case 'datos_modificados':
      return { estado: 'observado', motivo: d.resumen };
    case 'sin_certeza':
      return { estado: 'observado', motivo: `Revisar: ${d.resumen}` };
    default:
      return { estado: 'recibido', motivo: null };
  }
}

/**
 * Motivo para el asegurado (página pública y correos): sin datos de la póliza, sin números
 * ni nombres. El detalle queda solo en el monitor.
 */
export function motivoParaAsegurado(
  d: Pick<Diagnostico, 'resultado' | 'campos'>,
): string {
  if (d.resultado === 'ilegible')
    return 'No se pudo leer el documento. Envíe una imagen más nítida y completa.';
  if (d.resultado === 'sin_certeza')
    return 'No se pudo confirmar el documento. Envíe una imagen más nítida y completa.';
  // El dato se cambió en el formulario: lo revisa el equipo, el asegurado no tiene que reenviar.
  if (d.resultado === 'datos_modificados')
    return 'Estamos revisando los datos de su póliza con el documento recibido.';
  if (d.resultado === 'no_coincide') {
    const tipoMal = d.campos.some(
      (c) => c.campo === 'tipoDocumento' && c.coincide === false,
    );
    if (tipoMal) return 'El archivo no corresponde al documento solicitado.';
    const vencida = d.campos.some(
      (c) => c.campo === 'vencimiento' && c.coincide === false,
    );
    const otros = d.campos.filter(
      (c) => c.coincide === false && c.campo !== 'vencimiento',
    );
    if (vencida && !otros.length) return 'La licencia está vencida.';
    return `Los datos del documento no coinciden con la póliza (${listaEtiquetas(otros)}).`;
  }
  return 'El documento debe revisarse.';
}

/** Vista corta para la bandeja. */
export function diagnosticoCorto(d: unknown): {
  resultado: ResultadoIa;
  resumen: string;
  analizadoEn: string | null;
} | null {
  const r = rec(d);
  const resultado = texto(r.resultado) as ResultadoIa | null;
  if (!resultado || !(RESULTADOS_IA as readonly string[]).includes(resultado))
    return null;
  return {
    resultado,
    resumen: texto(r.resumen) ?? '',
    analizadoEn: texto(r.analizadoEn),
  };
}

/** Diagnóstico del archivo actual (el de otro archivo no se muestra ni cuenta). */
export function diagnosticoVigente(r: {
  diagnostico?: unknown;
  analisisRef?: string | null;
  ref?: string | null;
}): Diagnostico | null {
  if (!r.diagnostico || !r.ref || r.analisisRef !== r.ref) return null;
  return diagnosticoCorto(r.diagnostico)
    ? (r.diagnostico as Diagnostico)
    : null;
}

/** El OCR dijo que el archivo no era el documento pedido (p. ej. «parece ser un RIF»). */
export function fueOtroTipoDeDocumento(d: unknown): boolean {
  const r = rec(d);
  return (
    r.resultado === 'no_coincide' &&
    Array.isArray(r.campos) &&
    r.campos.some((c) => rec(c).campo === 'tipoDocumento')
  );
}

/** v3: requisito observado porque un dato se cambió en el formulario respecto al OCR al emitir. */
export function conDatosModificados(r: {
  estado: string;
  diagnostico?: unknown;
  analisisRef?: string | null;
  ref?: string | null;
}): boolean {
  return (
    r.estado === 'observado' &&
    diagnosticoVigente(r)?.resultado === 'datos_modificados'
  );
}

/**
 * ¿Hay que (re)analizar este requisito? Sin cambios no se vuelve a llamar al OCR:
 * - recibido sin diagnóstico de este archivo → 'nuevo'
 * - error técnico y ya pasó la espera → 'reintento'
 * - decidido por la IA con otro archivo → 'cambio_archivo'
 * - cambiaron los datos de la póliza → 'cambio_poliza' (se compara de nuevo lo ya leído)
 * Nunca toca una decisión manual del administrador.
 */
export function motivoAnalisis(
  r: {
    estado: string;
    ref: string | null;
    decision: string | null;
    diagnostico: unknown;
    analisisRef: string | null;
    huellaPoliza: string | null;
    proximoAnalisis: Date | null;
  },
  huella: string,
  ahora: Date,
): MotivoAnalisis | null {
  if (!r.ref || r.decision === 'manual') return null;
  const diag = diagnosticoVigente(r);
  if (r.estado === 'recibido') {
    if (!diag) return 'nuevo';
    if (diag.resultado === 'error_tecnico') {
      return !r.proximoAnalisis ||
        r.proximoAnalisis.getTime() <= ahora.getTime()
        ? 'reintento'
        : null;
    }
    if ((diag.comparador ?? 1) < VERSION_COMPARADOR) return 'cambio_comparador';
    return r.huellaPoliza !== huella ? 'cambio_poliza' : null;
  }
  if (
    (r.estado === 'validado' || r.estado === 'observado') &&
    r.decision === 'ia'
  ) {
    if (!diag) return 'cambio_archivo';
    const vigente =
      r.estado === 'validado'
        ? VERSION_COMPARADOR_VALIDADOS
        : VERSION_COMPARADOR;
    if ((diag.comparador ?? 1) < vigente) return 'cambio_comparador';
    if (r.huellaPoliza !== huella) return 'cambio_poliza';
  }
  return null;
}

// ─── Concurrencia ─────────────────────────────────────────────────────────

/**
 * Cola en memoria con tope de análisis simultáneos (2 por defecto). Las cargas de usuario
 * entran con prioridad (al frente de la cola) para no esperar detrás de la revisión periódica.
 */
export class ColaConcurrencia {
  private activos = 0;
  private espera: (() => void)[] = [];
  private vaciaResolvers: (() => void)[] = [];

  constructor(private readonly max = 2) {}

  get enCurso(): number {
    return this.activos;
  }

  get pendientes(): number {
    return this.espera.length;
  }

  async ejecutar<T>(fn: () => Promise<T>, prioridad = false): Promise<T> {
    if (this.activos >= this.max) {
      // Al liberarse un cupo se traspasa directo a quien espera (activos no baja).
      await new Promise<void>((resolve) => {
        if (prioridad) this.espera.unshift(resolve);
        else this.espera.push(resolve);
      });
    } else {
      this.activos++;
    }
    try {
      return await fn();
    } finally {
      const siguiente = this.espera.shift();
      if (siguiente) siguiente();
      else {
        this.activos--;
        if (this.activos === 0) {
          const rs = this.vaciaResolvers.splice(0);
          rs.forEach((r) => r());
        }
      }
    }
  }

  /** Se resuelve cuando no queda nada en curso ni en espera. */
  vacia(): Promise<void> {
    if (this.activos === 0 && !this.espera.length) return Promise.resolve();
    return new Promise((resolve) => this.vaciaResolvers.push(resolve));
  }
}
