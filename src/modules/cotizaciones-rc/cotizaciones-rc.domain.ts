/**
 * Cotizaciones del cotizador RC — lógica pura (sin BD ni red), testeable.
 *
 * Una cotización guarda el JSON completo del cotizador; el registro es permanente y la vigencia de 15 días solo
 * cierra el acceso y el pago del cliente. El cliente la trae por código, elige una
 * alternativa (I, II o III), paga en el módulo de Pagos y, con el pago confirmado, Nexus emite la póliza en
 * nest-api (riesgos-generales/emision, modo cotizador) y cobra el recibo (external/collection/activate).
 *
 * Una opción puede llevar más de una póliza (RCP + RCE = ramos 27 y 37): un solo pago por la suma de las primas,
 * una emisión y un cobro por ramo, y un único correo con todas las pólizas y recibos.
 */
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { AppError } from '../../utils/app-error';

export const DIAS_VIGENCIA = 15;
export const ESTADOS = [
  'cotizada',
  'pendiente_pago',
  'pagada',
  'emitida',
] as const;
export type EstadoCotizacion = (typeof ESTADOS)[number];
export const PRODUCTOS = ['rcg', 'rcp', 'rce', 'rc'] as const;
export type ProductoCotizacion = (typeof PRODUCTOS)[number];
export const OPCIONES = ['I', 'II', 'III'] as const;
export type Opcion = (typeof OPCIONES)[number];

/** Ramos que nest-api emite con prima informada (RIESGOS_GENERALES_COTIZADOR_RAMOS). */
export const RAMOS_COTIZADOR = [27, 28, 37];
/** Pólizas que puede llevar una opción: RCP + RCE («Ambas») son dos, una por ramo. */
export const MAX_POLIZAS = 2;
/** Intentos de checkout que se conservan por cotización (el cliente puede abrir Pagos más de una vez). */
export const MAX_INTENTOS = 5;

type Obj = Record<string, unknown>;
export const esObj = (v: unknown): v is Obj =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const texto = (v: unknown, max: number): string =>
  String(v ?? '')
    .trim()
    .slice(0, max);
export const redondear = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

// Sin 0, 1, I ni O: el cliente lo dicta o lo copia a mano.
const ALFABETO = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODIGO_RE = /^(RCG|RCP|RCE|RC)-\d{4}-\d{6}-[2-9A-HJ-NP-Z]{4}$/;

export function sufijoAleatorio(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALFABETO[randomInt(ALFABETO.length)];
  return s;
}

/**
 * Código legible y correlativo: RCG-2026-000123-7KQ4. El sufijo aleatorio evita que alguien recorra los
 * correlativos y lea cotizaciones ajenas (traen nombre, RIF y correo del tomador).
 */
export function generarCodigo(
  producto: ProductoCotizacion,
  anio: number,
  correlativo: number,
  sufijo: string = sufijoAleatorio(),
): string {
  return `${producto.toUpperCase()}-${anio}-${String(correlativo).padStart(6, '0')}-${sufijo}`;
}

/** Código tal como lo escribe el cliente (minúsculas, espacios) → canónico; null si no tiene el formato. */
export function normalizarCodigo(v: unknown): string | null {
  const c = String(v ?? '')
    .toUpperCase()
    .replace(/\s+/g, '');
  return CODIGO_RE.test(c) ? c : null;
}

export interface CotizacionNueva {
  producto: ProductoCotizacion;
  origen: 'admin' | 'cliente';
  tomadorNombre: string;
  tomadorDocumento: string | null;
  tomadorCorreo: string | null;
  moneda: string | null;
  datos: Obj;
}

