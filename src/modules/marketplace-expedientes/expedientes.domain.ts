/**
 * Reglas puras del monitor de expedientes (sin BD): estados, alcance,
 * cadencia, enmascarado y comparación OCR vs snapshot.
 */

export const ESTADOS_REQUISITO = [
  'faltante',
  'recibido',
  'observado',
  'validado',
  /** La emisión no informó documentos (registro viejo o personas sin wizard). No es faltante. */
  'sin_informacion',
] as const;
export type EstadoRequisito = (typeof ESTADOS_REQUISITO)[number];

/** sin_informacion: no hay datos para saber si falta algo; no es incompleto ni recibe recordatorios. */
export type EstadoDocumental = 'completo' | 'incompleto' | 'sin_informacion';
export type EstadoPago = 'pagada' | 'pendiente';
export type ProductoExpediente = 'rcv' | 'personas' | 'patrimonial';
export type AreaExpediente = 'canal' | 'gestor' | 'productor' | 'desconocida';

export interface AlcanceConfig {
  canales: boolean;
  gestores: boolean;
  productores: boolean;
  /** Pólizas sin metadata de vendedor (registros viejos). */
  desconocida: boolean;
}

export interface ExpedientesConfig {
  alcance: AlcanceConfig;
  validacion: 'manual' | 'automatica';
  cadenciaDias: number[];
  destinatariosResumen: string[];
  horaDiaria: string;
  horaResumen: string;
  requisitosPorProducto: Record<string, string[]>;
}

export const DEFAULT_CONFIG: ExpedientesConfig = {
  alcance: {
    canales: true,
    gestores: true,
    productores: false,
    desconocida: true,
  },
  validacion: 'manual',
  cadenciaDias: [0, 3, 7, 14],
  destinatariosResumen: [],
  horaDiaria: '08:00',
  horaResumen: '23:00',
  requisitosPorProducto: {
    rcv: ['cedula', 'licencia', 'certificado'],
    personas: ['cedula'],
    patrimonial: ['cedula'],
  },
};

/** Las 8 claves de documento de la mesa técnica. */
export const REQUISITO_LABELS: Record<string, string> = {
  cedula: 'Cédula de identidad',
  cedula_titular: 'Cédula del titular',
  cedula_beneficiario: 'Cédula del beneficiario',
  licencia: 'Licencia de conducir',
  certificado: 'Certificado de circulación',
  rif: 'RIF',
  pasaporte: 'Pasaporte',
  factura: 'Factura',
};

export function requisitoLabel(tipo: string): string {
  return REQUISITO_LABELS[tipo] ?? tipo;
}

export function mergeConfig(raw: unknown): ExpedientesConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    ExpedientesConfig & { alcance: Partial<AlcanceConfig> }
  >;
  return {
    alcance: { ...DEFAULT_CONFIG.alcance, ...(r.alcance ?? {}) },
    validacion:
      r.validacion === 'automatica' || r.validacion === 'manual'
        ? r.validacion
        : DEFAULT_CONFIG.validacion,
    cadenciaDias:
      Array.isArray(r.cadenciaDias) && r.cadenciaDias.length
        ? [...r.cadenciaDias].map(Number).sort((a, b) => a - b)
        : [...DEFAULT_CONFIG.cadenciaDias],
    destinatariosResumen: Array.isArray(r.destinatariosResumen)
      ? r.destinatariosResumen.map(String)
      : [],
    horaDiaria: r.horaDiaria || DEFAULT_CONFIG.horaDiaria,
    horaResumen: r.horaResumen || DEFAULT_CONFIG.horaResumen,
    requisitosPorProducto: {
      ...DEFAULT_CONFIG.requisitosPorProducto,
      ...(r.requisitosPorProducto ?? {}),
    },
  };
}

// ─── Producto, área y alcance ──────────────────────────────────────────────

export function normalizarProducto(
  producto?: string | null,
  hint?: string | null,
): ProductoExpediente {
  const h = String(hint ?? '')
    .trim()
    .toLowerCase();
  if (h === 'rcv' || h === 'personas' || h === 'patrimonial') return h;
  const p = String(producto ?? '').toLowerCase();
  if (p.includes('rcv')) return 'rcv';
  if (p.includes('patrimon')) return 'patrimonial';
  return 'personas';
}

