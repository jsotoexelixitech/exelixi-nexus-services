/**
 * Cotizaciones del cotizador RC — lógica pura (sin BD ni red), testeable.
 *
 * Una cotización guarda el JSON completo del cotizador; el registro es permanente y la vigencia de 15 días solo
 * cierra el acceso y el pago del cliente. El cliente la trae por código, elige una
 * alternativa (I, II o III), paga en el módulo de Pagos y, con el pago confirmado, Nexus emite la póliza en
 * nest-api (riesgos-generales/emision, modo cotizador) y cobra el recibo (external/collection/activate).
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
 * Body de emisión (nest-api riesgos-generales/emision, modo cotizador) que el cotizador dejó armado para la opción.
 * Se emite solo si es de prima informada, de un ramo del cotizador y por la misma prima de la alternativa.
 */
export function emisionDeOpcion(datos: unknown, alt: Alternativa): Obj {
  const emisiones =
    esObj(datos) && esObj(datos.emisiones) ? datos.emisiones : {};
  const e = emisiones[alt.opcion];
  if (!esObj(e)) {
    throw new AppError(
      'Esta cotización no está lista para pago en línea (faltan los datos de emisión de la opción). Contacta a tu asesor de seguros.',
      409,
    );
  }
  if (e.modo !== 'cotizador' || !RAMOS_COTIZADOR.includes(Number(e.cramo))) {
    throw new AppError(
      'Los datos de emisión de la cotización no son de prima informada (RCG, RCP o RCE).',
      409,
    );
  }
  if (Math.abs(Number(e.prima_total) - alt.prima) > 0.01) {
    throw new AppError(
      'La prima de emisión no coincide con la prima de la opción cotizada.',
      409,
    );
  }
  if (
    !Array.isArray(e.coberturas) ||
    !e.coberturas.length ||
    !texto(e.cplan, 20)
  ) {
    throw new AppError(
      'Los datos de emisión de la cotización están incompletos (plan o coberturas).',
      409,
    );
  }
  return e;
}

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

/** Body de POST external/collection/activate: el mismo cobro que usan RCV, funerario y personas. */
export function armarCobro(cnrecibo: string, pago: PagoConfirmado): Obj {
  return {
    cnrecibo,
    mpago: pago.monto,
    xreferencia: pago.referencia,
    fpago: pago.fecha,
    ...pago.detalle,
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
  expiraEn: Date;
  createdAt: Date;
  updatedAt: Date | null;
}

export const vencida = (
  f: Pick<FilaCotizacion, 'expiraEn'>,
  ahora: Date = new Date(),
): boolean => new Date(f.expiraEn).getTime() <= ahora.getTime();

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
    // El detalle del error de emisión es interno; al cliente le basta saber que el pago está y la póliza en proceso.
    error: f.error
      ? 'La póliza está en proceso: el pago quedó registrado y un asesor la completará.'
      : null,
  };
}