/** Valida el cuerpo de POST /api/cotizaciones-rc. El JSON `datos` se guarda tal cual. */
export function validarCotizacionNueva(body: unknown): CotizacionNueva {
  const b = esObj(body) ? body : {};
  const producto = String(b.producto ?? '').toLowerCase() as ProductoCotizacion;
  if (!PRODUCTOS.includes(producto)) {
    throw new AppError(
      `producto debe ser uno de: ${PRODUCTOS.join(', ')}.`,
      400,
    );
  }
  if (!esObj(b.datos))
    throw new AppError('datos (JSON de la cotización) es obligatorio.', 400);
  const datos = b.datos;
  const tomador = esObj(datos.tomador) ? datos.tomador : {};
  const tomadorNombre = texto(tomador.nombre, 200);
  if (!tomadorNombre)
    throw new AppError('datos.tomador.nombre es obligatorio.', 400);
  const alternativas = Array.isArray(datos.alternativas)
    ? datos.alternativas
    : [];
  if (
    !alternativas.length ||
    !alternativas.every((a) => esObj(a) && Number(a.prima) > 0)
  ) {
    throw new AppError(
      'datos.alternativas debe traer al menos una opción con prima mayor que 0.',
      400,
    );
  }
  return {
    producto,
    origen: b.origen === 'cliente' ? 'cliente' : 'admin',
    tomadorNombre,
    tomadorDocumento: texto(tomador.documento, 32) || null,
    tomadorCorreo: texto(tomador.correo, 200).toLowerCase() || null,
    moneda: texto(datos.moneda, 8) || null,
    datos,
  };
}

export interface Alternativa {
  opcion: Opcion;
  limite: number;
  prima: number;
}

export function alternativaDe(datos: unknown, opcion: unknown): Alternativa {
  const lista =
    esObj(datos) && Array.isArray(datos.alternativas) ? datos.alternativas : [];
  const a = lista.find((x) => esObj(x) && x.opcion === opcion);
  if (!esObj(a) || !(Number(a.prima) > 0)) {
    throw new AppError(
      `La cotización no tiene la opción ${String(opcion)}.`,
      400,
    );
  }
  return {
    opcion: a.opcion as Opcion,
    limite: Number(a.limite) || 0,
    prima: Number(a.prima),
  };
}

/**
 * Bodies de emisión (nest-api riesgos-generales/emision, modo cotizador) que el cotizador dejó armados para la opción:
 * uno solo (RCG, RCP o RCE) o un arreglo con uno por ramo (RCP + RCE). Se emite solo si todos son de prima informada,
 * de ramos distintos del cotizador y si la suma de sus primas es la prima de la alternativa (lo que se cobra).
 */
export function emisionesDeOpcion(datos: unknown, alt: Alternativa): Obj[] {
  const emisiones =
    esObj(datos) && esObj(datos.emisiones) ? datos.emisiones : {};
  const v: unknown = emisiones[alt.opcion];
  const lista: unknown[] = Array.isArray(v) ? v : [v];
  if (!lista.length || !lista.every(esObj)) {
    throw new AppError(
      'Esta cotización no está lista para pago en línea (faltan los datos de emisión de la opción). Contacta a tu asesor de seguros.',
      409,
    );
  }
  const es = lista as Obj[];
  const ramos = es.map((e) => Number(e.cramo));
  if (
    es.some(
      (e) =>
        e.modo !== 'cotizador' ||
        !RAMOS_COTIZADOR.includes(Number(e.cramo)) ||
        !(Number(e.prima_total) > 0),
    )
  ) {
    throw new AppError(
      'Los datos de emisión de la cotización no son de prima informada (RCG, RCP o RCE).',
      409,
    );
  }
  if (es.length > MAX_POLIZAS || new Set(ramos).size !== ramos.length) {
    throw new AppError(
      'Los datos de emisión de la cotización traen pólizas repetidas o de más (una por ramo).',
      409,
    );
  }
  const suma = redondear(es.reduce((t, e) => t + Number(e.prima_total), 0));
  if (Math.abs(suma - alt.prima) > 0.01) {
    throw new AppError(
      'La prima de emisión no coincide con la prima de la opción cotizada.',
      409,
    );
  }
  if (
    es.some(
      (e) =>
        !Array.isArray(e.coberturas) ||
        !e.coberturas.length ||
        !texto(e.cplan, 20),
    )
  ) {
    throw new AppError(
      'Los datos de emisión de la cotización están incompletos (plan o coberturas).',
      409,
    );
  }
  return es;
}

/** Opción de una sola póliza (RCG): su body de emisión. */
export const emisionDeOpcion = (datos: unknown, alt: Alternativa): Obj =>
  emisionesDeOpcion(datos, alt)[0];