/** C = canal alterno, G = gestor, P = productor (P con cgestor = gestor). */
export function areaDesdeVendedor(v: {
  centidad?: string | null;
  cgestor?: string | null;
  ccanalalt?: string | null;
}): AreaExpediente {
  const c = String(v.centidad ?? '')
    .trim()
    .toUpperCase();
  if (c === 'C') return 'canal';
  if (c === 'G') return 'gestor';
  if (c === 'P') return v.cgestor ? 'gestor' : 'productor';
  if (v.cgestor) return 'gestor';
  if (v.ccanalalt) return 'canal';
  return 'desconocida';
}

export function areasEnAlcance(alcance: AlcanceConfig): AreaExpediente[] {
  const out: AreaExpediente[] = [];
  if (alcance.canales) out.push('canal');
  if (alcance.gestores) out.push('gestor');
  if (alcance.productores) out.push('productor');
  if (alcance.desconocida) out.push('desconocida');
  return out;
}

export function enAlcance(area: string, alcance: AlcanceConfig): boolean {
  return (areasEnAlcance(alcance) as string[]).includes(area);
}

// ─── Estados ────────────────────────────────────────────────────────────────

export function requisitosAplicables(
  producto: string,
  config: ExpedientesConfig,
): string[] {
  const list = config.requisitosPorProducto[producto] ??
    DEFAULT_CONFIG.requisitosPorProducto[producto] ?? ['cedula'];
  return Array.from(new Set(list));
}

/**
 * Completo SOLO si todos los requisitos aplicables están validados.
 * Si lo único no validado es "sin_informacion", el expediente es sin_informacion
 * (no se sabe si falta algo: no cuenta como incompleto).
 */
export function calcularEstadoDocumental(
  aplicables: string[],
  requisitos: { tipo: string; estado: string }[],
): EstadoDocumental {
  if (!aplicables.length) return 'incompleto';
  const porTipo = new Map(requisitos.map((r) => [r.tipo, r.estado]));
  const estados = aplicables.map((t) => porTipo.get(t) ?? 'faltante');
  if (estados.every((e) => e === 'validado')) return 'completo';
  if (estados.every((e) => e === 'validado' || e === 'sin_informacion'))
    return 'sin_informacion';
  return 'incompleto';
}

export function esPendiente(estado: string): boolean {
  return estado === 'faltante' || estado === 'observado';
}

export function normalizarEstadoPago(...vals: unknown[]): EstadoPago {
  for (const v of vals) {
    const s = String(v ?? '')
      .trim()
      .toLowerCase();
    if (s === 'pendiente' || s === 'pendiente_pago') return 'pendiente';
    if (s === 'pagada' || s === 'pagado') return 'pagada';
  }
  return 'pagada';
}

// ─── Asegurado y datos personales ──────────────────────────────────────────

export function soloDigitos(v?: string | null): string {
  return String(v ?? '').replace(/\D/g, '');
}

/** "V-12.345.678" → { tipoDoc: 'V', documento: '12345678' } */
export function separarIdentificacion(v?: string | null): {
  tipoDoc?: string;
  documento?: string;
} {
  const s = String(v ?? '')
    .trim()
    .toUpperCase();
  if (!s) return {};
  const m = s.match(/^([VEJGPC])\s*-?\s*(.+)$/);
  if (m) return { tipoDoc: m[1], documento: soloDigitos(m[2]) || undefined };
  return { documento: soloDigitos(s) || undefined };
}

export function aseguradoKey(a: {
  tipoDoc?: string | null;
  documento?: string | null;
  email?: string | null;
}): string | null {
  const doc = soloDigitos(a.documento);
  if (doc) return `${String(a.tipoDoc ?? 'V').toUpperCase()}${doc}`;
  const email = String(a.email ?? '')
    .trim()
    .toLowerCase();
  return email ? `mail:${email}` : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function emailValido(v?: string | null): boolean {
  const s = String(v ?? '').trim();
  return s.length <= 200 && EMAIL_RE.test(s);
}

export function maskEmail(v?: string | null): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const [user, domain] = s.split('@');
  if (!domain) return '***';
  const u = user.length <= 2 ? `${user[0] ?? ''}*` : `${user.slice(0, 2)}***`;
  return `${u}@${domain}`;
}

