/**
 * Conciliación de emisiones perdidas (26-nov-2026).
 *
 * Caso real (sesión 7311): nest-api emitió la póliza en Sis2000 pero respondió ~2 min después; el módulo
 * Emisión cortó a los 30 s, el número nunca llegó a la sesión y `syncSessionToDb` no creó `emision` ni
 * `mkt_expediente`: la póliza no aparece en el monitor aunque existe.
 *
 * Esta tarea busca sesiones del flujo RCV con el pago verificado, sin `policy.number` y sin fila en `emision`,
 * pregunta a nest-api (solo lectura) si existe una póliza que corresponda a ESTE intento y, si la hay:
 *   placa + serial de carrocería + productor/canal de la sesión + ingreso posterior al inicio de la sesión,
 * registra `emision` (igual que syncSessionToDb) y crea el expediente con origen `conciliacion`.
 *
 * - APAGADA por defecto (EXPEDIENTES_PERDIDAS_ENABLED). Sin EXPEDIENTES_PERDIDAS_ESCRIBIR=true solo lista
 *   (vista previa, no escribe nada).
 * - Nunca envía correos al cliente: el expediente nace con la cadencia agotada (no hay solicitud inicial ni
 *   recordatorios) y la tarea no llama a ningún servicio de correo.
 * - Idempotente: una sesión con `emision` o una póliza ya registrada se omite; una póliza candidata de más de
 *   una sesión (o más de una póliza para una sesión) es ambigua y no se toca.
 * - La búsqueda de la póliza es inyectable (`BuscarPolizasVehiculo`). nest-api aún no expone un endpoint de solo
 *   lectura placa/serial → cnpoliza + fecha de ingreso; mientras no exista, la tarea solo informa cuántas
 *   sesiones quedaron sin póliza (`lookup: 'no_disponible'`) y no escribe.
 */
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { caracasParts } from './expedientes.domain';
import { perdidasConfig } from './expedientes.env';
import { dentroDeVentana } from './expedientes.historico';
import { expedientesService as svc } from './expedientes.service';

export interface PolizaVehiculo {
  cnpoliza: string;
  cnrecibo?: string | null;
  urlpoliza?: string | null;
  placa: string;
  serial: string;
  cproductor: string | number | null;
  ccanalalt?: string | number | null;
  /** Fecha de ingreso de la póliza en Sis2000. */
  fingreso: string | Date;
}

export type BuscarPolizasVehiculo = (q: {
  placa: string;
  serial: string;
  desde: Date;
}) => Promise<PolizaVehiculo[]>;

/** Holgura por diferencia de relojes entre Nexus y Sis2000. */
const HOLGURA_MS = 2 * 60_000;

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function txt(v: unknown): string | null {
  if (v == null || (typeof v !== 'string' && typeof v !== 'number'))
    return null;
  const s = String(v).trim();
  return s && !/^(null|n\/a|na|none|undefined|0)$/i.test(s) ? s : null;
}