/** Nombre del producto de cada ramo del cotizador (líneas del pago y correo de la póliza). */
export const NOMBRE_RAMO: Record<number, string> = {
  27: 'Responsabilidad Civil Patronal',
  28: 'Responsabilidad Civil General',
  37: 'Responsabilidad Civil Empresarial',
};

/**
 * Reparte el monto pagado entre las pólizas en proporción a su prima; la última lleva el resto, así la suma es
 * exactamente lo pagado. Con una sola póliza, todo el monto.
 */
export function repartirPago(monto: number, primas: number[]): number[] {
  if (primas.length <= 1) return [monto];
  const total = primas.reduce((t, p) => t + p, 0);
  const partes: number[] = [];
  let asignado = 0;
  primas.forEach((p, i) => {
    const parte =
      i === primas.length - 1
        ? redondear(monto - asignado)
        : redondear(total > 0 ? (monto * p) / total : monto / primas.length);
    asignado = redondear(asignado + parte);
    partes.push(parte);
  });
  return partes;
}

/** Una póliza de la cotización, con el estado del cobro de su recibo. */
export interface PolizaCotizacion {
  cramo?: number;
  cotizador?: string;
  /** Prima de esta póliza en la moneda de la cotización (para repartir el pago entre los recibos). */
  prima?: number;
  cnpoliza: string;
  cnrecibo: string;
  urlpoliza: string;
  cobro?: Obj;
  emitidaEn?: string;
}

/**
 * Pólizas guardadas en crc_poliza: el arreglo `polizas[]` o, en las cotizaciones anteriores (una sola póliza, RCG),
 * los campos de la raíz.
 */
export function polizasDe(poliza: unknown): PolizaCotizacion[] {
  if (!esObj(poliza)) return [];
  const lista = Array.isArray(poliza.polizas)
    ? poliza.polizas.filter(esObj)
    : [poliza];
  return lista
    .filter((p) => texto(p.cnpoliza, 40))
    .map((p) => ({
      ...(Number(p.cramo) > 0 ? { cramo: Number(p.cramo) } : {}),
      ...(p.cotizador ? { cotizador: texto(p.cotizador, 8) } : {}),
      ...(Number(p.prima) > 0 ? { prima: Number(p.prima) } : {}),
      cnpoliza: texto(p.cnpoliza, 40),
      cnrecibo: texto(p.cnrecibo, 40),
      urlpoliza: texto(p.urlpoliza, 500),
      ...(esObj(p.cobro) ? { cobro: p.cobro } : {}),
      ...(p.emitidaEn ? { emitidaEn: String(p.emitidaEn) } : {}),
    }));
}

/**
 * crc_poliza: los campos de la primera póliza en la raíz (formato de siempre, RCG) más `polizas[]` con todas.
 * `parcial`: faltan pólizas por emitir (la cotización sigue pagada y el reintento emite solo las que faltan).
 */
export function armarPolizaGuardada(
  polizas: PolizaCotizacion[],
  parcial = false,
): Obj {
  return { ...polizas[0], polizas, ...(parcial ? { parcial: true } : {}) };
}

export const polizaParcial = (poliza: unknown): boolean =>
  esObj(poliza) && poliza.parcial === true;

export const reciboCobrado = (p: Pick<PolizaCotizacion, 'cobro'>): boolean =>
  esObj(p.cobro) && p.cobro.ok === true;

/** Moneda de la cotización → cómo se cobra en bolívares. EUR no tiene tasa en nest-api (solo USD). */
export function monedaDeCobro(moneda: unknown): 'USD' | 'BS' {
  const m = String(moneda ?? '')
    .trim()
    .toUpperCase();
  if (m === 'USD') return 'USD';
  if (m.startsWith('BS') || m === 'VES') return 'BS';
  throw new AppError(
    `El pago en línea solo está disponible para cotizaciones en USD o Bs. (moneda: ${m || '—'}).`,
    409,
  );
}

export const sha256 = (v: string): string =>
  createHash('sha256').update(v).digest('hex');

