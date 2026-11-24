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
import type { DatosCotizacion } from './expedientes.cotizacion';
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
 * v5 (9-nov): sin datos de la persona → revisar. En personas, si Nexus no trae a los asegurados (solo
 *   al tomador), una cédula que no es del tomador queda sin_certeza; en RCV, sin conductor habitual,
 *   una licencia que no es del tomador ni del titular también. En personas vale el RIF personal.
 * v6 (9-nov): con un aviso (p. ej. sin datos del conductor) y además otro error (vencida), el motivo
 *   empieza por el error («La licencia está vencida…») y queda no_coincide; si el aviso es lo único,
 *   sin_certeza. Los observados v<6 se vuelven a comparar con lo ya extraído (sin OCR).
 * v7 (9-nov): datos de la cotización del wizard (solo si es la única con ese cnpoliza): vehículo
 *   para el certificado RCV, conductor para la licencia, tomador/asegurados/titular para la cédula y
 *   beneficiario (marcado como tal), y lo leído por el OCR al escanear (`documents[tipo].ocr`) para
 *   los datos cambiados en el formulario. Fuera de la huella. Los observados v<7 se recomparan.
 * v8 (9-nov): certificado RCV — la identidad del vehículo es placa + serial de carrocería: solo esos
 *   dos dan no_coincide o datos cambiados; serial de motor, marca, modelo, año y propietario quedan
 *   informativos (estado `difiere`). Rótulos del OCR (TIPODOCPROPIETARIO, PLACA…) y basura («V»,
 *   solo signos) son lectura fallida: no se comparan y en un campo clave dan sin_certeza. Cédula RCV
 *   acepta RIF (tomador J o RIF personal V/E). Licencia sin datos del conductor: no se afirma que se
 *   cambió la cédula. Los observados v<8 se recomparan con lo ya leído.
 * v9 (11-nov): documento que difiere en un dígito — texto neutral (puede ser lectura del documento o
 *   transcripción en el formulario), la posición del dígito que cambia y una máscara que lo deja
 *   ver; con lo leído por el OCR del wizard se precisa si la diferencia es entre lecturas o si la
 *   cédula se cambió en el formulario. Solo recompara lo ya leído (sin llamar al OCR).
 * v10 (23-nov, falsas alarmas de prod): misma persona (el número coincide) con un nombre o apellido
 *   distinto que es el que el OCR leyó en su cédula, o un apellido de casada («X DE Y» frente a
 *   «X Z»): queda `difiere` (informativo), no no_coincide ni datos cambiados. Un nombre o apellido
 *   que es solo sexo o estado civil («MASCULINO», «SOLTERA»; foto girada) no cuenta como leído.
 *   El certificado rechazado como «documento no reconocido» (p. ej. Certificado de Origen de un
 *   vehículo nuevo) se vuelve a leer UNA vez. Lo demás solo recompara lo ya leído.
 * v11 (23-nov, falsa alarma prod 7-7-7000003208, tomador empresa): en personas, con tomador J/G/C
 *   el documento `cedula` se compara SOLO con el tomador: su RIF (sin guiones ni dígito verificador)
 *   y razón social (tolerante a «C.A.», «CA», puntos); nunca con el asegurado. Si no se leyó el RIF
 *   queda «Revisar» (nunca «Errado») y la cédula leída es solo complementaria; si el archivo trae
 *   el RIF y además la cédula (PDF de varias páginas, `documentosAdicionales` del OCR), manda el
 *   RIF y la cédula es informativa. Con tomador natural, sin cambios (v4). Los
 *   observados v<11 se recomparan con lo ya leído; el documento del tomador empresa sin RIF leído
 *   se vuelve a leer UNA vez (ver expedientes.service).
 * v12 (24-nov, Rio Vida J-50058503-9): en personas cada documento es de SU persona: `cedula` =
 *   documento del tomador (RIF si J/G/C; cédula o pasaporte si natural) solo contra el tomador;
 *   `cedula_titular` (requisito nuevo) solo contra el titular. Un archivo de otra persona de la póliza
 *   queda «Revisar» con un texto simple («Falta el RIF de la empresa tomadora. El archivo cargado es
 *   la cédula del titular (V-****1805).»). Si el archivo trae el documento de la otra persona
 *   (también en `documentosAdicionales`), cubre su requisito sin otra llamada al OCR. Los observados
 *   v<12 se recomparan con lo ya leído; el documento del tomador empresa sin RIF ni documentos
 *   adicionales se vuelve a leer UNA vez, salvo que el archivo esté compartido (ver
 *   expedientes.service: documento sobrescrito).
 * v13 (24-nov, falsa alarma prod 18-1-0000139376): el nombre o apellido REGISTRADO de una persona
 *   natural que es solo sexo o estado civil («Masculino») cuenta como sin dato, igual que en lo
 *   leído; si el registro trae el nombre completo en un solo campo y empieza por esa palabra
 *   («Masculino RODRIGUEZ PEÑA», expediente creado por conciliación), se quita solo si el número del
 *   documento coincide y el resto es el apellido leído. Se compara el valor completo: una razón
 *   social («Venezolana de Instrumentación…») y los tomadores J/G/C no se tocan. Sin ningún nombre
 *   que comparar queda «Revisar». Siempre exige el número: una cédula ajena nunca valida. Los
 *   observados v<13 se recomparan con lo ya leído (sin OCR ni correos).
 *   Nombre de pila distinto con el mismo número y el apellido coincidente (7-7-7000003208: «JHON»
 *   en la cédula, «RAMON» registrado): misma persona, queda `difiere` (informativo).
 */
export const VERSION_COMPARADOR = 13;

/**
 * La v4 a la v7 solo cambian contra quién se compara en personas y licencias (y el orden
 * del motivo): lo ya validado por la
 * IA con la v3 no se vuelve a comparar (lo validado no se toca).
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
  | 'modificado_en_formulario'
  /** v8: dato informativo del vehículo que difiere (no marca el documento como errado). */
  | 'difiere';

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
  /** Auditoría: modelo de Gemini que leyó el documento y los intentados en la cadena del OCR. */
  modelo?: string | null;
  modelos?: { modelo: string; resultado: string }[];
}

export interface LecturaOcr {
  extraido?: unknown;
  confianza?: number | null;
  motivo?: string | null;
  proveedor?: string | null;
  /** 'tecnica' = sin lectura real; 'tipo_documento' = no es el documento pedido. */
  falla?: string | null;
  /** Auditoría: modelo que leyó y los intentados (OCR v1.3). */
  modelo?: string | null;
  modelos?: unknown;
}

