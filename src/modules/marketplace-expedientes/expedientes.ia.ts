/**
 * Validación automática con IA (reglas puras, sin BD): compara lo que el OCR leyó del
 * documento contra los datos de la póliza y arma un diagnóstico campo por campo.
 *
 * Resultado → estado del requisito:
 * - coincide (confianza alta)          → validado (actor `ia`)
 * - no_coincide | ilegible              → observado con el resumen como motivo
 * - sin_certeza                         → observado con «Revisar: …»
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
] as const;
export type ResultadoIa = (typeof RESULTADOS_IA)[number];

export type MotivoAnalisis =
  | 'nuevo'
  | 'reintento'
  | 'cambio_poliza'
  | 'cambio_archivo'
  | 'carga';

/** Estado de cada dato comparado (además de `coincide`). */
export type EstadoCampo =
  | 'coincide'
  | 'no_coincide'
  | 'sin_dato_poliza'
  | 'sin_dato_documento'
  | 'parecido'
  | 'no_aplica';

export interface CampoDiagnostico {
  campo: string;
  etiqueta: string;
  enPoliza: string | null;
  enDocumento: string | null;
  /** null = no se pudo comparar (sin dato en la póliza o en el documento). */
  coincide: boolean | null;
  estado: EstadoCampo;
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
  /** Persona de la póliza contra la que se comparó (tomador o asegurado). */
  comparadoCon?: 'tomador' | 'asegurado' | 'vehiculo' | null;
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
  rol: 'tomador' | 'asegurado';
  tipoDoc: string | null;
  documento: string | null;
  nombre: string | null;
  apellido: string | null;
}

export interface ContextoPoliza {
  personas: PersonaPoliza[];
  vehiculo: Record<string, unknown> | null;
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

function personaDe(
  v: unknown,
  rol: PersonaPoliza['rol'],
): PersonaPoliza | null {
  const r = rec(v);
  if (!Object.keys(r).length) return null;
  const ident = pick(r, ['identificacion', 'cedula', 'rif']);
  const documento = pick(r, ['documento']) ?? ident;
  const tipoDoc =
    pick(r, ['tipoDoc', 'tipo_doc'])?.toUpperCase().slice(0, 1) ??
    tipoDocDe(ident);
  const p: PersonaPoliza = {
    rol,
    tipoDoc: tipoDoc ?? null,
    documento: documento ? numeroDocumento(documento) || null : null,
    nombre: pick(r, ['nombre', 'nombres', 'razonSocial']),
    apellido: pick(r, ['apellido', 'apellidos']),
  };
  return p.documento || p.nombre || p.apellido ? p : null;
}

/**
 * Personas de la póliza en orden de preferencia: en RCV el documento es del tomador; en
 * personas y patrimoniales, del asegurado (titular). Sin repetir la misma cédula.
 */
export function contextoPoliza(exp: {
  producto: string;
  snapshot?: unknown;
  aseguradoTipoDoc?: string | null;
  aseguradoDocumento?: string | null;
  aseguradoNombre?: string | null;
  aseguradoApellido?: string | null;
}): ContextoPoliza {
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
  const tomador = personaDe(snap.tomador, 'tomador');
  const asegurado = personaDe(snap.asegurado, 'asegurado');
  const orden =
    exp.producto === 'rcv'
      ? [tomador, asegurado, guardado]
      : [asegurado, guardado, tomador];
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
      continue;
    }
    personas.push({ ...p });
  }
  const veh = rec(snap.vehiculo);
  return {
    personas,
    vehiculo: Object.keys(veh).length ? veh : null,
  };
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
  return createHash('sha256')
    .update(JSON.stringify(estable({ personas: ctx.personas, vehiculo })))
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

function compararPersona(
  tipo: string,
  ex: Record<string, unknown>,
  ctx: ContextoPoliza,
  hoy: string,
): { campos: CampoDiagnostico[]; rol: PersonaPoliza['rol'] | null } {
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

  const personas = ctx.personas;
  const persona =
    personas.find((p) =>
      documentosIguales(
        tipo === 'pasaporte'
          ? normSerial(p.documento ?? '')
          : (p.documento ?? ''),
        docOcr,
        conDv,
      ),
    ) ??
    personas.find((p) => p.documento) ??
    personas[0] ??
    null;

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
  campos.push(
    campo(
      'documento',
      etiquetaDoc,
      docPol ? maskDocumento(persona?.tipoDoc, docPol) : null,
      docOcr ? maskDocumento(tipoOcr, docOcr) : null,
      () =>
        documentosIguales(
          tipo === 'pasaporte' ? normSerial(docPol ?? '') : (docPol ?? ''),
          docOcr,
          conDv,
        ),
    ),
  );

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
  return { campos, rol: persona?.rol ?? null };
}

function compararVehiculo(
  ex: Record<string, unknown>,
  ctx: ContextoPoliza,
): CampoDiagnostico[] {
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
  return campos;
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
  if (tipo === 'certificado') {
    campos = compararVehiculo(ex, ctx);
    rol = 'vehiculo';
    clave = ['placa', 'serialCarroceria'];
  } else if (TIPOS_PERSONA.has(tipo)) {
    const r = compararPersona(tipo, ex, ctx, hoy);
    campos = r.campos;
    rol = r.rol;
    clave = ['documento'];
  }

  const fallan = campos.filter((c) => c.coincide === false);
  const parecidos = campos.filter((c) => c.estado === 'parecido');
  const coinciden = campos.filter((c) => c.coincide === true);
  const rolTexto = rol === 'vehiculo' || !rol ? 'asegurado' : rol;

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
      resumen: frases.join(' '),
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
    resumen:
      `Coincide con la póliza: ${listaEtiquetas(coinciden)}.` +
      (sinDato.length
        ? ` Sin dato en la póliza: ${listaEtiquetas(sinDato)}.`
        : ''),
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
    return r.huellaPoliza !== huella ? 'cambio_poliza' : null;
  }
  if (
    (r.estado === 'validado' || r.estado === 'observado') &&
    r.decision === 'ia'
  ) {
    if (!diag) return 'cambio_archivo';
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