export function tokenCoincide(token: string, hash: string): boolean {
  const a = Buffer.from(sha256(token), 'hex');
  const b = Buffer.from(String(hash ?? ''), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface IntentoPago {
  tokenHash: string;
  opcion: Opcion;
  prima: number;
  moneda: string;
  tasa: number;
  totalVes: number;
  sid: string;
  checkoutUrl: string;
  creadoEn: string;
}

export const intentosDe = (pago: unknown): IntentoPago[] =>
  esObj(pago) && Array.isArray(pago.intentos)
    ? (pago.intentos as IntentoPago[])
    : [];

export const intentoPorToken = (
  pago: unknown,
  token: string,
): IntentoPago | null =>
  intentosDe(pago).find((i) => tokenCoincide(token, i.tokenHash)) ?? null;

/** 1 % del monto o 1 Bs, el mayor (mismo criterio que nest-api al verificar el cobro). */
export const montoTolerancia = (amountVes: number): number =>
  Math.max(1, amountVes * 0.01);

export interface PagoConfirmado {
  referencia: string;
  monto: number;
  metodo: string | null;
  fecha: string;
  /** Datos del pago verificado que pide external/collection/activate. */
  detalle: Obj;
}

/** Pago que reporta pagos-api (POST /api/checkout/notify → notifyUrl). */
export function pagoDeNotificacion(
  body: unknown,
  hoy: Date = new Date(),
): PagoConfirmado {
  const p = esObj(body) && esObj(body.payment) ? body.payment : {};
  const referencia = texto(p.reference ?? p.transactionId ?? p.xreferencia, 64);
  if (!referencia || /^EX-/i.test(referencia)) {
    throw new AppError(
      'La notificación de pago no trae referencia bancaria.',
      400,
    );
  }
  const monto = Number(p.amount);
  if (!(monto > 0))
    throw new AppError('La notificación de pago no trae el monto pagado.', 400);
  const fecha = texto(p.paidOn ?? p.verifiedOn ?? p.fpago, 10);
  return {
    referencia,
    monto,
    metodo: texto(p.method, 32) || null,
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(fecha)
      ? fecha
      : hoy.toISOString().slice(0, 10),
    detalle: {
      ...(p.cusuario != null ? { cusuario: Number(p.cusuario) } : {}),
      ...(p.bankCode ? { cbanco_ref: texto(p.bankCode, 8) } : {}),
      ...(p.cbanco != null && Number.isFinite(Number(p.cbanco))
        ? { cbanco: Number(p.cbanco) }
        : {}),
      ...(p.cbanco_destino != null && Number.isFinite(Number(p.cbanco_destino))
        ? { cbanco_destino: Number(p.cbanco_destino) }
        : {}),
      ...(p.sourcePhone ? { xtelefono: texto(p.sourcePhone, 20) } : {}),
      ...(p.telefonoDest ? { telefono_dest: texto(p.telefonoDest, 20) } : {}),
      ...(p.cci_rif ? { cci_rif: texto(p.cci_rif, 20) } : {}),
      ...(p.cbanco_dest_ref
        ? { cbanco_dest_ref: texto(p.cbanco_dest_ref, 8) }
        : {}),
    },
  };
}

/**
 * Body de POST external/collection/activate: el mismo cobro que usan RCV, funerario y personas.
 * Con varias pólizas pagadas en un solo pago, `mpago` es la parte del pago de ese recibo y `adicional` marca los
 * recibos después del primero, que no se cobran automáticamente con la misma referencia (quedan pendientes para
 * caja; ver `cobrar` en el servicio).
 */
export function armarCobro(
  cnrecibo: string,
  pago: PagoConfirmado,
  x: { mpago?: number; adicional?: boolean } = {},
): Obj {
  // Sin atajos: el body lleva los datos reales del pagador. Los recibos después del primero no se cobran
  // automáticamente con la misma referencia (ver `cobrar` en el servicio): quedan pendientes para caja.
  const detalle = { ...pago.detalle };
  return {
    cnrecibo,
    mpago: x.mpago ?? pago.monto,
    xreferencia: pago.referencia,
    fpago: pago.fecha,
    ...detalle,
  };
}

export type ModoVerificacion = 'enforce' | 'warn' | 'off';
export type MotivoVerificacion =
  | 'ok'
  | 'not_found'
  | 'pending'
  | 'amount_mismatch'
  | 'db_unavailable'
  | 'disabled';
export interface RegistroPago {
  proveedor: string | null;
  estado: string | null;
  monto: number | string | null;
}

/**
 * ¿La referencia es un pago verificado por pagos-api? Misma regla que nest-api (payment-verification.service):
 * SyPago cuenta solo en ACCP; un pago móvil solo se registra en pagos.registros_pago tras verificarse con el banco.
 */
export function evaluarRegistros(
  rows: RegistroPago[],
  amountVes: number,
): { verified: boolean; reason: MotivoVerificacion } {
  if (!rows.length) return { verified: false, reason: 'not_found' };
  let pendiente = false;
  for (const r of rows) {
    const estado =
      r.estado != null ? String(r.estado).toUpperCase().trim() : null;
    const proveedor =
      r.proveedor != null ? String(r.proveedor).toLowerCase().trim() : 'sypago';
    if (proveedor === 'sypago' && estado !== 'ACCP') {
      pendiente = true;
      continue;
    }
    const monto = r.monto != null ? Number(r.monto) : null;
    if (
      monto != null &&
      Number.isFinite(monto) &&
      amountVes > 0 &&
      Math.abs(monto - amountVes) > montoTolerancia(amountVes)
    ) {
      return { verified: false, reason: 'amount_mismatch' };
    }
    return { verified: true, reason: 'ok' };
  }
  return { verified: false, reason: pendiente ? 'pending' : 'not_found' };
}

export interface FilaCotizacion {
  id: number;
  codigo: string;
  producto: string;
  estado: string;
  origen: string;
  tomadorNombre: string;
  tomadorDocumento: string | null;
  tomadorCorreo: string | null;
  moneda: string | null;
  opcion: string | null;
  datos: unknown;
  pago: unknown;
  poliza: unknown;
  error: string | null;
  /** Envío automático de la póliza: { enviadoEn, a, error, … }. */
  correoPoliza: unknown;
  expiraEn: Date;
  createdAt: Date;
  updatedAt: Date | null;
}

export const vencida = (
  f: Pick<FilaCotizacion, 'expiraEn'>,
  ahora: Date = new Date(),
): boolean => new Date(f.expiraEn).getTime() <= ahora.getTime();

// ─── Correo automático de la póliza ─────────────────────────────────────────

/** Tope de nest-api para los adjuntos de un correo (mail-attachments.ts): 8 MB ya decodificados. */
export const MAX_ADJUNTOS_BYTES = 8 * 1024 * 1024;

const esPdf = (b: Uint8Array): boolean =>
  b.length > 4 &&
  b[0] === 0x25 &&
  b[1] === 0x50 &&
  b[2] === 0x44 &&
  b[3] === 0x46;

const nombrePdf = (v: unknown, porDefecto: string): string => {
  const n = texto(v, 140).replace(/[^\w.\- ]+/g, '_') || porDefecto;
  return n.toLowerCase().endsWith('.pdf') ? n : `${n}.pdf`;
};

/**
 * PDF «Condicionado y anexos» que el cotizador manda con el checkout ({ nombre, base64 }). null si no viene, no es
 * un PDF o pasa del tope: el checkout sigue y el correo saldrá solo con la póliza.
 */
export function anexosDeCheckout(
  v: unknown,
): { nombre: string; pdf: Buffer } | null {
  if (!esObj(v) || typeof v.base64 !== 'string' || !v.base64) return null;
  if (v.base64.length > Math.ceil((MAX_ADJUNTOS_BYTES * 4) / 3) + 4)
    return null;
  const pdf = Buffer.from(v.base64, 'base64');
  if (!esPdf(pdf) || pdf.length > MAX_ADJUNTOS_BYTES) return null;
  return { nombre: nombrePdf(v.nombre, 'Condicionado_y_anexos.pdf'), pdf };
}

const CORREO_RE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}$/i;
export const correoValido = (v: unknown): boolean => {
  const t = String(v ?? '').trim();
  return t.length <= 150 && CORREO_RE.test(t);
};

export interface AdjuntoPoliza {
  nombre: string;
  pdf: Uint8Array;
}

const NOMBRE_PRODUCTO: Record<string, string> = {
  rcg: 'Responsabilidad Civil General',
  rcp: 'Responsabilidad Civil Patronal',
  rce: 'Responsabilidad Civil Empresarial',
  rc: 'Responsabilidad Civil',
};

const importe = (n: number): string =>
  new Intl.NumberFormat('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);

/**
 * Adjuntos que caben en el tope del correo. Si el total lo supera, la prioridad es: anexos (no tienen enlace),
 * póliza (si queda fuera va el botón «Ver mi póliza») y recibo. En el correo van en orden póliza, recibo, anexos.
 */
export function adjuntosQueCaben(
  c: {
    poliza?: AdjuntoPoliza | null;
    recibo?: AdjuntoPoliza | null;
    /** Varias pólizas (RCP + RCE): los PDF de todas y los recibos cobrados. */
    polizas?: (AdjuntoPoliza | null)[];
    recibos?: (AdjuntoPoliza | null)[];
    anexos?: AdjuntoPoliza | null;
    /** Pólizas de la cotización: si entra el PDF de menos, `sinPdfPoliza`. */
    esperadas?: number;
  },
  max: number = MAX_ADJUNTOS_BYTES,
): { adjuntos: AdjuntoPoliza[]; sinPdfPoliza: boolean; total: number } {
  let total = 0;
  const cabe = (x?: AdjuntoPoliza | null): AdjuntoPoliza | null => {
    if (!x || total + x.pdf.length > max) return null;
    total += x.pdf.length;
    return x;
  };
  const si = (x: AdjuntoPoliza | null): x is AdjuntoPoliza => !!x;
  const anexos = cabe(c.anexos);
  const polizas = [c.poliza, ...(c.polizas ?? [])].map(cabe).filter(si);
  const recibos = [c.recibo, ...(c.recibos ?? [])].map(cabe).filter(si);
  return {
    adjuntos: [...polizas, ...recibos, ...(anexos ? [anexos] : [])],
    sinPdfPoliza: polizas.length < Math.max(1, c.esperadas ?? 0),
    total,
  };
}

/** Póliza tal como va en el correo. */
export interface PolizaCorreo {
  cramo?: number;
  cnpoliza: string;
  cnrecibo?: string;
  urlpoliza?: string;
}

/**
 * Body de POST /api/v1/mail/send (plantilla `branded`) con la póliza emitida (o las pólizas: ver
 * armarCorreoVariasPolizas): datos de la póliza, enlace
 * «Ver mi póliza» y los PDF adjuntos (póliza, recibo cobrado y condicionado con anexos). Mismos textos que el envío del cotizador.
 */
export function armarCorreoPoliza(
  f: Pick<
    FilaCotizacion,
    'producto' | 'tomadorNombre' | 'tomadorCorreo' | 'moneda' | 'datos'
  >,
  una: PolizaCorreo | PolizaCorreo[],
  prima: number | null,
  adjuntos: AdjuntoPoliza[],
  conAnexos: boolean,
): Obj {
  const polizas = Array.isArray(una) ? una : [una];
  if (polizas.length > 1)
    return armarCorreoVariasPolizas(f, polizas, prima, adjuntos, conAnexos);
  const poliza = polizas[0];
  const to = String(f.tomadorCorreo ?? '')
    .trim()
    .toLowerCase();
  const nombre = texto(f.tomadorNombre, 120);
  const producto =
    texto(esObj(f.datos) ? f.datos.nombreProducto : '', 120) ||
    NOMBRE_PRODUCTO[f.producto] ||
    'Responsabilidad Civil';
  const url = /^https?:\/\//i.test(poliza.urlpoliza ?? '')
    ? String(poliza.urlpoliza)
    : '';
  const fields = [
    { label: 'Póliza', value: poliza.cnpoliza },
    { label: 'Producto', value: producto },
    ...(prima && prima > 0
      ? [
          {
            label: 'Prima total',
            value: `${texto(f.moneda, 8)} ${importe(prima)}`.trim(),
          },
        ]
      : []),
    ...(poliza.cnrecibo ? [{ label: 'Recibo', value: poliza.cnrecibo }] : []),
  ].map((x) => ({ label: x.label, value: texto(x.value, 250) }));
  return {
    to,
    ...(nombre ? { toName: nombre } : {}),
    template: 'branded',
    data: {
      subject: `La Mundial de Seguros | Póliza N.º ${poliza.cnpoliza}`,
      eyebrow: 'Póliza',
      title: 'Su póliza de La Mundial de Seguros',
      intro:
        `${nombre ? `Estimado(a) ${nombre}:` : 'Estimado(a) cliente:'} Le enviamos su póliza N.º ${poliza.cnpoliza} de ${producto}` +
        (conAnexos
          ? ' con el condicionado general y particular y los anexos de las coberturas contratadas.'
          : '.') +
        ' Ante cualquier duda, puede comunicarse con su asesor de seguros.',
      ...(url ? { ctaLabel: 'Ver mi póliza', ctaUrl: url } : {}),
      extraNote: conAnexos
        ? 'Conserve este correo: el condicionado y los anexos forman parte integrante de su contrato de seguro.'
        : 'Conserve este correo con los datos de su póliza.',
    },
    fields,
    ...(adjuntos.length
      ? {
          attachments: adjuntos.map((a) => ({
            filename: nombrePdf(a.nombre, 'Documento.pdf'),
            contentBase64: Buffer.from(a.pdf).toString('base64'),
            contentType: 'application/pdf',
          })),
        }
      : {}),
  };
}

const adjuntosCorreo = (adjuntos: AdjuntoPoliza[]): Obj =>
  adjuntos.length
    ? {
        attachments: adjuntos.map((a) => ({
          filename: nombrePdf(a.nombre, 'Documento.pdf'),
          contentBase64: Buffer.from(a.pdf).toString('base64'),
          contentType: 'application/pdf',
        })),
      }
    : {};

/** Nombre del PDF de la póliza en el correo (también sirve para saber si entró como adjunto). */
export const nombrePdfPoliza = (cnpoliza: string): string =>
  `Poliza_${cnpoliza}.pdf`;

/**
 * Un solo correo con todas las pólizas de la cotización (RCP + RCE): cada número de póliza y de recibo con su
 * producto, la prima total pagada y los PDF adjuntos. El botón abre la primera póliza; las demás van adjuntas o,
 * si su PDF no entró, con su enlace.
 */
function armarCorreoVariasPolizas(
  f: Pick<
    FilaCotizacion,
    'producto' | 'tomadorNombre' | 'tomadorCorreo' | 'moneda' | 'datos'
  >,
  polizas: PolizaCorreo[],
  prima: number | null,
  adjuntos: AdjuntoPoliza[],
  conAnexos: boolean,
): Obj {
  const to = String(f.tomadorCorreo ?? '')
    .trim()
    .toLowerCase();
  const nombre = texto(f.tomadorNombre, 120);
  const producto =
    texto(esObj(f.datos) ? f.datos.nombreProducto : '', 120) ||
    NOMBRE_PRODUCTO[f.producto] ||
    'Responsabilidad Civil';
  const de = (p: PolizaCorreo): string =>
    (p.cramo && NOMBRE_RAMO[p.cramo]) || 'Responsabilidad Civil';
  const url = (p: PolizaCorreo): string =>
    /^https?:\/\//i.test(p.urlpoliza ?? '') ? String(p.urlpoliza) : '';
  const numeros = polizas.map((p) => p.cnpoliza);
  const lista = `${numeros.slice(0, -1).join(', ')} y ${numeros.slice(-1)[0]}`;
  const conBoton = polizas.find((p) => url(p));
  const adjuntas = new Set(adjuntos.map((a) => a.nombre));
  const fields = [
    ...polizas.map((p) => ({
      label: `Póliza · ${de(p)}`,
      value: p.cnpoliza,
    })),
    { label: 'Producto', value: producto },
    ...(prima && prima > 0
      ? [
          {
            label: 'Prima total',
            value: `${texto(f.moneda, 8)} ${importe(prima)}`.trim(),
          },
        ]
      : []),
    ...polizas
      .filter((p) => p.cnrecibo)
      .map((p) => ({ label: `Recibo · ${de(p)}`, value: p.cnrecibo ?? '' })),
    // Sin botón propio y sin PDF adjunto: el enlace es la única forma de abrir esa póliza.
    ...polizas
      .filter(
        (p) =>
          p !== conBoton &&
          url(p) &&
          !adjuntas.has(nombrePdfPoliza(p.cnpoliza)),
      )
      .map((p) => ({ label: `Ver póliza ${p.cnpoliza}`, value: url(p) })),
  ].map((x) => ({ label: x.label, value: texto(x.value, 250) }));
  return {
    to,
    ...(nombre ? { toName: nombre } : {}),
    template: 'branded',
    data: {
      subject: `La Mundial de Seguros | Pólizas N.º ${lista}`,
      eyebrow: 'Pólizas',
      title: 'Sus pólizas de La Mundial de Seguros',
      intro:
        `${nombre ? `Estimado(a) ${nombre}:` : 'Estimado(a) cliente:'} Le enviamos sus pólizas ` +
        polizas.map((p) => `N.º ${p.cnpoliza} de ${de(p)}`).join(' y ') +
        (conAnexos
          ? ', con el condicionado general y particular y los anexos de las coberturas contratadas.'
          : '.') +
        ' Ante cualquier duda, puede comunicarse con su asesor de seguros.',
      ...(conBoton
        ? {
            ctaLabel: `Ver póliza ${conBoton.cnpoliza}`,
            ctaUrl: url(conBoton),
          }
        : {}),
      extraNote: conAnexos
        ? 'Conserve este correo: el condicionado y los anexos forman parte integrante de su contrato de seguro.'
        : 'Conserve este correo con los datos de sus pólizas.',
    },
    fields,
    ...adjuntosCorreo(adjuntos),
  };
}

export interface CorreoPolizaPublico {
  enviadoEn: string | null;
  a: string | null;
  error: string | null;
}

/** Estado del correo que sale por la API (sin el reclamo interno `enviandoEn`); null si aún no se intentó. */
export function correoPolizaPublico(v: unknown): CorreoPolizaPublico | null {
  if (!esObj(v) || (!v.enviadoEn && !v.error)) return null;
  return {
    enviadoEn: v.enviadoEn ? String(v.enviadoEn) : null,
    a: v.a ? String(v.a) : null,
    error: !v.enviadoEn && v.error ? String(v.error) : null,
  };
}

export const correoPolizaEnviado = (v: unknown): boolean =>
  esObj(v) && !!v.enviadoEn;

/** Lo que sale por la API: sin los hashes de los tokens del callback de pago. */
export function aRespuesta(f: FilaCotizacion, conDatos = true) {
  const pago = esObj(f.pago) ? f.pago : null;
  const ultimo = intentosDe(pago).slice(-1)[0];
  const pagado = pago && esObj(pago.pagado) ? pago.pagado : null;
  return {
    codigo: f.codigo,
    producto: f.producto,
    estado: f.estado,
    // Vencida = sin pagar y con los 15 días cumplidos: el cliente ya no puede traerla ni pagarla.
    vencida:
      vencida(f) && (f.estado === 'cotizada' || f.estado === 'pendiente_pago'),
    origen: f.origen,
    tomador: {
      nombre: f.tomadorNombre,
      documento: f.tomadorDocumento,
      correo: f.tomadorCorreo,
    },
    moneda: f.moneda,
    opcion: f.opcion,
    creadaEn: f.createdAt,
    expiraEn: f.expiraEn,
    actualizadaEn: f.updatedAt,
    ...(conDatos ? { datos: f.datos } : {}),
    pago:
      ultimo || pagado
        ? {
            ...(ultimo
              ? {
                  opcion: ultimo.opcion,
                  totalVes: ultimo.totalVes,
                  tasa: ultimo.tasa,
                  checkoutUrl: ultimo.checkoutUrl,
                }
              : {}),
            ...(pagado
              ? {
                  referencia: pagado.referencia,
                  monto: pagado.monto,
                  fecha: pagado.fecha,
                }
              : {}),
          }
        : null,
    poliza: f.poliza ?? null,
    correoPoliza: correoPolizaPublico(f.correoPoliza),
    // El detalle del error de emisión es interno; al cliente le basta saber que el pago está y la póliza en proceso.
    error: f.error
      ? 'La póliza está en proceso: el pago quedó registrado y un asesor la completará.'
      : null,
  };
}