/** Modelo y cadena intentada (solo si el OCR los informa), para auditar cada diagnóstico. */
function auditoriaModelo(
  ocr: LecturaOcr | null | undefined,
): Pick<Diagnostico, 'modelo' | 'modelos'> {
  const out: Pick<Diagnostico, 'modelo' | 'modelos'> = {};
  const modelo = texto(ocr?.modelo)?.slice(0, 80);
  if (modelo) out.modelo = modelo;
  if (Array.isArray(ocr?.modelos)) {
    const modelos = (ocr.modelos as unknown[])
      .slice(0, 6)
      .map((m) => rec(m))
      .filter((m) => texto(m.modelo))
      .map((m) => ({
        modelo: String(texto(m.modelo)).slice(0, 80),
        resultado: String(texto(m.resultado) ?? '').slice(0, 20),
      }));
    if (modelos.length) out.modelos = modelos;
  }
  return out;
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
  /**
   * v11: titular (asegurado principal): `asegurado`/`titular` del snapshot y de las otras fuentes,
   * el asegurado guardado del expediente y el primero de `funeral.asegurados`. Fuera de la huella.
   */
  titular?: boolean;
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
  /**
   * v7: vehículo de la cotización del wizard. Fuera de la huella; completa lo que no traiga
   * `vehiculo` (el del expediente manda).
   */
  vehiculoCotizacion?: Record<string, unknown> | null;
  /** v7: lo que el OCR leyó al escanear según la cotización (si el expediente no trae `ocrLeido`). */
  ocrLeidoCotizacion?: Record<string, Record<string, unknown>>;
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

/**
 * v10: palabras de los campos «Sexo» y «Estado civil» de la cédula. Con la foto girada el OCR a veces
 * las deja como nombre o apellido (18-1-0000139376: nombre «Masculino»).
 */
const SEXO_ESTADO_CIVIL = new Set([
  'M',
  'F',
  'MASC',
  'FEM',
  'MASCULINO',
  'FEMENINO',
  'SEXO',
  'SOLTERO',
  'SOLTERA',
  'CASADO',
  'CASADA',
  'DIVORCIADO',
  'DIVORCIADA',
  'VIUDO',
  'VIUDA',
  'CONCUBINO',
  'CONCUBINA',
  'EDO',
  'ESTADO',
  'CIVIL',
]);

/**
 * v13: palabras que, delante del nombre completo registrado, son el sexo o el estado civil y no un
 * nombre. Sin «SOLTERO» ni «CASADO» (apellidos reales) ni letras sueltas; nunca nacionalidad
 * («VENEZOLANA DE …» es una razón social legítima).
 */
const PREFIJO_SEXO_ESTADO_CIVIL = new Set([
  'MASCULINO',
  'FEMENINO',
  'SOLTERA',
  'CASADA',
  'DIVORCIADO',
  'DIVORCIADA',
  'CONCUBINO',
  'CONCUBINA',
]);

/** v10: ¿el nombre o apellido leído es solo sexo o estado civil? Entonces no se leyó el nombre. */
export function esSexoOEstadoCivil(v?: string | null): boolean {
  const palabras = normTexto(v).split(' ').filter(Boolean);
  return palabras.length > 0 && palabras.every((p) => SEXO_ESTADO_CIVIL.has(p));
}

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

/** v9: posición (desde 1) del único dígito distinto entre dos números del mismo largo; si no, null. */
export function posicionDigitoDistinto(a: string, b: string): number | null {
  if (!a || a.length !== b.length) return null;
  let pos: number | null = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (pos !== null) return null;
    pos = i + 1;
  }
  return pos;
}

/** «1.er», «2.º», «3.er», «4.º»… */
function ordinalDigito(n: number): string {
  return n === 1 || n === 3 ? `${n}.er` : `${n}.º`;
}

/**
 * v9: como maskDocumento, pero deja ver también el dígito de la posición `pos` (desde 1) cuando
 * cae fuera de los últimos 4: así dos números que difieren en ese dígito no se ven iguales.
 */
export function maskDocumentoConDigito(
  tipoDoc: string | null | undefined,
  documento: string | null | undefined,
  pos: number | null,
): string | null {
  const n = numeroDocumento(documento);
  if (!n || !pos || pos > n.length - 4)
    return maskDocumento(tipoDoc, documento);
  const tipo = tipoDoc ? `${String(tipoDoc).toUpperCase()}-` : '';
  return (
    tipo +
    Array.from(n, (ch, i) =>
      i >= n.length - 4 || i === pos - 1 ? ch : '*',
    ).join('')
  );
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
  /** v7: datos de la cotización del wizard (la única con ese cnpoliza). Fuera de la huella. */
  cotizacion: DatosCotizacion | null = null,
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
  // v11: el asegurado y el titular del snapshot y el asegurado guardado son el titular.
  for (const p of [orden[1], orden[2], guardado]) if (p) p.titular = true;
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
      if (p.titular) igual.titular = true;
      continue;
    }
    personas.push({ ...p, roles: [...p.roles] });
  }
  const veh = rec(snap.vehiculo);
  const ocrLeido = ocrLeidoDe(snap.ocrLeido);
  const adicionales = personasAdicionales(
    snap,
    otrasFuentes,
    personas,
    cotizacion?.personas ?? [],
    exp.producto,
  );
  return {
    personas,
    vehiculo: Object.keys(veh).length ? veh : null,
    ...(ocrLeido ? { ocrLeido } : {}),
    producto: exp.producto,
    ...(adicionales.length ? { adicionales } : {}),
    ...(cotizacion?.vehiculo
      ? { vehiculoCotizacion: cotizacion.vehiculo }
      : {}),
    ...(cotizacion?.ocrLeido
      ? { ocrLeidoCotizacion: cotizacion.ocrLeido }
      : {}),
  };
}

/**
 * v7: vehículo contra el que se compara: el del expediente y, en lo que no traiga, el de la
 * cotización. null si ninguno.
 */