/** Placa / serial: mayúsculas sin espacios, puntos ni guiones. */
export function normCodigo(v: unknown): string {
  return String(v ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export interface DatosSesion {
  placa: string;
  serial: string;
  cproductor: string | null;
  ccanalalt: string | null;
}

/** Datos del intento guardados en el wizard (`cotizacion.jsonData`). null = no se puede conciliar. */
export function datosDeSesion(jd: unknown): DatosSesion | null {
  const d = rec(jd);
  const v = rec(d.vehicle);
  const meta = { ...rec(d.metadataCanal), ...rec(rec(d.metadata)) };
  const placa = normCodigo(v.placa);
  const serial = normCodigo(v.serial ?? v.serialCarroceria);
  if (!placa || !serial) return null;
  return {
    placa,
    serial,
    cproductor: txt(meta.cproductor),
    ccanalalt: txt(meta.ccanalalt ?? meta.ccanalalt_in),
  };
}

/** ¿La póliza corresponde a ESTE intento? Todas las condiciones; un dato faltante = no coincide. */
export function polizaCoincide(
  p: PolizaVehiculo,
  s: DatosSesion,
  inicioSesion: Date,
  ahora: Date,
): boolean {
  if (!txt(p.cnpoliza)) return false;
  if (normCodigo(p.placa) !== s.placa) return false;
  if (normCodigo(p.serial) !== s.serial) return false;
  // Productor: obligatorio en la sesión y debe ser el mismo.
  if (!s.cproductor || String(p.cproductor ?? '').trim() !== s.cproductor)
    return false;
  // Canal: si la sesión lo traía debe coincidir.
  if (s.ccanalalt && String(p.ccanalalt ?? '').trim() !== s.ccanalalt)
    return false;
  const at = new Date(p.fingreso).getTime();
  if (!Number.isFinite(at)) return false;
  return (
    at >= inicioSesion.getTime() - HOLGURA_MS &&
    at <= ahora.getTime() + HOLGURA_MS
  );
}

export interface ResumenPerdidas {
  modo: 'vista_previa' | 'escribir';
  lookup: 'ok' | 'no_disponible';
  revisadas: number;
  sinDatos: number;
  otroProducto: number;
  sinPoliza: number;
  ambiguas: number;
  yaRegistradas: number;
  registradas: number;
  errores: number;
  /** Máx. 50: sesiones con póliza hallada (vista previa) o registrada. */
  detalle: { cotizacionId: number; cnpoliza: string; accion: string }[];
}

export interface OpcionesPerdidas {
  ahora?: Date;
  /** Fuerza el modo (por defecto, el de EXPEDIENTES_PERDIDAS_ESCRIBIR). */
  escribir?: boolean;
  buscar?: BuscarPolizasVehiculo | null;
  dias?: number;
  edadMin?: number;
  max?: number;
}

/** Punto de inyección del buscador (hasta que nest-api exponga el endpoint de solo lectura). */
let buscarPorDefecto: BuscarPolizasVehiculo | null = null;
export function _setBuscadorPerdidas(b: BuscarPolizasVehiculo | null): void {
  buscarPorDefecto = b;
}

export async function conciliarEmisionesPerdidas(
  opts: OpcionesPerdidas = {},
): Promise<ResumenPerdidas> {
  const cfg = perdidasConfig();
  const ahora = opts.ahora ?? new Date();
  const escribir = opts.escribir ?? cfg.escribir;
  const buscar = opts.buscar === undefined ? buscarPorDefecto : opts.buscar;
  const dias = opts.dias ?? cfg.dias;
  const edadMin = opts.edadMin ?? cfg.edadMin;
  const max = opts.max ?? cfg.max;

  const r: ResumenPerdidas = {
    modo: escribir ? 'escribir' : 'vista_previa',
    lookup: buscar ? 'ok' : 'no_disponible',
    revisadas: 0,
    sinDatos: 0,
    otroProducto: 0,
    sinPoliza: 0,
    ambiguas: 0,
    yaRegistradas: 0,
    registradas: 0,
    errores: 0,
    detalle: [],
  };

  const desde = new Date(ahora.getTime() - dias * 86_400_000);
  const corte = new Date(ahora.getTime() - edadMin * 60_000);
  const cotizaciones = await prisma.cotizacion.findMany({
    where: { createdAt: { gte: desde }, estado: { not: 'emitida' } },
    orderBy: { id: 'desc' },
    take: max * 5,
  });

  // Candidatas: wizard RCV con pago verificado, sin póliza y sin actividad reciente.
  const candidatas = cotizaciones.filter((c) => {
    const jd = rec(c.jsonData);
    if (jd.paymentVerified !== true) return false;
    if (txt(rec(jd.policy).number) ?? txt(rec(jd.policy).cnpoliza))
      return false;
    const ultima = c.updatedAt ?? c.createdAt;
    return ultima.getTime() <= corte.getTime();
  });
  if (!candidatas.length) return r;

  const conEmision = new Set(
    (
      await prisma.emision.findMany({
        where: { cotizacionId: { in: candidatas.map((c) => c.id) } },
        select: { cotizacionId: true },
      })
    ).map((e) => e.cotizacionId),
  );

  type Hallazgo = {
    cot: (typeof candidatas)[number];
    poliza: PolizaVehiculo;
  };
  const hallazgos: Hallazgo[] = [];

  for (const cot of candidatas.slice(0, max)) {
    if (conEmision.has(cot.id)) continue;
    r.revisadas++;
    const jd = rec(cot.jsonData);
    const producto = typeof jd.product === 'string' ? jd.product : 'rcv';
    if (producto !== 'rcv') {
      r.otroProducto++;
      continue;
    }
    const sesion = datosDeSesion(jd);
    if (!sesion) {
      r.sinDatos++;
      continue;
    }
    if (!buscar) {
      r.sinPoliza++;
      continue;
    }
    try {
      const lista = await buscar({
        placa: sesion.placa,
        serial: sesion.serial,
        desde: cot.createdAt,
      });
      const coinciden = lista.filter((p) =>
        polizaCoincide(p, sesion, cot.createdAt, ahora),
      );
      const distintas = new Set(
        coinciden.map((p) => String(p.cnpoliza).trim()),
      );
      if (distintas.size === 0) r.sinPoliza++;
      else if (distintas.size > 1) r.ambiguas++;
      else hallazgos.push({ cot, poliza: coinciden[0] });
    } catch (err) {
      r.errores++;
      logger.warn(
        `[expedientes] perdidas: consulta falló cotizacion=${cot.id}: ${err instanceof Error ? err.message : 'error'}`,
      );
    }
  }

  // Una póliza candidata de varias sesiones = ambigua (no se asigna a ninguna).
  const porPoliza = new Map<string, Hallazgo[]>();
  for (const h of hallazgos) {
    const k = `${h.cot.empresaId}|${String(h.poliza.cnpoliza).trim()}`;
    porPoliza.set(k, [...(porPoliza.get(k) ?? []), h]);
  }

  for (const grupo of porPoliza.values()) {
    const { cot, poliza } = grupo[0];
    const cnpoliza = String(poliza.cnpoliza).trim();
    if (grupo.length > 1) {
      r.ambiguas += grupo.length;
      continue;
    }
    const yaEstaba = await prisma.emision.findFirst({
      where: { empresaId: cot.empresaId, polizaNumero: cnpoliza },
    });
    if (yaEstaba) {
      r.yaRegistradas++;
      continue;
    }
    if (r.detalle.length < 50)
      r.detalle.push({
        cotizacionId: cot.id,
        cnpoliza,
        accion: escribir ? 'registrada' : 'registraria',
      });
    if (!escribir) continue;
    try {
      await registrarPerdida(cot, poliza, ahora);
      r.registradas++;
      logger.warn(
        `[expedientes] perdidas: póliza ${cnpoliza} registrada desde la cotización ${cot.id} (conciliación)`,
      );
    } catch (err) {
      r.errores++;
      await svc.eventoTecnico({
        etapa: 'conciliacion_perdidas',
        cotizacionId: cot.id,
        error: err instanceof Error ? err.message.slice(0, 300) : 'error',
      });
    }
  }
  return r;
}

async function registrarPerdida(
  cot: { id: number; empresaId: number; jsonData: unknown },
  poliza: PolizaVehiculo,
  ahora: Date,
): Promise<void> {
  const cnpoliza = String(poliza.cnpoliza).trim();
  const jd = rec(cot.jsonData);
  const policy = {
    number: cnpoliza,
    cnpoliza,
    ...(txt(poliza.cnrecibo)
      ? { cnrecibo: String(poliza.cnrecibo).trim() }
      : {}),
    ...(txt(poliza.urlpoliza)
      ? { urlpoliza: String(poliza.urlpoliza).trim() }
      : {}),
    recuperadaPorConciliacion: true,
  };

  // Igual que syncSessionToDb: la cotización queda emitida y enlazada a la póliza.
  await prisma.cotizacion.update({
    where: { id: cot.id },
    data: { jsonData: { ...jd, policy } as object, estado: 'emitida' },
  });
  const pago = await prisma.pago.findFirst({ where: { cotizacionId: cot.id } });
  const emision = await prisma.emision.create({
    data: {
      empresaId: cot.empresaId,
      cotizacionId: cot.id,
      pagoId: pago?.id,
      polizaNumero: cnpoliza,
      estado: 'emitida',
      jsonData: {
        producto: 'rcv',
        ...policy,
        origen: 'conciliacion_perdidas',
        conciliadaEn: ahora.toISOString(),
      } as object,
    },
  });

  const exp = await svc.registrarDesdeEmision(
    emision,
    { producto: 'rcv', cnrecibo: txt(poliza.cnrecibo) },
    'conciliacion',
  );
  if (exp) {
    // Sin solicitud inicial ni recordatorios al cliente: la cadencia nace agotada.
    await prisma.mktExpediente.update({
      where: { id: exp.id },
      data: { cadenciaAgotada: true },
    });
    await svc.evento(exp.id, 'emision_recuperada', 'conciliacion', {
      cotizacionId: cot.id,
      sinCorreos: true,
    });
  }
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

let ultimaTanda: string | null = null;

/** Una tanda por bloque de `cadaMin` minutos (hora de Caracas). */
export function claveTandaPerdidas(ahora: Date, cadaMin: number): string {
  const { fecha, hora } = caracasParts(ahora);
  const [hh, mm] = hora.split(':').map(Number);
  return `${fecha}~x${Math.floor((hh * 60 + mm) / Math.max(1, cadaMin))}`;
}

/** Clave de la tanda si toca correr ahora (apagada, fuera de horario o ya corrida = null). */
export function tandaPerdidasDebida(ahora: Date): string | null {
  const cfg = perdidasConfig();
  if (!cfg.enabled) return null;
  if (!dentroDeVentana(caracasParts(ahora).hora, cfg.ventana)) return null;
  const clave = claveTandaPerdidas(ahora, cfg.cadaMin);
  return ultimaTanda === clave ? null : clave;
}

export function marcarTandaPerdidas(clave: string): void {
  ultimaTanda = clave;
}

/** Solo pruebas. */
export function _resetPerdidas(): void {
  ultimaTanda = null;
  buscarPorDefecto = null;
}