export function maskPoliza(v?: string | null): string {
  const s = String(v ?? '').trim();
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, s.length - 4))}${s.slice(-4)}`;
}

/** Lista blanca fuera de producción: vacía = no se envía nada. */
export function whitelistPermite(
  to: string,
  esProduccion: boolean,
  whitelist: string[],
): boolean {
  if (esProduccion) return true;
  if (!whitelist.length) return false;
  return whitelist.includes(to.trim().toLowerCase());
}

// ─── Hora Caracas (UTC-4 fijo, sin horario de verano) ──────────────────────

const CARACAS_OFFSET_MS = -4 * 60 * 60 * 1000;

export function caracasParts(d: Date = new Date()): {
  fecha: string;
  hora: string;
} {
  const c = new Date(d.getTime() + CARACAS_OFFSET_MS);
  const fecha = c.toISOString().slice(0, 10);
  const hora = c.toISOString().slice(11, 16);
  return { fecha, hora };
}

/** Inicio del día Caracas (fecha YYYY-MM-DD) en UTC. */
export function caracasInicioDia(fecha: string): Date {
  return new Date(`${fecha}T04:00:00.000Z`);
}

export function diasCaracasEntre(desde: Date, hasta: Date): number {
  const a = caracasInicioDia(caracasParts(desde).fecha).getTime();
  const b = caracasInicioDia(caracasParts(hasta).fecha).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function horaValida(h: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(h);
}

// ─── Cadencia ───────────────────────────────────────────────────────────────

/** Días de tolerancia para la última etapa (si la tarea no corrió ese día). */
export const VENTANA_ULTIMA_ETAPA = 3;

/**
 * Etapa que toca hoy, o null. Solo la etapa de la ventana actual y nunca una
 * etapa ya enviada: así un reinicio o una conciliación tardía no repiten ni
 * disparan correos de pólizas viejas.
 */
export function etapaDebida(
  diasDesdeEmision: number,
  cadencia: number[],
  etapaEnviada: number,
): number | null {
  if (diasDesdeEmision < 0 || !cadencia.length) return null;
  let idx = -1;
  for (let i = 0; i < cadencia.length; i++) {
    if (cadencia[i] <= diasDesdeEmision) idx = i;
  }
  if (idx < 0 || idx <= etapaEnviada) return null;
  const last = cadencia.length - 1;
  if (idx === last && diasDesdeEmision >= cadencia[last] + VENTANA_ULTIMA_ETAPA)
    return null;
  return idx;
}

export function cadenciaVencida(
  diasDesdeEmision: number,
  cadencia: number[],
): boolean {
  if (!cadencia.length) return true;
  return (
    diasDesdeEmision >= cadencia[cadencia.length - 1] + VENTANA_ULTIMA_ETAPA
  );
}

export function proximoEnvio(
  emitidaEn: Date,
  cadencia: number[],
  etapaEnviada: number,
  horaDiaria: string,
): Date | null {
  const next = etapaEnviada + 1;
  if (next >= cadencia.length) return null;
  const base = caracasInicioDia(caracasParts(emitidaEn).fecha);
  const [hh, mm] = horaDiaria.split(':').map(Number);
  return new Date(
    base.getTime() + cadencia[next] * 86_400_000 + (hh * 60 + mm) * 60_000,
  );
}

// ─── Validación automática: OCR vs snapshot ────────────────────────────────

export type ResultadoComparacion =
  | { estado: 'validado' }
  | { estado: 'observado'; motivo: string; codigo: 'ilegible' | 'incongruente' }
  | { estado: 'recibido'; motivo: string };

function pick(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return undefined;
}

function normTexto(v?: string): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normPlaca(v?: string): string {
  return String(v ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function nombresCoinciden(ocr: string, esperado: string): boolean {
  const a = new Set(
    normTexto(ocr)
      .split(' ')
      .filter((t) => t.length > 1),
  );
  const b = normTexto(esperado)
    .split(' ')
    .filter((t) => t.length > 1);
  if (!a.size || !b.length) return false;
  const comunes = b.filter((t) => a.has(t)).length;
  return comunes >= Math.min(2, b.length);
}

/** Tipos que se comparan contra el asegurado (documento y nombre). */
const TIPOS_PERSONA = new Set(['cedula', 'licencia', 'rif', 'pasaporte']);

export interface DatosEsperados {
  documento?: string | null;
  nombre?: string | null;
  apellido?: string | null;
  snapshot?: unknown;
}

/**
 * Validación automática. El OCR responde confianza 0 | 0.5 | 1:
 * - 0 o sin datos → observado con motivo (ilegible).
 * - datos que no coinciden → observado (incongruente).
 * - 1 y todo coincide → validado.
 * - 0.5 (o sin confianza) con datos coincidentes, o nada comparable → recibido (sin certeza).
 */
export function compararOcrConSnapshot(
  tipo: string,
  ocr:
    | { extraido?: unknown; confianza?: number | null; motivo?: string | null }
    | null
    | undefined,
  esperado: DatosEsperados,
): ResultadoComparacion {
  const extraido =
    ocr?.extraido && typeof ocr.extraido === 'object'
      ? (ocr.extraido as Record<string, unknown>)
      : null;
  const confianza = Number(ocr?.confianza);
  if (
    !extraido ||
    !Object.keys(extraido).length ||
    (Number.isFinite(confianza) && confianza <= 0)
  ) {
    const motivoOcr = String(ocr?.motivo ?? '')
      .trim()
      .slice(0, 200);
    return {
      estado: 'observado',
      codigo: 'ilegible',
      motivo:
        motivoOcr ||
        'No se pudo leer el documento. Adjunte una imagen más nítida.',
    };
  }

  const snap = (esperado.snapshot ?? {}) as Record<string, unknown>;
  const checks: boolean[] = [];

  if (tipo === 'certificado') {
    const veh = snap.vehiculo;
    const placaOcr = pick(extraido, ['placa', 'xplaca']);
    const placaEsp = pick(veh, ['placa', 'xplaca']);
    if (placaOcr && placaEsp)
      checks.push(normPlaca(placaOcr) === normPlaca(placaEsp));
    const serialOcr = pick(extraido, [
      'serialCarroceria',
      'serial_carroceria',
      'xserialcarroceria',
      'serial',
      'serialNiv',
    ]);
    const serialEsp = pick(veh, [
      'serialCarroceria',
      'serial_carroceria',
      'xserialcarroceria',
      'serial',
      'serialNiv',
    ]);
    if (serialOcr && serialEsp)
      checks.push(normPlaca(serialOcr) === normPlaca(serialEsp));
  } else if (TIPOS_PERSONA.has(tipo)) {
    const docOcr = soloDigitos(
      pick(extraido, [
        'documento',
        'cedula',
        'identificacion',
        'numeroDocumento',
        'rif',
        'nro',
      ]),
    );
    const docEsp = soloDigitos(esperado.documento);
    if (docOcr && docEsp) checks.push(docOcr === docEsp);
    const nombreOcr = [
      pick(extraido, [
        'nombre',
        'nombres',
        'nombreCompleto',
        'nombre_completo',
      ]),
      pick(extraido, ['apellido', 'apellidos']),
    ]
      .filter(Boolean)
      .join(' ');
    const nombreEsp = [esperado.nombre, esperado.apellido]
      .filter(Boolean)
      .join(' ');
    if (nombreOcr && nombreEsp)
      checks.push(nombresCoinciden(nombreOcr, nombreEsp));
  }

  if (!checks.length) {
    return { estado: 'recibido', motivo: 'Sin datos comparables' };
  }
  if (!checks.every(Boolean)) {
    return {
      estado: 'observado',
      codigo: 'incongruente',
      motivo: 'Los datos del documento no coinciden con la póliza.',
    };
  }
  if (Number.isFinite(confianza) && confianza >= 1)
    return { estado: 'validado' };
  return { estado: 'recibido', motivo: 'Lectura con certeza parcial' };
}