function vehiculoDe(ctx: ContextoPoliza): Record<string, unknown> | null {
  const cot = ctx.vehiculoCotizacion ?? null;
  if (!ctx.vehiculo) return cot;
  if (!cot) return ctx.vehiculo;
  const out: Record<string, unknown> = { ...cot };
  for (const [k, v] of Object.entries(ctx.vehiculo))
    if (texto(v) != null) out[k] = v;
  return out;
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
  /** v7: personas de la cotización con su papel. */
  etiquetadas: [unknown, RolPersona][] = [],
  producto?: string,
): PersonaPoliza[] {
  const fuentes: [unknown, RolPersona][] = [];
  /** v11: titular (asegurado principal) en estas fuentes. */
  const titulares = new Set<unknown>();
  const deFuneral = (f: Record<string, unknown>) => {
    // v10: en RCV `funeral` puede quedar de un funerario anterior en la misma pestaña: no cuenta.
    if (producto === 'rcv') return;
    const asegurados = lista(f.asegurados);
    // v11: como en Emisión, el titular de personas es el primer asegurado.
    if (asegurados[0]) titulares.add(asegurados[0]);
    for (const a of asegurados) fuentes.push([a, 'asegurado']);
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
      if (m.asegurado) titulares.add(m.asegurado);
      if (m.titular) titulares.add(m.titular);
      deFuneral(m);
      deFuneral(rec(m.funeral));
    }
  }
  fuentes.push(...etiquetadas);
  const out: PersonaPoliza[] = [];
  for (const [v, rol] of fuentes) {
    if (rec(v).sinCedula === true) continue;
    const p = personaDe(v, rol);
    if (!p?.documento) continue;
    const esTitular = titulares.has(v);
    const igual = [...yaEstan, ...out].find((x) => x.documento === p.documento);
    if (igual) {
      // Solo se completan los papeles de las adicionales (las del snapshot van en la huella).
      if (out.includes(igual) && !igual.roles.includes(rol))
        igual.roles.push(rol);
      if (out.includes(igual) && esTitular) igual.titular = true;
      continue;
    }
    if (esTitular) p.titular = true;
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

/**
 * v5: ¿Nexus conoce a las personas de la póliza aparte del tomador? (titular o asegurados naturales
 * con cédula distinta de la del tomador, en el snapshot o en las otras fuentes).
 */
function conoceAsegurados(todas: PersonaPoliza[]): boolean {
  return todas.some(
    (p) =>
      !!p.documento &&
      !esJuridico(p.tipoDoc) &&
      !p.roles.includes('tomador') &&
      p.roles.includes('asegurado'),
  );
}

/** v4: en personas, la cédula de la póliza puede ser de cualquiera de sus personas naturales (v11: con tomador J/G/C, solo el tomador). */
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
      // v10: «MASCULINO» o «SOLTERA» como nombre no es un nombre leído.
      if ((k === 'nombre' || k === 'apellido') && esSexoOEstadoCivil(t))
        continue;
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
          // v11: la marca de titular no entra (no reabre lo ya decidido).
          personas: ctx.personas.map((p) => {
            const { titular: _titular, ...resto } = p;
            return resto;
          }),
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
      if (tipo === 'rif' || /^[JGC]-/.test(c.enDocumento ?? ''))
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

/**
 * Rótulos que a veces devuelve el OCR en lugar del dato (lectura fallida, no otro dato), comparados
 * en mayúsculas sin espacios ni signos. v8: también los del certificado y el carnet.
 */
const ROTULOS_OCR = new Set([
  'NOMBRE',
  'NOMBRES',
  'APELLIDO',
  'APELLIDOS',
  'NOMBREAPELLIDO',
  'NOMBRESAPELLIDOS',
  'NOMBREYAPELLIDO',
  'NOMBRESYAPELLIDOS',
  'RAZONSOCIAL',
  'NULL',
  'UNDEFINED',
  'NONE',
  'NA',
  'PLACA',
  'SERIAL',
  'SERIALMOTOR',
  'SERIALDEMOTOR',
  'MOTOR',
  'SERIALCARROCERIA',
  'SERIALDECARROCERIA',
  'CARROCERIA',
  'SERIALNIV',
  'NIV',
  'VIN',
  'MODELO',
  'MARCA',
  'ANIO',
  'ANO',
  'COLOR',
  'CLASE',
  'USO',
  'VERSION',
  'LINEA',
  'CEDULA',
  'IDENTIFICACION',
  'DOCUMENTO',
  'PROPIETARIO',
  'IDENTIFICACIONPROPIETARIO',
]);

/** v8: ¿el OCR devolvió el rótulo de un campo (TIPODOCPROPIETARIO, PLACA, NOMBRE…) y no el dato? */
export function esRotuloOcr(v?: string | null): boolean {
  const s = normTexto(v).replace(/ /g, '');
  if (!s || /\d/.test(s)) return false;
  return ROTULOS_OCR.has(s) || s.startsWith('TIPODOC');
}

/** v8: basura del OCR: 1 o 2 caracteres («V») o solo signos. */
function esBasuraOcr(v?: string | null): boolean {
  const s = String(v ?? '').trim();
  return !!s && normTexto(s).replace(/ /g, '').length <= 2;
}

/** Campos en que un valor de 1–2 caracteres no es un dato (no aplica a nombres ni tipo de doc). */
const CAMPOS_SIN_VALORES_CORTOS = new Set([
  'documento',
  'placa',
  'serialCarroceria',
  'serialMotor',
  'marca',
  'modelo',
  'anio',
]);

/** v8: lectura fallida de un campo (rótulo o basura): no se compara. */
export function lecturaFallida(campo: string, v?: string | null): boolean {
  if (!v) return false;
  return (
    esRotuloOcr(v) || (CAMPOS_SIN_VALORES_CORTOS.has(campo) && esBasuraOcr(v))
  );
}

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
  /** v5: el aviso es solo por falta de datos de las personas (no impide ver datos cambiados). */
  sinDatos: boolean;
  /** v9: el número difiere en un dígito: comienzo del aviso (sin la conclusión). */
  avisoParecido: string | null;
}

/** Valores sin enmascarar de cada campo comparado: póliza y lo que lee ahora el documento. */
type Crudos = Record<string, { pol: string | null; doc: string | null }>;

/** v11: palabras de la forma societaria («C.A.», «S.A.», «S.R.L.»…): no cuentan en la razón social. */
const SUFIJOS_SOCIEDAD = new Set([
  'CA',
  'SA',
  'SRL',
  'RL',
  'SC',
  'SAS',
  'FP',
  'COMPANIA',
  'ANONIMA',
  'SOCIEDAD',
  'CIVIL',
  'LIMITADA',
  'RESPONSABILIDAD',
]);

/** v11: palabras de la razón social sin la forma societaria ni signos. */
export function tokensRazonSocial(v?: string | null): string[] {
  return tokens(v).filter((t) => !SUFIJOS_SOCIEDAD.has(t));
}

const CLAVES_NUMERO = [
  'identificacion',
  'documento',
  'cedula',
  'numeroDocumento',
  'numeroPasaporte',
];

function tipoDeLectura(l: Record<string, unknown>): string | null {
  return (
    pick(l, ['tipoDoc'])?.toUpperCase().slice(0, 1) ??
    tipoDocDe(pick(l, ['rif', ...CLAVES_NUMERO]))
  );
}

/**
 * v11: un archivo puede traer varios documentos (PDF de 2 páginas: RIF de la empresa y cédula de una
 * persona). Con tomador persona jurídica, la lectura principal es la del RIF (J/G/C) y la otra se
 * compara como dato complementario. Fuentes: `documentosAdicionales` (u `otrosDocumentos`) del OCR
 * y una lectura que trae a la vez `rif` jurídico e `identificacion` de otro número.
 */
export function separarLecturas(ex: Record<string, unknown>): {
  principal: Record<string, unknown>;
  complementaria: Record<string, unknown> | null;
} {
  const base: Record<string, unknown> = { ...ex };
  delete base.documentosAdicionales;
  delete base.otrosDocumentos;
  const lecturas = lecturasDelArchivo(ex);
  const juridica = lecturas.find((l) => esJuridico(tipoDeLectura(l)));
  if (!juridica) return { principal: base, complementaria: null };
  const natural =
    lecturas.find(
      (l) =>
        l !== juridica &&
        !esJuridico(tipoDeLectura(l)) &&
        !!pick(l, [...CLAVES_NUMERO, 'rif']),
    ) ?? null;
  return { principal: juridica, complementaria: natural };
}

/**
 * v12: cada documento que trae un archivo, por separado: la lectura principal (partida en dos si el
 * OCR mezcló el RIF de una página con la cédula de otra) y los `documentosAdicionales`.
 */
export function lecturasDelArchivo(
  ex: Record<string, unknown>,
): Record<string, unknown>[] {
  const base: Record<string, unknown> = { ...ex };
  delete base.documentosAdicionales;
  delete base.otrosDocumentos;
  const adicionales = [
    ...lista(ex.documentosAdicionales),
    ...lista(ex.otrosDocumentos),
  ]
    .map(rec)
    .filter((l) => Object.keys(l).length);
  let lecturas: Record<string, unknown>[] = [base];
  const rif = pick(base, ['rif']);
  const ident = pick(base, CLAVES_NUMERO);
  if (
    rif &&
    ident &&
    esJuridico(tipoDocDe(rif)) &&
    !documentosIguales(numeroDocumento(rif), numeroDocumento(ident), true)
  ) {
    // El OCR mezcló dos páginas en una lectura: el RIF por un lado y la cédula por el otro.
    const razon = pick(base, ['razonSocial']);
    const tipoBase = pick(base, ['tipoDoc'])?.toUpperCase().slice(0, 1) ?? null;
    lecturas = [
      {
        rif,
        tipoDoc: tipoDocDe(rif),
        ...(razon ? { razonSocial: razon } : {}),
      },
      {
        identificacion: ident,
        tipoDoc: tipoBase && !esJuridico(tipoBase) ? tipoBase : null,
        nombre:
          normTexto(pick(base, ['nombre'])) === normTexto(razon)
            ? null
            : pick(base, ['nombre']),
        apellido: pick(base, ['apellido']),
      },
    ];
  }
  lecturas.push(...adicionales);
  return lecturas;
}

/** v12: números de documento leídos en el archivo (todas sus lecturas), sin repetir. */
export function numerosLeidos(ex: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const l of lecturasDelArchivo(ex)) {
    for (const k of ['rif', ...CLAVES_NUMERO]) {
      const v = pick(l, [k]);
      if (!v || lecturaFallida('documento', v)) continue;
      const n = numeroDocumento(v);
      if (n && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/**
 * v12: ¿el archivo es de alguien de la póliza? true si algún número leído es el de una de sus
 * personas (también el RIF con o sin dígito verificador); false si se leyeron números y ninguno lo
 * es; null si no se leyó ningún número (no se puede saber).
 */
export function archivoEsDeLaPoliza(
  ex: Record<string, unknown>,
  ctx: ContextoPoliza,
): boolean | null {
  const nums = numerosLeidos(ex);
  if (!nums.length) return null;
  const docs = todasLasPersonas(ctx)
    .map((p) => p.documento)
    .filter((d): d is string => !!d);
  return nums.some((n) => docs.some((d) => documentosIguales(d, n, true)));
}

/** v11: ¿lo leído trae un RIF de persona jurídica (J/G/C)? (también en `documentosAdicionales`). */
export function leyoRifDelTomador(ex: Record<string, unknown>): boolean {
  return esJuridico(tipoDeLectura(separarLecturas(ex).principal));
}

/**
 * v11: cédula que viene en el mismo archivo que el RIF del tomador: se compara con las personas
 * naturales de la póliza solo como dato complementario (nunca hace fallar el documento).
 */
function camposComplementarios(
  l: Record<string, unknown>,
  naturales: PersonaPoliza[],
): CampoDiagnostico[] {
  const docRaw = pick(l, [...CLAVES_NUMERO, 'rif']);
  if (!docRaw || lecturaFallida('documento', docRaw)) return [];
  const tipoL = tipoDeLectura(l);
  const num = numeroDocumento(docRaw);
  const p = naturales.find(
    (x) => !!x.documento && documentosIguales(x.documento, num, false),
  );
  if (!p) {
    return [
      {
        campo: 'adicionalDocumento',
        etiqueta: 'Cédula adicional en el archivo (no es de la póliza)',
        enPoliza: null,
        enDocumento: maskDocumento(tipoL, num),
        coincide: false,
        estado: 'difiere',
      },
    ];
  }
  const quien = p.roles.includes('asegurado')
    ? p.titular
      ? 'titular'
      : 'asegurado'
    : p.rol;
  const out: CampoDiagnostico[] = [
    {
      campo: 'adicionalDocumento',
      etiqueta: `Cédula adicional en el archivo (${quien})`,
      enPoliza: maskDocumento(p.tipoDoc, p.documento),
      enDocumento: maskDocumento(tipoL, num),
      coincide: true,
      estado: 'coincide',
    },
  ];
  const nombreL = [
    pick(l, ['nombre', 'nombres']),
    pick(l, ['apellido', 'apellidos']),
  ]
    .filter((v) => v && !esSexoOEstadoCivil(v))
    .join(' ');
  const nombreP = [p.nombre, p.apellido].filter(Boolean).join(' ');
  if (nombreL && nombreP) {
    const igual = contenido(tokens(nombreL), tokens(nombreP));
    out.push({
      campo: 'adicionalNombre',
      etiqueta: `Nombre en la cédula adicional (${quien})`,
      enPoliza: nombreP,
      enDocumento: nombreL,
      coincide: igual ? true : false,
      estado: igual ? 'coincide' : 'difiere',
    });
  }
  return out;
}

/**
 * v12: «la cédula del titular», «el RIF de la empresa tomadora»… para decir en lenguaje simple de
 * quién es el archivo cargado.
 */
function documentoDe(p: PersonaPoliza, tipoLeido?: string | null): string {
  if (esJuridico(p.tipoDoc))
    return p.roles.includes('tomador')
      ? 'el RIF de la empresa tomadora'
      : 'el RIF de una empresa de la póliza';
  const doc =
    String(tipoLeido ?? '').toUpperCase() === 'P'
      ? 'el pasaporte'
      : 'la cédula';
  if (p.roles.includes('tomador')) return `${doc} del tomador`;
  if (p.roles.includes('asegurado'))
    return p.titular
      ? `${doc} del titular`
      : `${doc} de otro asegurado de la póliza`;
  if (p.roles.includes('beneficiario')) return `${doc} de un beneficiario`;
  return `${doc} del ${p.rol}`;
}

/** v12: «Falta la cédula del titular. El archivo cargado es la cédula del tomador (V-****1234).» */
function textoFaltaOtro(
  pedido: string,
  p: PersonaPoliza,
  tipoLeido?: string | null,
): string {
  const mask = maskDocumento(p.tipoDoc ?? tipoLeido, p.documento);
  return `Falta ${pedido}. El archivo cargado es ${documentoDe(p, tipoLeido)}${mask ? ` (${mask})` : ''}.`;
}

function compararPersona(
  tipo: string,
  exLeido: Record<string, unknown>,
  ctx: ContextoPoliza,
  hoy: string,
): ComparacionPersona {
  // v11: en personas, `cedula` es el documento del TOMADOR y solo se compara con él; con tomador
  // empresa vale su RIF. Si el archivo trae el RIF y además una cédula, manda el RIF y la cédula es
  // complementaria. Si no se leyó el RIF, lo leído (una cédula) es solo complementario.
  const enPersonas = cedulaDePersonas(tipo, ctx);
  /** v12: personas — la cédula del titular se compara solo con el titular. */
  const titularPersonas =
    tipo === 'cedula_titular' && ctx.producto === 'personas';
  const tomJ = enPersonas ? tomadorJuridico(ctx) : null;
  let lecturas: {
    principal: Record<string, unknown>;
    complementaria: Record<string, unknown> | null;
  } = { principal: exLeido, complementaria: null };
  /** v11: tomador empresa y en el archivo no se leyó un RIF jurídico. */
  let rifNoLeido = false;
  if (tomJ) {
    lecturas = separarLecturas(exLeido);
    if (!esJuridico(tipoDeLectura(lecturas.principal))) {
      rifNoLeido = true;
      lecturas = { principal: {}, complementaria: lecturas.principal };
    }
  }
  const ex = lecturas.principal;
  const rifLeido = pick(ex, ['rif']);
  const docLeido =
    pick(ex, [
      'identificacion',
      'documento',
      'cedula',
      'numeroDocumento',
      'numeroPasaporte',
    ]) ?? rifLeido;
  // v8: un rótulo («CEDULA») o basura («V») en el número es lectura fallida: no se compara.
  const docFallido = lecturaFallida('documento', docLeido);
  const rifOcr = docFallido ? null : rifLeido;
  const docRaw = docFallido ? null : docLeido;
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
  const reglas = enPersonas
    ? { esperados: ['tomador', 'asegurado'] as RolPersona[], respaldo: [] }
    : (ROLES_DOCUMENTO[tipo] ?? ROLES_DOCUMENTO.cedula);
  const conRol = (roles: RolPersona[]) => {
    const out: PersonaPoliza[] = [];
    // v7: también las personas adicionales (mesa técnica, cotización), fuera de la huella.
    for (const r of roles)
      for (const p of todas)
        if (p.documento && p.roles.includes(r) && !out.includes(p)) out.push(p);
    return out;
  };
  let objetivos: PersonaPoliza[];
  let respaldo: RolPersona | null = null;
  const naturales = todas.filter(
    // El asegurado guardado en el expediente puede ser el mismo tomador J (sin titular): las
    // personas jurídicas nunca cuentan como naturales.
    (p) =>
      !!p.documento &&
      !esJuridico(p.tipoDoc) &&
      (p.roles.includes('asegurado') || p.roles.includes('tomador')),
  );
  /** v12: la cédula del titular, sin nadie con quien compararla (ni titular ni asegurados). */
  let sinTitular = false;
  if (enPersonas) {
    // v11: con tomador J/G/C el documento del tomador se compara SOLO con el tomador (RIF y razón
    // social), nunca con el asegurado. v12: con tomador natural y un titular distinto en la póliza
    // (la cédula del titular es otro requisito), también solo con el tomador. Si la póliza no trae
    // al tomador o no trae un titular aparte (un solo requisito para los dos), como en v4: con las
    // personas naturales de la póliza.
    const tomadores = naturales.filter((p) => p.roles.includes('tomador'));
    const titularAparte = ctx.personas.some(
      (p) =>
        p.titular &&
        !!p.documento &&
        !esJuridico(p.tipoDoc) &&
        !p.roles.includes('tomador'),
    );
    objetivos = tomJ
      ? [tomJ]
      : tomadores.length && titularAparte
        ? tomadores
        : naturales;
  } else if (titularPersonas) {
    // v12: solo el titular; si Nexus no sabe quién es, los asegurados; sin asegurados, el tomador
    // natural (respaldo).
    const titulares = naturales.filter((p) => p.titular);
    objetivos = titulares.length
      ? titulares
      : naturales.filter((p) => p.roles.includes('asegurado'));
    if (!objetivos.length) {
      const tomadores = naturales.filter((p) => p.roles.includes('tomador'));
      if (tomadores.length) {
        objetivos = tomadores;
        respaldo = 'tomador';
      } else sinTitular = true;
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
  const porPersona = enPersonas || titularPersonas;
  const exacto = docOcr
    ? porPersona
      ? (objetivos.find(igualA) ?? todas.find(igualA) ?? null)
      : (todas.find(igualA) ?? null)
    : null;
  const persona =
    exacto && objetivos.includes(exacto)
      ? exacto
      : porPersona
        ? // Sin coincidencia exacta: la que difiere en un dígito (posible error de lectura) o la
          // primera; sin personas naturales no se compara contra el tomador J.
          (objetivos.find((p) => casiIgual(docOcr, docDe(p))) ??
          objetivos[0] ??
          null)
        : (objetivos[0] ?? todas.find((p) => p.documento) ?? todas[0] ?? null);
  const rol = persona ? rolDe(persona) : null;

  const campos: CampoDiagnostico[] = [];
  /** v11: RIF de persona jurídica contra el tomador empresa: razón social tolerante. */
  const rifJuridico =
    esJuridico(persona?.tipoDoc) && (enPersonas || esJuridico(tipoOcr));
  const etiquetaDoc = rifJuridico
    ? 'Número de RIF'
    : (ETIQUETA_DOC[tipo] ?? 'Número de documento');

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

  // v10: un nombre o apellido que es solo sexo o estado civil («MASCULINO»; foto girada) no se
  // leyó: no se compara ni cuenta como dato del documento.
  const original = (k: string[]) => {
    for (const key of k) {
      const v = pick(ex, [key]);
      if (v && !esSexoOEstadoCivil(v)) return v;
    }
    return null;
  };
  // v11: de una empresa se lee la razón social (sin «C.A.», «S.A.»…, puntos ni mayúsculas).
  const clavesNombre = rifJuridico
    ? ['razonSocial', 'nombre', 'nombres']
    : ['nombre', 'nombres', 'razonSocial'];
  const tk = rifJuridico ? tokensRazonSocial : tokens;
  const nOcr = tk(original(clavesNombre));
  const aOcr = tokens(original(['apellido', 'apellidos']));
  // v13: el nombre REGISTRADO de una persona natural que es solo sexo o estado civil («Masculino»)
  // es sin dato, igual que en lo leído. Nunca en empresas (razón social) ni por prefijo suelto.
  let nombrePol = persona?.nombre ?? null;
  let apellidoPol = persona?.apellido ?? null;
  /** v13: palabra registrada como nombre que no es un nombre. */
  let noEsNombre: string | null = null;
  if (persona && !rifJuridico && !esJuridico(persona.tipoDoc)) {
    if (nombrePol && esSexoOEstadoCivil(nombrePol)) {
      noEsNombre = nombrePol;
      nombrePol = null;
    }
    if (apellidoPol && esSexoOEstadoCivil(apellidoPol)) {
      noEsNombre ??= apellidoPol;
      apellidoPol = null;
    }
    // Nombre completo en un solo campo que empieza por el sexo o el estado civil («Masculino
    // RODRIGUEZ PEÑA»): se quita esa palabra solo con cédula V/E, el mismo número y si el resto es
    // el apellido leído; lo que queda es el apellido.
    const palabras = (nombrePol ?? '').trim().split(/\s+/).filter(Boolean);
    const resto = palabras.slice(1).join(' ');
    if (
      !apellidoPol &&
      palabras.length >= 2 &&
      PREFIJO_SEXO_ESTADO_CIVIL.has(normTexto(palabras[0])) &&
      ['V', 'E'].includes(String(persona.tipoDoc ?? '').toUpperCase()) &&
      !!docOcr &&
      documentosIguales(docDe(persona), docOcr, conDv) &&
      aOcr.length > 0 &&
      tokens(resto).length > 0 &&
      contenido(tokens(resto), aOcr)
    ) {
      noEsNombre = palabras[0];
      nombrePol = null;
      apellidoPol = resto;
    }
  }
  const nPol = tk(nombrePol);
  const aPol = tokens(apellidoPol);
  const todosOcr = [...nOcr, ...aOcr];
  const todosPol = [...nPol, ...aPol];
  const comunes = todosOcr.filter((t) =>
    todosPol.some((u) => palabraIgual(t, u)),
  ).length;
  const completo =
    contenido(todosOcr, todosPol) &&
    comunes >= Math.min(2, todosOcr.length, todosPol.length);
  campos.push(
    campo(
      'nombre',
      rifJuridico ? 'Razón social' : 'Nombre',
      nombrePol,
      original(clavesNombre),
      () => contenido(nOcr, nPol) || completo,
    ),
  );
  if (!rifJuridico && (aOcr.length || aPol.length)) {
    campos.push(
      campo(
        'apellido',
        'Apellido',
        apellidoPol,
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
  /** v9: comienzo del aviso de un dígito distinto, para precisarlo con lo leído en el wizard. */
  let avisoParecido: string | null = null;
  let nota: string | null = null;
  let sinDatos = false;
  const sinTomador =
    enPersonas && !todas.some((p) => p.roles.includes('tomador'));
  // El OCR devolvió el rótulo del campo («nombre») en vez del dato: lectura fallida.
  // v8: también el número del documento (rótulo o basura).
  const rotulo = [
    original(['nombre', 'nombres', 'razonSocial']),
    original(['apellido', 'apellidos']),
  ].some((v) => esRotuloOcr(v));
  if (rifNoLeido && tomJ && lecturas.complementaria) {
    // v11: tomador empresa y en el archivo no se leyó su RIF (p. ej. PDF con el RIF en la página 1 y
    // la cédula del titular en la 2: el OCR devolvió la cédula). No se compara con el asegurado ni
    // se marca «Errado»: la cédula leída es solo complementaria (informativa); revisar.
    // v12: en lenguaje simple, de quién es el archivo cargado.
    const l = lecturas.complementaria;
    const numRaw = pick(l, [...CLAVES_NUMERO, 'rif']);
    const tipoL = tipoDeLectura(l);
    const num =
      numRaw && !lecturaFallida('documento', numRaw)
        ? numeroDocumento(numRaw)
        : '';
    const de = num
      ? naturales.find((x) => documentosIguales(x.documento ?? '', num, true))
      : undefined;
    const pedido = 'el RIF de la empresa tomadora';
    aviso = de
      ? textoFaltaOtro(pedido, de, tipoL)
      : num
        ? `Falta ${pedido}. El archivo cargado es ${tipoL === 'P' ? 'un pasaporte' : 'una cédula'} (${maskDocumento(tipoL, num)}) que no es de nadie de esta póliza.`
        : `Falta ${pedido}: no se leyó en el archivo cargado.`;
  } else if (sinTitular) {
    aviso =
      'No se pudo comparar: la póliza no trae en Nexus los datos del titular.';
    sinDatos = true;
  } else if (rotulo || docFallido) {
    const noLeido = [
      ...(docFallido ? ['el número'] : []),
      ...(rotulo ? ['el nombre'] : []),
    ].join(' ni ');
    aviso = `El OCR no leyó ${noLeido} del documento (devolvió el rótulo del campo o un valor sin sentido); hay que revisarlo.`;
  } else if (
    exacto &&
    !objetivos.includes(exacto) &&
    // v12 (personas): solo si el nombre leído es el de esa persona; con el número de otra persona de
    // la póliza y otro nombre sigue siendo «no coincide» (como en v4).
    (!porPersona ||
      !todosOcr.length ||
      contenido(todosOcr, [
        ...tokens(exacto.nombre),
        ...tokens(exacto.apellido),
      ]) ||
      !(exacto.nombre || exacto.apellido))
  ) {
    // Es de otra persona de la póliza: no es un documento falso, pero tampoco el pedido.
    // v11: en personas el documento `cedula` es solo del tomador. v12: y la cédula del titular, solo
    // del titular; el texto dice qué falta y de quién es el archivo cargado.
    aviso = enPersonas
      ? textoFaltaOtro(
          tomJ ? 'el RIF de la empresa tomadora' : 'la cédula del tomador',
          exacto,
          tipoOcr,
        )
      : titularPersonas
        ? textoFaltaOtro('la cédula del titular', exacto, tipoOcr)
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
    // v9: la máscara de los últimos 4 podía mostrar dos números iguales; se deja ver el dígito
    // que cambia y se dice en qué posición. Texto neutral: no se culpa al OCR.
    const nDoc = numeroDocumento(docOcr);
    const nPol = numeroDocumento(docDe(persona));
    const pos = posicionDigitoDistinto(nDoc, nPol);
    if (tipo !== 'pasaporte') {
      docCampo.enDocumento = maskDocumentoConDigito(tipoOcr, docOcr, pos);
      docCampo.enPoliza = maskDocumentoConDigito(persona.tipoDoc, docPol, pos);
    }
    const cual = pos
      ? `difiere en el ${ordinalDigito(pos)} dígito del`
      : nDoc.length > nPol.length
        ? 'tiene un dígito de más respecto del'
        : 'tiene un dígito de menos respecto del';
    avisoParecido =
      `El número del documento (${docCampo.enDocumento}) ${cual} registrado para el ` +
      `${rol ?? 'titular'} (${docCampo.enPoliza}) y el nombre coincide`;
    aviso =
      `${avisoParecido}: puede ser un error de lectura del documento o de transcripción en el ` +
      'formulario; revisar cuál es el correcto.';
  } else if (respaldo) {
    const sinRol = `La póliza no trae la cédula del ${esperadoTexto}; se comparó con la del ${respaldo}.`;
    if (docCampo.coincide === false) aviso = sinRol;
    else nota = sinRol;
  } else if (sinTomador && !exacto && docCampo.coincide === false && rol) {
    // Personas sin datos del tomador: la cédula puede ser la suya; no se afirma que no coincide.
    aviso = `La póliza no trae la cédula del tomador; se comparó con la del ${rol}.`;
  } else if (
    // v5: Nexus no conoce a las demás personas (sin titular ni asegurados aparte del tomador en
    // ninguna fuente; sin conductor para la licencia RCV). Un documento de persona natural que no
    // es del tomador puede ser de alguna de ellas: no se afirma que no coincide; revisar. (v11: en
    // personas no valida contra nadie más que el tomador; solo evita el «Errado».)
    !exacto &&
    !!docOcr &&
    docCampo.coincide === false &&
    !esJuridico(tipoOcr) &&
    (enPersonas
      ? !conoceAsegurados(todas)
      : tipo === 'licencia' &&
        !todas.some((p) => !!p.documento && p.roles.includes('conductor')))
  ) {
    sinDatos = true;
    aviso = enPersonas
      ? 'No se pudo comparar: la póliza no trae los asegurados en Nexus y el documento no es del tomador; puede ser de un asegurado.'
      : 'No se pudo comparar: la póliza no trae los datos del conductor en Nexus y la licencia no es del tomador ni del titular; puede ser del conductor habitual.';
  }
  // v13: nombre registrado que no es un nombre (sexo o estado civil): se dice en simple y no hace
  // fallar el documento; sin ningún nombre con que confirmar, revisar (el número solo no valida).
  if (noEsNombre) {
    const dicho = `En el registro el nombre del ${rol ?? 'titular'} quedó como «${noEsNombre}», que no es un nombre: no se tomó en cuenta.`;
    if (!aviso && !todosPol.length && docCampo.coincide === true)
      aviso = `El número del documento coincide. ${dicho} Falta confirmar el nombre.`;
    else if (!aviso) nota = nota ? `${nota} ${dicho}` : dicho;
  }
  const crudos: Crudos = {
    tipoDoc: { pol: persona?.tipoDoc ?? null, doc: tipoOcr ?? null },
    documento: {
      pol: persona ? docDe(persona) || null : null,
      doc: docOcr || null,
    },
    nombre: {
      pol: nombrePol,
      doc: original(clavesNombre),
    },
    apellido: {
      pol: apellidoPol,
      doc: original(['apellido', 'apellidos']),
    },
  };
  // v11: la cédula que viene con el RIF del tomador en el mismo archivo: dato complementario.
  if (lecturas.complementaria)
    campos.push(...camposComplementarios(lecturas.complementaria, naturales));
  return {
    campos,
    rol,
    rolEsperado,
    aviso,
    nota,
    crudos,
    conDv,
    respaldo: !!respaldo,
    sinDatos,
    avisoParecido,
  };
}

/** v8: identidad del vehículo (los únicos que dan no_coincide o datos cambiados). */
const CLAVE_VEHICULO = ['placa', 'serialCarroceria'];

function compararVehiculo(
  exLeido: Record<string, unknown>,
  ctx: ContextoPoliza,
): {
  campos: CampoDiagnostico[];
  crudos: Crudos;
  /** v8: campos clave que el OCR no leyó (rótulo o basura). */
  claveNoLeida: CampoDiagnostico[];
} {
  const v = vehiculoDe(ctx) ?? {};
  // v8: rótulos y basura del OCR no se comparan (lectura fallida del campo).
  const fallidos = new Set<string>();
  const CAMPO_DE_CLAVE: Record<string, string> = {
    placa: 'placa',
    xplaca: 'placa',
    serialCarroceria: 'serialCarroceria',
    serial_carroceria: 'serialCarroceria',
    serial: 'serialCarroceria',
    serialNiv: 'serialCarroceria',
    serialMotor: 'serialMotor',
    serial_motor: 'serialMotor',
    marca: 'marca',
    modelo: 'modelo',
    linea: 'modelo',
    anio: 'anio',
    año: 'anio',
    ano: 'anio',
  };
  const ex: Record<string, unknown> = { ...exLeido };
  for (const [k, c] of Object.entries(CAMPO_DE_CLAVE)) {
    const val = texto(ex[k]);
    if (val && lecturaFallida(c, val)) {
      delete ex[k];
      fallidos.add(c);
    }
  }
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
  // v8: motor, marca, modelo (catálogo cmarca/cmodelo del formulario), año y propietario son
  // informativos: se muestran como «difiere», pero no marcan el documento como errado.
  for (const c of campos) {
    if (CLAVE_VEHICULO.includes(c.campo)) continue;
    if (c.estado === 'no_coincide' || c.estado === 'parecido') {
      c.estado = 'difiere';
      c.coincide = false;
    }
  }
  const claveNoLeida = campos.filter(
    (c) =>
      CLAVE_VEHICULO.includes(c.campo) &&
      fallidos.has(c.campo) &&
      c.enDocumento == null,
  );
  const crudos: Crudos = {
    placa: { pol: placaPol, doc: placaDoc },
    serialCarroceria: { pol: carrPol, doc: carrDoc },
    serialMotor: { pol: motorPol, doc: motorDoc },
    marca: { pol: marcaPol, doc: marcaDoc },
    modelo: { pol: modeloPol, doc: modeloDoc },
    anio: { pol: anioPol, doc: anioDoc },
  };
  return { campos, crudos, claveNoLeida };
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
  o: {
    conDv: boolean;
    detectar: boolean;
    /** v8: solo estos campos pueden quedar como cambiados (certificado: placa y carrocería). */
    soloEn?: string[];
    /** v10: diferencia explicada (misma persona): no es un dato cambiado. */
    tolerado?: (campo: string, pol: string, leido: string) => boolean;
  },
): CampoDiagnostico[] {
  const out: CampoDiagnostico[] = [];
  for (const c of campos) {
    const clave = CLAVE_OCR_LEIDO[c.campo];
    const leido = clave ? texto(ol[clave]) : null;
    if (!leido) continue;
    c.enOcrAlEmitir = mostrarOcrLeido(c.campo, leido, ol, tipo);
    const cr = crudos[c.campo];
    if (!o.detectar || !cr?.pol) continue;
    if (o.soloEn && !o.soloEn.includes(c.campo)) continue;
    // v8: el OCR al emitir devolvió un rótulo o basura: lectura fallida, no un dato cambiado.
    if (lecturaFallida(c.campo, leido)) continue;
    const igual = (a: string, b: string) =>
      mismoDato(c.campo, a, b, { tipo, conDv: o.conDv });
    const difiere = cr.doc
      ? c.estado === 'no_coincide'
      : c.estado === 'sin_dato_documento' && !igual(cr.pol, leido);
    if (!difiere) continue;
    if (o.tolerado?.(c.campo, cr.pol, leido)) continue;
    // Lo leído al emitir es lo que dice el documento: no es una lectura distinta del OCR.
    if (cr.doc && !igual(cr.doc, leido)) continue;
    c.estado = 'modificado_en_formulario';
    c.coincide = false;
    out.push(c);
  }
  return out;
}

/**
 * v10: apellido de casada: «MANTILLA DE BADILLO» (licencia) frente a «MANTILLA AMAYA» (cédula):
 * mismo primer apellido y uno de los dos sigue con «DE …» (18-1-0000144235).
 */
export function apellidoDeCasada(
  a?: string | null,
  b?: string | null,
): boolean {
  const pa = normTexto(a).split(' ').filter(Boolean);
  const pb = normTexto(b).split(' ').filter(Boolean);
  if (pa.length < 2 || pb.length < 2 || !palabraIgual(pa[0], pb[0]))
    return false;
  const casada = (p: string[]) => p[1] === 'DE' && p.length >= 3;
  return (casada(pa) && !casada(pb)) || (casada(pb) && !casada(pa));
}

/** Requisitos con la cédula (o pasaporte) de una persona, donde se lee su nombre «oficial». */
const TIPOS_CEDULA = [
  'cedula',
  'cedula_titular',
  'cedula_beneficiario',
  'pasaporte',
];

/**
 * v10: lo que el OCR leyó (al emitir o al escanear en el wizard) de la cédula de la persona con
 * este número, en otro requisito de la misma póliza.
 */
function leidoEnCedulas(
  ctx: ContextoPoliza,
  tipo: string,
  documento: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const fuente of [ctx.ocrLeido, ctx.ocrLeidoCotizacion]) {
    for (const t of TIPOS_CEDULA) {
      if (t === tipo) continue;
      const ol = rec(fuente?.[t]);
      const doc = texto(ol.documento);
      if (doc && numeroDocumento(doc) === numeroDocumento(documento))
        out.push(ol);
    }
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
    ...auditoriaModelo(ocr),
  };
  const motivoOcr = texto(ocr?.motivo)?.slice(0, 300) ?? null;

  if (ocr?.falla === 'tecnica') {
    return {
      ...diagnosticoErrorTecnico(
        tipo,
        motivoOcr ?? 'El OCR no pudo leer el documento.',
        {
          ahora,
          motivoAnalisis: opts.motivoAnalisis,
          proveedor: base.proveedor,
        },
      ),
      ...auditoriaModelo(ocr),
    };
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
  let sinDatos = false;
  let avisoParecido: string | null = null;
  let claveNoLeida: CampoDiagnostico[] = [];
  if (tipo === 'certificado') {
    const r = compararVehiculo(ex, ctx);
    campos = r.campos;
    crudos = r.crudos;
    claveNoLeida = r.claveNoLeida;
    rol = 'vehiculo';
    clave = CLAVE_VEHICULO;
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
    sinDatos = r.sinDatos;
    avisoParecido = r.avisoParecido;
    clave = ['documento'];
  }
  const conNota = (t: string) => (nota ? `${t} ${nota}` : t);

  // v3: lo que el OCR leyó al emitir. Sin él (emisiones viejas) todo sigue como antes. Con la
  // persona de respaldo o un documento de otra persona de la póliza no se afirma que se cambió.
  // v7: si el expediente no trae lo leído de este documento, lo de la cotización del wizard.
  const ol = rec(ctx.ocrLeido?.[tipo] ?? ctx.ocrLeidoCotizacion?.[tipo]);

  // v10: misma persona (el número del documento coincide con el de la póliza): un nombre o apellido
  // distinto que es el que el OCR leyó en su cédula, o un apellido de casada, es informativo.
  const docPolIdent = crudos.documento?.pol ?? null;
  const leidoDocOl = texto(ol.documento);
  const mismaPersona =
    TIPOS_PERSONA.has(tipo) &&
    !!docPolIdent &&
    (campos.some((c) => c.campo === 'documento' && c.coincide === true) ||
      (!!leidoDocOl &&
        !lecturaFallida('documento', leidoDocOl) &&
        mismoDato('documento', leidoDocOl, docPolIdent, { tipo, conDv })));
  const cedulasMismaPersona =
    mismaPersona && docPolIdent ? leidoEnCedulas(ctx, tipo, docPolIdent) : [];
  const tolerado = (c: string, pol: string, doc: string): boolean => {
    if (!mismaPersona || (c !== 'nombre' && c !== 'apellido')) return false;
    if (c === 'apellido' && apellidoDeCasada(pol, doc)) return true;
    return cedulasMismaPersona.some((o) => {
      const enCedula = texto(o[c]);
      return (
        !!enCedula &&
        !esSexoOEstadoCivil(enCedula) &&
        mismoDato(c, pol, enCedula, { tipo, conDv })
      );
    });
  };
  for (const c of campos) {
    const cr = crudos[c.campo];
    if (
      c.estado === 'no_coincide' &&
      cr?.pol &&
      cr.doc &&
      tolerado(c.campo, cr.pol, cr.doc)
    ) {
      c.estado = 'difiere';
      c.coincide = false;
    }
  }

  const modificados = Object.keys(ol).length
    ? marcarModificados(tipo, campos, crudos, ol, {
        conDv,
        // v8: licencia sin datos del conductor: se comparó con el tomador o el titular, pero puede
        // ser del conductor habitual; no se afirma que la cédula se cambió en el formulario.
        detectar:
          (!aviso || (sinDatos && tipo !== 'licencia')) &&
          !respaldo &&
          !(tipo === 'certificado' && !vehiculoDe(ctx)),
        soloEn: tipo === 'certificado' ? CLAVE_VEHICULO : undefined,
        tolerado,
      })
    : [];
  // v13 (7-7-7000003208: «JHON» en la cédula y «RAMON» registrado, mismo número): con el mismo
  // número de documento y el apellido coincidente es la misma persona; un nombre de pila distinto
  // (el OCR devuelve el primer nombre y la póliza puede traer el segundo) es informativo. Va
  // después de los datos cambiados en el formulario, que se siguen avisando. Con otro número u otro
  // apellido no aplica: una cédula ajena sigue saliendo errada.
  if (
    TIPOS_PERSONA.has(tipo) &&
    campos.some((c) => c.campo === 'documento' && c.coincide === true) &&
    campos.some((c) => c.campo === 'apellido' && c.coincide === true)
  ) {
    for (const c of campos) {
      if (c.campo === 'nombre' && c.estado === 'no_coincide') {
        c.estado = 'difiere';
        c.coincide = false;
      }
    }
  }

  // v9: un dígito distinto y lo que leyó el OCR del wizard al escanear: si leyó lo mismo que trae
  // la póliza, la diferencia es entre lecturas del documento; si leyó otro número, la cédula se
  // cambió en el formulario.
  const leidoDoc = texto(ol.documento);
  const docPolCrudo = crudos.documento?.pol;
  if (
    avisoParecido &&
    leidoDoc &&
    docPolCrudo &&
    !lecturaFallida('documento', leidoDoc)
  ) {
    const igualPol = mismoDato('documento', leidoDoc, docPolCrudo, {
      tipo,
      conDv,
    });
    aviso = igualPol
      ? `${avisoParecido}. El OCR del formulario leyó el mismo número que trae la póliza: la diferencia es entre las lecturas del documento; revisar la imagen.`
      : `${avisoParecido}. El OCR del formulario leyó otro número (${mostrarOcrLeido('documento', leidoDoc, ol, tipo) ?? 'distinto'}) y la póliza trae uno distinto: la cédula se cambió en el formulario; revisar cuál es el correcto.`;
  }

  // v8: los informativos del vehículo (`difiere`) no cuentan como error.
  const fallan = campos.filter(
    (c) => c.coincide === false && c.estado !== 'difiere',
  );
  const difieren = campos.filter((c) => c.estado === 'difiere');
  const parecidos = campos.filter((c) => c.estado === 'parecido');
  const coinciden = campos.filter((c) => c.coincide === true);
  const rolTexto = rol === 'vehiculo' || !rol ? 'asegurado' : rol;
  const informativo = difieren.length
    ? ` Difiere (informativo, no cuenta): ${listaEtiquetas(difieren)}.`
    : '';
  // v8: un campo clave del vehículo que el OCR no leyó (devolvió el rótulo o basura).
  const avisoNoLeida = claveNoLeida.length
    ? `El OCR no leyó ${claveNoLeida.map((c) => articuloCampo(tipo, c)).join(' ni ')} ${DEL_DOCUMENTO[tipo] ?? 'del documento'} (devolvió el rótulo del campo o un valor sin sentido); hay que revisarlo.`
    : null;

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
    // v6: si además falla otra cosa (p. ej. vencida), el motivo empieza por ese error y no por el
    // aviso: un no_coincide no puede leerse como «No se pudo comparar…».
    return {
      ...base,
      resultado: otros.length ? 'no_coincide' : 'sin_certeza',
      campos,
      resumen: [
        ...otros.map((c) => fraseDiferencia(tipo, c, rolTexto)),
        // v11: lo informativo (p. ej. el nombre de la cédula leída con tomador empresa).
        aviso + informativo,
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
    if (avisoNoLeida) frases.push(avisoNoLeida);
    return {
      ...base,
      resultado: 'no_coincide',
      campos,
      resumen: conNota(frases.join(' ')),
      comparadoCon: rol,
    };
  }

  if (avisoNoLeida && vehiculoDe(ctx)) {
    return {
      ...base,
      resultado: 'sin_certeza',
      campos,
      resumen: avisoNoLeida + informativo,
      comparadoCon: rol,
    };
  }

  const claveOk = campos.some((c) => clave.includes(c.campo) && c.coincide);
  if (!campos.length || !claveOk) {
    const c = campos.find((x) => clave.includes(x.campo));
    let resumen: string;
    if (!campos.length || (tipo === 'certificado' && !vehiculoDe(ctx))) {
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
      resumen: resumen + informativo,
      comparadoCon: rol,
    };
  }
  if (parecidos.length) {
    return {
      ...base,
      resultado: 'sin_certeza',
      campos,
      resumen: `${listaEtiquetas(parecidos)}: casi igual a la póliza (un carácter distinto).${informativo}`,
      comparadoCon: rol,
    };
  }
  if (confianza == null || confianza < CONFIANZA_ALTA) {
    return {
      ...base,
      resultado: 'sin_certeza',
      campos,
      resumen:
        'Los datos coinciden, pero la lectura del documento fue parcial.' +
        informativo,
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
          : '') +
        informativo,
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
    // Los informativos (`difiere`) no cuentan.
    const otros = d.campos.filter(
      (c) =>
        c.coincide === false &&
        c.campo !== 'vencimiento' &&
        c.estado !== 'difiere',
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
