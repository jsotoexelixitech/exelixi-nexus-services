/**
 * Carga histórica 2026 del monitor (23-nov-2026): todas las pólizas de Sis2000 emitidas por canales
 * digitales desde EXPEDIENTES_HISTORICO_DESDE, clasificadas en «pasó por el OCR» / «no pasó por el
 * OCR», con totales por mes y por origen.
 *
 * Fuente: nest-api GET /api/v1/canal/polizas-historicas (scope expedientes:historico), paginado por
 * keyset; una fila por versión de póliza: aquí se cuenta UNA vez por cnpoliza (la primera versión
 * vista, que es la de fingreso más antiguo porque nest-api ordena por fingreso).
 *
 * Decisiones (ver informe de entrega):
 * - Tabla liviana `mkt_poliza_historica` (sin nombre, documento, correo ni teléfono). NUNCA se crea
 *   un expediente desde aquí: cero correos y cero filas nuevas para indicadores()/recordatorios.
 * - Origen: `nexus` si la póliza ya está en mkt_expediente o en emision; `marketplace_sysip` si
 *   cprog = MarkPl; `nest_api` el resto (SysIP, integradores...).
 * - «Pasó por el OCR»: expediente del monitor con carpeta o documentos (o el OCR la localiza por
 *   carpeta de póliza o {cédula}/pendiente); «no pasó»: expediente descartado o sin rastro en el OCR.
 *   La pregunta al OCR es la misma de la conciliación (POST /api/internal/expedientes/localizar),
 *   solo lectura, con el cnpoliza y la cédula/RIF del tomador que manda nest-api (no se guarda).
 * - Reanudable: el cursor de nest-api y los contadores viven en mkt_expediente_config
 *   (clave `carga_historica`). Re-correr no duplica (único por cnpoliza; lo ya clasificado no se
 *   vuelve a consultar).
 * - Lenta a propósito: adpoliza no tiene índice por fingreso, cada página recorre la tabla. Pausa
 *   entre páginas y entre consultas al OCR, tope por corrida, ventana nocturna y se detiene ante
 *   errores seguidos de nest-api o del OCR.
 */
import type { MktPolizaHistorica, Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';
import logger from '../../utils/logger';
import { caracasParts, ESTADO_DESCARTADA } from './expedientes.domain';
import {
  HistoricoConfig,
  historicoConfig,
  historicoMotivoApagado,
  ocrInternalConfig,
} from './expedientes.env';
import { localizarEnOcr } from './expedientes.files';
import { cedulasCandidatas } from './expedientes.service';

// ─── Tipos y reglas puras ───────────────────────────────────────────────────

export const ORIGENES_HISTORICO = [
  'nexus',
  'nest_api',
  'marketplace_sysip',
] as const;
export type OrigenHistorico = (typeof ORIGENES_HISTORICO)[number];

export const ETIQUETA_ORIGEN: Record<OrigenHistorico, string> = {
  nexus: 'Nexus (flujo Exélixi)',
  nest_api: 'nest-api (SysIP e integradores)',
  marketplace_sysip: 'MarketPlace SysIP',
};

export const RESULTADOS_HISTORICO = [
  'pendiente',
  'paso_ocr',
  'no_paso_ocr',
  'error',
] as const;
export type ResultadoHistorico = (typeof RESULTADOS_HISTORICO)[number];

/** Resultados que se vuelven a consultar si la póliza reaparece (reanudar o reiniciar). */
const RESULTADOS_ABIERTOS: ResultadoHistorico[] = ['pendiente', 'error'];

/** Póliza tal como la entrega nest-api (solo lo que se usa). */
export interface PolizaNest {
  cnpoliza: string;
  cramo: number | null;
  cprog: string | null;
  /** 'YYYY-MM-DD HH:mm:ss.mmm' hora local de Sis2000. */
  fingreso: string;
  tomador: { tipoDocumento: string | null; numeroDocumento: string | null };
  ccanalalt: number | null;
  cproductor: number | null;
}

/** nexus si ya está en el monitor o en emision; MarkPl = MarketPlace de SysIP; el resto nest-api. */
export function origenDe(
  cprog: string | null | undefined,
  enNexus: boolean,
): OrigenHistorico {
  if (enNexus) return 'nexus';
  if (
    String(cprog ?? '')
      .trim()
      .toUpperCase() === 'MARKPL'
  )
    return 'marketplace_sysip';
  return 'nest_api';
}

const PATRON_FINGRESO =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;

/** 'YYYY-MM' del fingreso de Sis2000, o null si no tiene formato. */
export function mesDe(fingreso: string): string | null {
  const m = PATRON_FINGRESO.exec(String(fingreso ?? '').trim());
  return m ? `${m[1]}-${m[2]}` : null;
}

/** fingreso (hora local de Sis2000) como timestamp sin zona: se guarda la hora tal cual. */
export function fechaIngreso(fingreso: string): Date | null {
  const m = PATRON_FINGRESO.exec(String(fingreso ?? '').trim());
  if (!m) return null;
  const ms = Number((m[7] ?? '0').padEnd(3, '0'));
  const d = new Date(
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ¿La hora de Caracas 'HH:MM' cae en la ventana? (puede cruzar la medianoche). */
export function dentroDeVentana(
  hora: string,
  ventana: { inicio: string; fin: string },
): boolean {
  const { inicio, fin } = ventana;
  if (inicio === fin) return true;
  return inicio < fin
    ? hora >= inicio && hora < fin
    : hora >= inicio || hora < fin;
}

/** Clave de la tanda del scheduler: una por bloque de `cadaMin` minutos (hora de Caracas). */
export function claveTandaHistorica(ahora: Date, cadaMin: number): string {
  const { fecha, hora } = caracasParts(ahora);
  const [hh, mm] = hora.split(':').map(Number);
  return `${fecha}~h${Math.floor((hh * 60 + mm) / Math.max(1, cadaMin))}`;
}

function texto(v: unknown, max: number): string | null {
  const s = v == null ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
}

function numero(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Ítem de nest-api → PolizaNest; null si no trae cnpoliza o fingreso válido. */
export function normalizarPoliza(raw: unknown): PolizaNest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const cnpoliza = texto(r.cnpoliza, 30);
  const fingreso = String(r.fingreso ?? '').trim();
  if (!cnpoliza || !mesDe(fingreso)) return null;
  const t =
    r.tomador && typeof r.tomador === 'object'
      ? (r.tomador as Record<string, unknown>)
      : {};
  return {
    cnpoliza,
    cramo: numero(r.cramo),
    cprog: texto(r.cprog, 20),
    fingreso,
    tomador: {
      tipoDocumento: texto(t.tipoDocumento, 2),
      numeroDocumento: texto(t.numeroDocumento, 20),
    },
    ccanalalt: numero(r.ccanalalt),
    cproductor: numero(r.cproductor),
  };
}

// ─── nest-api ───────────────────────────────────────────────────────────────

/** Sin índice por fingreso cada página puede tardar: margen amplio antes de darla por fallida. */
const TIMEOUT_NEST_MS = 180_000;

export function urlPolizasHistoricas(
  cfg: Pick<HistoricoConfig, 'nestUrl' | 'desde' | 'limit'>,
  hasta: string | null,
  cursor: string | null,
): string {
  const base = cfg.nestUrl.replace(/\/+$/, '').replace(/\/api$/, '');
  const u = new URL(`${base}/api/v1/canal/polizas-historicas`);
  u.searchParams.set('desde', cfg.desde);
  if (hasta) u.searchParams.set('hasta', hasta);
  u.searchParams.set('limit', String(cfg.limit));
  if (cursor) u.searchParams.set('cursor', cursor);
  return u.toString();
}

export async function leerPaginaNest(
  cfg: HistoricoConfig,
  hasta: string | null,
  cursor: string | null,
): Promise<{
  items: PolizaNest[];
  nextCursor: string | null;
  descartadas: number;
}> {
  const res = await fetch(urlPolizasHistoricas(cfg, hasta, cursor), {
    headers: { apikey: cfg.nestKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_NEST_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.status === false) {
    // Sin cuerpo en el mensaje: puede traer datos de la consulta.
    throw new Error(`nest-api respondió HTTP ${res.status}`);
  }
  const data = (
    body.data && typeof body.data === 'object' ? body.data : body
  ) as Record<string, unknown>;
  if (!Array.isArray(data.items))
    throw new Error('nest-api: respuesta sin items');
  const items: PolizaNest[] = [];
  for (const raw of data.items) {
    const p = normalizarPoliza(raw);
    if (p) items.push(p);
  }
  const next =
    typeof data.nextCursor === 'string' && data.nextCursor.trim()
      ? data.nextCursor.trim()
      : null;
  return {
    items,
    nextCursor: next,
    descartadas: data.items.length - items.length,
  };
}

// ─── Estado de la carga (mkt_expediente_config, clave carga_historica) ──────

export const CLAVE_ESTADO_HISTORICO = 'carga_historica';
/** Corridas seguidas abortadas por errores que dejan la carga «detenida» (hasta reanudar). */
export const MAX_CORRIDAS_CON_ERROR = 3;

export interface EstadoCargaHistorica {
  estado: 'sin_iniciar' | 'en_curso' | 'completada' | 'detenida';
  /** Fecha de inicio con la que se armó el cursor (si cambia la variable, se empieza de nuevo). */
  desde: string | null;
  /** Corte exclusivo fijado al arrancar ('YYYY-MM-DD'). */
  hasta: string | null;
  cursor: string | null;
  paginas: number;
  filasLeidas: number;
  nuevas: number;
  corridasConError: number;
  ultimoError: string | null;
  ultimaCorrida: string | null;
  enCursoDesde: string | null;
  completadaEn: string | null;
}

export function estadoInicial(): EstadoCargaHistorica {
  return {
    estado: 'sin_iniciar',
    desde: null,
    hasta: null,
    cursor: null,
    paginas: 0,
    filasLeidas: 0,
    nuevas: 0,
    corridasConError: 0,
    ultimoError: null,
    ultimaCorrida: null,
    enCursoDesde: null,
    completadaEn: null,
  };
}

export async function leerEstadoHistorico(): Promise<EstadoCargaHistorica> {
  const row = await prisma.mktExpedienteConfig.findUnique({
    where: { clave: CLAVE_ESTADO_HISTORICO },
  });
  const v =
    row?.valor && typeof row.valor === 'object' && !Array.isArray(row.valor)
      ? (row.valor as Partial<EstadoCargaHistorica>)
      : {};
  return { ...estadoInicial(), ...v };
}

async function guardarEstado(
  estado: EstadoCargaHistorica,
  actor = 'carga_historica',
): Promise<void> {
  const data = {
    valor: estado as unknown as Prisma.InputJsonValue,
    actualizadoPor: actor.slice(0, 128),
  };
  try {
    await prisma.mktExpedienteConfig.update({
      where: { clave: CLAVE_ESTADO_HISTORICO },
      data,
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2025') throw err;
    await prisma.mktExpedienteConfig.create({
      data: { clave: CLAVE_ESTADO_HISTORICO, ...data },
    });
  }
}

// ─── Clasificación de una página ────────────────────────────────────────────

interface ContextoClasificacion {
  /** false = vista previa: no escribe nada. */
  escribir: boolean;
  /** Cuántas pólizas se pueden consultar al OCR todavía (Infinity en ejecución). */
  ocrRestante: number;
  pausaOcrMs: number;
  maxErrores: number;
  /** Errores seguidos del OCR (se arrastra entre páginas). */
  erroresOcrSeguidos: number;
  empresaId: number;
}

export interface ConteoPagina {
  filas: number;
  polizas: number;
  /** Ya clasificadas (paso/no paso) en una corrida anterior: no se tocan. */
  yaClasificadas: number;
  nuevas: number;
  actualizadas: number;
  pasoOcr: number;
  noPasoOcr: number;
  pendientes: number;
  errores: number;
  consultasOcr: number;
  porMes: Record<string, number>;
  porOrigen: Record<string, number>;
  porCprog: Record<string, number>;
}

export function conteoVacio(): ConteoPagina {
  return {
    filas: 0,
    polizas: 0,
    yaClasificadas: 0,
    nuevas: 0,
    actualizadas: 0,
    pasoOcr: 0,
    noPasoOcr: 0,
    pendientes: 0,
    errores: 0,
    consultasOcr: 0,
    porMes: {},
    porOrigen: {},
    porCprog: {},
  };
}

function sumar(a: ConteoPagina, b: ConteoPagina): ConteoPagina {
  const mapa = (x: Record<string, number>, y: Record<string, number>) => {
    const out = { ...x };
    for (const [k, v] of Object.entries(y)) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  return {
    filas: a.filas + b.filas,
    polizas: a.polizas + b.polizas,
    yaClasificadas: a.yaClasificadas + b.yaClasificadas,
    nuevas: a.nuevas + b.nuevas,
    actualizadas: a.actualizadas + b.actualizadas,
    pasoOcr: a.pasoOcr + b.pasoOcr,
    noPasoOcr: a.noPasoOcr + b.noPasoOcr,
    pendientes: a.pendientes + b.pendientes,
    errores: a.errores + b.errores,
    consultasOcr: a.consultasOcr + b.consultasOcr,
    porMes: mapa(a.porMes, b.porMes),
    porOrigen: mapa(a.porOrigen, b.porOrigen),
    porCprog: mapa(a.porCprog, b.porCprog),
  };
}

/** El OCR falló `maxErrores` veces seguidas: la corrida se detiene sin avanzar el cursor. */
export class OcrHistoricoCaidoError extends Error {
  constructor(public readonly parcial: ConteoPagina) {
    super('El OCR falló varias veces seguidas');
    this.name = 'OcrHistoricoCaidoError';
  }
}

const inc = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

let dormir = (ms: number) =>
  ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

/** Solo pruebas: reemplaza la espera (para no dormir de verdad). */
export function _setDormirHistorico(fn: (ms: number) => Promise<void>): void {
  dormir = fn;
}

/**
 * Clasifica una página de nest-api. Una vez por cnpoliza; lo ya clasificado (paso/no paso) no se
 * vuelve a consultar ni se reescribe. Nunca crea expedientes ni toca la cadencia de correos.
 */
export async function clasificarPagina(
  items: PolizaNest[],
  ctx: ContextoClasificacion,
): Promise<ConteoPagina> {
  const c = conteoVacio();
  c.filas = items.length;
  const unicas = new Map<string, PolizaNest>();
  for (const p of items) if (!unicas.has(p.cnpoliza)) unicas.set(p.cnpoliza, p);
  c.polizas = unicas.size;
  if (!unicas.size) return c;
  const cns = [...unicas.keys()];

  const existentes = new Map<string, MktPolizaHistorica>(
    (
      await prisma.mktPolizaHistorica.findMany({
        where: { cnpoliza: { in: cns } },
      })
    ).map((r) => [r.cnpoliza, r]),
  );
  const abiertas = cns.filter((cn) => {
    const e = existentes.get(cn);
    return (
      !e || RESULTADOS_ABIERTOS.includes(e.resultado as ResultadoHistorico)
    );
  });
  c.yaClasificadas = cns.length - abiertas.length;
  const abiertasSet = new Set(abiertas);

  const expedientes = abiertas.length
    ? await prisma.mktExpediente.findMany({
        where: { cnpoliza: { in: abiertas } },
        select: {
          id: true,
          empresaId: true,
          cnpoliza: true,
          cnrecibo: true,
          estadoDocumental: true,
          carpetaExpediente: true,
          aseguradoDocumento: true,
        },
      })
    : [];
  const expDe = new Map(expedientes.map((e) => [e.cnpoliza, e]));
  const emisiones = abiertas.length
    ? await prisma.emision.findMany({
        where: { polizaNumero: { in: abiertas } },
        select: { polizaNumero: true },
      })
    : [];
  const enEmision = new Set(
    emisiones.map((e) => String(e.polizaNumero).trim()),
  );
  const conDocumentos = new Set(
    expedientes.length
      ? (
          await prisma.mktExpedienteRequisito.findMany({
            where: {
              expedienteId: { in: expedientes.map((e) => e.id) },
              ref: { not: null },
            },
            select: { expedienteId: true },
          })
        ).map((r) => r.expedienteId)
      : [],
  );

  for (const cn of cns) {
    const p = unicas.get(cn)!;
    const mes = mesDe(p.fingreso)!;
    const existente = existentes.get(cn) ?? null;
    const exp = expDe.get(cn) ?? null;
    const origen = existente
      ? origenDe(
          p.cprog,
          !!exp || enEmision.has(cn) || existente.origen === 'nexus',
        )
      : origenDe(p.cprog, !!exp || enEmision.has(cn));
    inc(c.porMes, mes);
    inc(c.porOrigen, origen);
    inc(c.porCprog, (p.cprog ?? 'sin_cprog').toUpperCase());
    if (!abiertasSet.has(cn)) continue;

    let resultado: ResultadoHistorico = 'pendiente';
    let ubicacionOcr: string | null = null;
    let consultado = false;
    if (exp && exp.estadoDocumental === ESTADO_DESCARTADA) {
      resultado = 'no_paso_ocr';
      ubicacionOcr = 'monitor';
    } else if (exp && (exp.carpetaExpediente || conDocumentos.has(exp.id))) {
      resultado = 'paso_ocr';
      ubicacionOcr = 'monitor';
    } else if (ctx.ocrRestante > 0) {
      ctx.ocrRestante--;
      consultado = true;
      c.consultasOcr++;
      try {
        const loc = await localizarEnOcr({
          cnpoliza: cn,
          cnrecibo: exp?.cnrecibo ?? null,
          cedulas: cedulasCandidatas([
            p.tomador.numeroDocumento,
            p.tomador.tipoDocumento && p.tomador.numeroDocumento
              ? `${p.tomador.tipoDocumento}-${p.tomador.numeroDocumento}`
              : null,
            exp?.aseguradoDocumento,
          ]),
          empresaId: exp?.empresaId ?? ctx.empresaId,
        });
        ctx.erroresOcrSeguidos = 0;
        resultado = loc.ubicacion ? 'paso_ocr' : 'no_paso_ocr';
        ubicacionOcr = loc.ubicacion;
      } catch {
        ctx.erroresOcrSeguidos++;
        resultado = 'error';
      }
      await dormir(ctx.pausaOcrMs);
    }

    if (resultado === 'paso_ocr') c.pasoOcr++;
    else if (resultado === 'no_paso_ocr') c.noPasoOcr++;
    else if (resultado === 'error') c.errores++;
    else c.pendientes++;

    if (ctx.escribir) {
      const datos = {
        cramo: p.cramo,
        cprog: p.cprog,
        origen,
        resultado,
        ubicacionOcr,
        expedienteId: exp?.id ?? null,
        ccanalalt: p.ccanalalt != null ? String(p.ccanalalt) : null,
        cproductor: p.cproductor != null ? String(p.cproductor) : null,
        ...(consultado ? { consultadoEn: new Date() } : {}),
      };
      if (existente) {
        await prisma.mktPolizaHistorica.update({
          where: { id: existente.id },
          data: {
            ...datos,
            ...(consultado ? { intentos: { increment: 1 } } : {}),
          },
        });
        c.actualizadas++;
      } else {
        try {
          await prisma.mktPolizaHistorica.create({
            data: {
              ...datos,
              cnpoliza: cn,
              fingreso: fechaIngreso(p.fingreso)!,
              mes,
              intentos: consultado ? 1 : 0,
            },
          });
          c.nuevas++;
        } catch (err) {
          // Otra corrida la creó primero: idempotente, no se duplica.
          if ((err as { code?: string }).code !== 'P2002') throw err;
        }
      }
    } else if (!existente) c.nuevas++;

    if (ctx.erroresOcrSeguidos >= ctx.maxErrores)
      throw new OcrHistoricoCaidoError(c);
  }
  return c;
}

/** Empresa de La Mundial en Nexus (la del monitor); solo orienta al OCR, que busca en todas. */
async function empresaDelMonitor(): Promise<number> {
  try {
    const e = await prisma.mktExpediente.findFirst({
      orderBy: { id: 'desc' },
      select: { empresaId: true },
    });
    return e?.empresaId ?? 0;
  } catch {
    return 0;
  }
}

/** Corte exclusivo: el de la variable, o el día de hoy (Caracas) fijado al arrancar. */
function corteDe(
  estado: EstadoCargaHistorica,
  cfg: HistoricoConfig,
  ahora: Date,
): string {
  return estado.hasta ?? cfg.hasta ?? caracasParts(ahora).fecha;
}

// ─── Ejecución por tandas ───────────────────────────────────────────────────

export type ResultadoCarga =
  | { omitido: true; motivo: string }
  | {
      omitido: false;
      motivoFin:
        | 'tope_corrida'
        | 'completada'
        | 'fuera_de_ventana'
        | 'tiempo'
        | 'error_nest'
        | 'error_ocr'
        | 'error_interno';
      paginas: number;
      conteo: ConteoPagina;
      estado: EstadoCargaHistorica['estado'];
      error?: string;
    };

let corriendo = false;

export function cargaHistoricaCorriendo(): boolean {
  return corriendo;
}

/**
 * Una tanda de la carga: lee páginas desde el cursor guardado hasta `porCorrida` filas, el fin de
 * la ventana, `maxMinutos` o errores seguidos. Guarda el cursor tras cada página ya clasificada.
 * Si el OCR cae a mitad de página, el cursor NO avanza (la página se repite y lo ya clasificado se
 * salta). `ignorarVentana` solo lo usa la prueba manual fuera de producción.
 */
export async function ejecutarCargaHistorica(
  opts: { ahora?: Date; ignorarVentana?: boolean; actor?: string } = {},
): Promise<ResultadoCarga> {
  const cfg = historicoConfig();
  if (!cfg)
    return { omitido: true, motivo: historicoMotivoApagado() ?? 'apagada' };
  if (!ocrInternalConfig())
    return {
      omitido: true,
      motivo: 'OCR_INTERNAL_URL / EXPEDIENTE_INTERNAL_KEY sin configurar',
    };
  if (corriendo) return { omitido: true, motivo: 'en_curso' };
  const inicio = opts.ahora ?? new Date();
  const reloj = () => (opts.ahora ? opts.ahora : new Date());
  let estado = await leerEstadoHistorico();
  if (estado.desde && estado.desde !== cfg.desde) {
    // Cambió EXPEDIENTES_HISTORICO_DESDE: cursor nuevo (las filas ya clasificadas se conservan).
    estado = estadoInicial();
  }
  if (estado.estado === 'completada')
    return { omitido: true, motivo: 'completada' };
  if (estado.estado === 'detenida')
    return { omitido: true, motivo: 'detenida' };
  if (
    !opts.ignorarVentana &&
    !dentroDeVentana(caracasParts(inicio).hora, cfg.ventana)
  )
    return { omitido: true, motivo: 'fuera_de_ventana' };
  if (
    estado.enCursoDesde &&
    inicio.getTime() - new Date(estado.enCursoDesde).getTime() <
      (cfg.maxMinutos + 10) * 60_000
  )
    return { omitido: true, motivo: 'en_curso' };

  corriendo = true;
  const actor = opts.actor ?? 'carga_historica';
  estado = {
    ...estado,
    estado: 'en_curso',
    desde: cfg.desde,
    hasta: corteDe(estado, cfg, inicio),
    enCursoDesde: inicio.toISOString(),
  };
  let conteo = conteoVacio();
  let paginas = 0;
  let motivoFin: Exclude<ResultadoCarga, { omitido: true }>['motivoFin'] =
    'tope_corrida';
  let error: string | undefined;
  try {
    await guardarEstado(estado, actor);
    const ctx: ContextoClasificacion = {
      escribir: true,
      ocrRestante: Number.POSITIVE_INFINITY,
      pausaOcrMs: cfg.pausaOcrMs,
      maxErrores: cfg.maxErrores,
      erroresOcrSeguidos: 0,
      empresaId: await empresaDelMonitor(),
    };
    let erroresNest = 0;
    for (;;) {
      // motivoFin sigue en 'tope_corrida'.
      if (conteo.filas >= cfg.porCorrida) break;
      if (reloj().getTime() - inicio.getTime() > cfg.maxMinutos * 60_000) {
        motivoFin = 'tiempo';
        break;
      }
      let pagina;
      try {
        pagina = await leerPaginaNest(cfg, estado.hasta, estado.cursor);
        erroresNest = 0;
      } catch (err) {
        erroresNest++;
        error = err instanceof Error ? err.message.slice(0, 300) : 'error';
        logger.warn(
          `[expedientes] carga histórica: nest-api falló (${erroresNest}/${cfg.maxErrores}): ${error}`,
        );
        if (erroresNest >= cfg.maxErrores) {
          motivoFin = 'error_nest';
          break;
        }
        await dormir(cfg.pausaPaginaMs);
        continue;
      }
      try {
        conteo = sumar(conteo, await clasificarPagina(pagina.items, ctx));
      } catch (err) {
        if (!(err instanceof OcrHistoricoCaidoError)) throw err;
        conteo = sumar(conteo, err.parcial);
        motivoFin = 'error_ocr';
        error = 'El OCR falló varias veces seguidas';
        break;
      }
      paginas++;
      estado = {
        ...estado,
        cursor: pagina.nextCursor,
        paginas: estado.paginas + 1,
        filasLeidas: estado.filasLeidas + pagina.items.length,
      };
      if (!pagina.nextCursor) {
        estado = {
          ...estado,
          estado: 'completada',
          completadaEn: reloj().toISOString(),
        };
        motivoFin = 'completada';
        await guardarEstado(
          { ...estado, nuevas: estado.nuevas + conteo.nuevas },
          actor,
        );
        break;
      }
      await guardarEstado(
        { ...estado, nuevas: estado.nuevas + conteo.nuevas },
        actor,
      );
      if (
        !opts.ignorarVentana &&
        !dentroDeVentana(caracasParts(reloj()).hora, cfg.ventana)
      ) {
        motivoFin = 'fuera_de_ventana';
        break;
      }
      if (conteo.filas < cfg.porCorrida) await dormir(cfg.pausaPaginaMs);
    }
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 300) : 'error';
    motivoFin = 'error_interno';
  } finally {
    const conError = motivoFin.startsWith('error_');
    const corridasConError = conError ? estado.corridasConError + 1 : 0;
    estado = {
      ...estado,
      nuevas: estado.nuevas + conteo.nuevas,
      corridasConError,
      ultimoError: conError ? (error ?? 'error') : estado.ultimoError,
      ultimaCorrida: reloj().toISOString(),
      enCursoDesde: null,
      estado:
        estado.estado === 'completada'
          ? 'completada'
          : corridasConError >= MAX_CORRIDAS_CON_ERROR
            ? 'detenida'
            : 'en_curso',
    };
    try {
      await guardarEstado(estado, actor);
    } catch (e) {
      logger.error(
        `[expedientes] carga histórica: no se pudo guardar el estado: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}`,
      );
    }
    corriendo = false;
  }
  logger.info(
    `[expedientes] carga histórica: ${paginas} página(s), ${conteo.filas} filas, ${conteo.nuevas} nuevas, ` +
      `${conteo.pasoOcr} pasaron OCR, ${conteo.noPasoOcr} no, ${conteo.errores} errores (${motivoFin})`,
  );
  return {
    omitido: false,
    motivoFin,
    paginas,
    conteo,
    estado: estado.estado,
    ...(error && motivoFin.startsWith('error_') ? { error } : {}),
  };
}

// ─── Vista previa (no escribe nada) ─────────────────────────────────────────

export interface VistaPrevia {
  desde: string;
  hasta: string;
  /** Desde dónde se leyó: el cursor guardado o el inicio. */
  inicio: 'cursor_guardado' | 'inicio';
  paginas: number;
  hayMas: boolean;
  conteo: ConteoPagina;
  /** Pólizas consultadas al OCR como muestra (solo lectura). */
  muestraOcr: number;
  ritmo: {
    limit: number;
    porCorrida: number;
    pausaPaginaMs: number;
    pausaOcrMs: number;
    ventana: string;
    cadaMin: number;
  };
}

/**
 * Lee hasta `maxPaginas` páginas de nest-api y cuenta (por mes, origen y cprog) cuántas pólizas hay
 * y cuántas faltan por clasificar. NO escribe nada (ni filas ni estado). Con `muestraOcr` pregunta
 * al OCR (solo lectura) por las primeras N sin clasificar.
 */
export async function vistaPreviaHistorica(
  opts: {
    maxPaginas?: number;
    muestraOcr?: number;
    desdeInicio?: boolean;
    ahora?: Date;
  } = {},
): Promise<VistaPrevia> {
  const cfg = historicoConfig();
  if (!cfg)
    throw new Error(historicoMotivoApagado() ?? 'Carga histórica apagada');
  const estadoGuardado = await leerEstadoHistorico();
  const mismoDesde =
    !estadoGuardado.desde || estadoGuardado.desde === cfg.desde;
  const usarCursor = !opts.desdeInicio && mismoDesde && !!estadoGuardado.cursor;
  const hasta = corteDe(
    mismoDesde ? estadoGuardado : estadoInicial(),
    cfg,
    opts.ahora ?? new Date(),
  );
  const maxPaginas = Math.min(
    20,
    Math.max(1, Math.floor(opts.maxPaginas ?? 1)),
  );
  const muestra = Math.min(50, Math.max(0, Math.floor(opts.muestraOcr ?? 0)));
  const ctx: ContextoClasificacion = {
    escribir: false,
    ocrRestante: ocrInternalConfig() ? muestra : 0,
    pausaOcrMs: cfg.pausaOcrMs,
    maxErrores: Number.POSITIVE_INFINITY,
    erroresOcrSeguidos: 0,
    empresaId: await empresaDelMonitor(),
  };
  let cursor = usarCursor ? estadoGuardado.cursor : null;
  let conteo = conteoVacio();
  let paginas = 0;
  let hayMas = true;
  while (paginas < maxPaginas) {
    if (paginas > 0) await dormir(cfg.pausaPaginaMs);
    const pagina = await leerPaginaNest(cfg, hasta, cursor);
    conteo = sumar(conteo, await clasificarPagina(pagina.items, ctx));
    paginas++;
    cursor = pagina.nextCursor;
    hayMas = !!cursor;
    if (!cursor) break;
  }
  return {
    desde: cfg.desde,
    hasta,
    inicio: usarCursor ? 'cursor_guardado' : 'inicio',
    paginas,
    hayMas,
    conteo,
    muestraOcr: conteo.consultasOcr,
    ritmo: {
      limit: cfg.limit,
      porCorrida: cfg.porCorrida,
      pausaPaginaMs: cfg.pausaPaginaMs,
      pausaOcrMs: cfg.pausaOcrMs,
      ventana: `${cfg.ventana.inicio}-${cfg.ventana.fin}`,
      cadaMin: cfg.cadaMin,
    },
  };
}

/** Última vista previa pedida desde el monitor (en memoria del proceso; corre en segundo plano). */
export interface EstadoVistaPrevia {
  enCurso: boolean;
  iniciadaEn: string;
  terminadaEn?: string;
  actor: string;
  resultado?: VistaPrevia;
  error?: string;
}
let ultimaVistaPrevia: EstadoVistaPrevia | null = null;

export function estadoVistaPrevia(): EstadoVistaPrevia | null {
  return ultimaVistaPrevia;
}

/** Lanza la vista previa en segundo plano (la página de nest-api puede tardar más que el proxy). */
export function iniciarVistaPrevia(
  opts: Parameters<typeof vistaPreviaHistorica>[0] & { actor: string },
): { iniciada: boolean; estado: EstadoVistaPrevia } {
  if (ultimaVistaPrevia?.enCurso)
    return { iniciada: false, estado: ultimaVistaPrevia };
  const actual: EstadoVistaPrevia = {
    enCurso: true,
    iniciadaEn: new Date().toISOString(),
    actor: opts.actor.slice(0, 128),
  };
  ultimaVistaPrevia = actual;
  const p = vistaPreviaHistorica(opts)
    .then((r) => {
      actual.resultado = r;
    })
    .catch((err) => {
      actual.error = err instanceof Error ? err.message.slice(0, 300) : 'error';
    })
    .finally(() => {
      actual.enCurso = false;
      actual.terminadaEn = new Date().toISOString();
    });
  void p;
  return { iniciada: true, estado: actual };
}

/** Solo pruebas. */
export function _resetHistorico(): void {
  ultimaVistaPrevia = null;
  corriendo = false;
}

// ─── Acciones del administrador ─────────────────────────────────────────────

/** Tras «detenida» (errores seguidos): vuelve a dejarla en curso desde el mismo cursor. */
export async function reanudarCargaHistorica(
  actor: string,
): Promise<EstadoCargaHistorica> {
  if (corriendo) throw new AppError('La carga está corriendo.', 409);
  const e = await leerEstadoHistorico();
  const nuevo: EstadoCargaHistorica = {
    ...e,
    estado:
      e.estado === 'completada'
        ? 'completada'
        : e.cursor || e.paginas
          ? 'en_curso'
          : 'sin_iniciar',
    corridasConError: 0,
    enCursoDesde: null,
  };
  await guardarEstado(nuevo, actor);
  return nuevo;
}

/**
 * Vuelve a recorrer desde el inicio (cursor nulo, corte nuevo). No borra filas: lo ya clasificado
 * se salta y solo se reconsultan las pendientes o con error.
 */
export async function reiniciarCargaHistorica(
  actor: string,
): Promise<EstadoCargaHistorica> {
  if (corriendo) throw new AppError('La carga está corriendo.', 409);
  const nuevo = estadoInicial();
  await guardarEstado(nuevo, actor);
  return nuevo;
}

// ─── Resumen por mes y origen ───────────────────────────────────────────────

export interface CifrasHistorico {
  total: number;
  pasoOcr: number;
  noPasoOcr: number;
  pendientes: number;
  errores: number;
  /** pasoOcr / (pasoOcr + noPasoOcr): solo sobre las ya clasificadas; null sin clasificadas. */
  pctPasoOcr: number | null;
}

export interface FilaHistorico extends CifrasHistorico {
  mes: string;
  origen: OrigenHistorico | string;
}

export interface ResumenHistorico {
  totales: CifrasHistorico;
  porMes: (CifrasHistorico & { mes: string })[];
  porOrigen: (CifrasHistorico & { origen: string })[];
  /** Mes × origen. */
  filas: FilaHistorico[];
}

function cifrasVacias(): CifrasHistorico {
  return {
    total: 0,
    pasoOcr: 0,
    noPasoOcr: 0,
    pendientes: 0,
    errores: 0,
    pctPasoOcr: null,
  };
}

function acumular(c: CifrasHistorico, resultado: string, n: number) {
  c.total += n;
  if (resultado === 'paso_ocr') c.pasoOcr += n;
  else if (resultado === 'no_paso_ocr') c.noPasoOcr += n;
  else if (resultado === 'error') c.errores += n;
  else c.pendientes += n;
}

function conPct<T extends CifrasHistorico>(c: T): T {
  const base = c.pasoOcr + c.noPasoOcr;
  return { ...c, pctPasoOcr: base > 0 ? c.pasoOcr / base : null };
}

/** Agrupa (mes, origen, resultado, cantidad) en totales, por mes, por origen y mes × origen. */
export function armarResumenHistorico(
  grupos: { mes: string; origen: string; resultado: string; n: number }[],
): ResumenHistorico {
  const totales = cifrasVacias();
  const porMes = new Map<string, CifrasHistorico & { mes: string }>();
  const porOrigen = new Map<string, CifrasHistorico & { origen: string }>();
  const filas = new Map<string, FilaHistorico>();
  for (const g of grupos) {
    acumular(totales, g.resultado, g.n);
    const m = porMes.get(g.mes) ?? { ...cifrasVacias(), mes: g.mes };
    acumular(m, g.resultado, g.n);
    porMes.set(g.mes, m);
    const o = porOrigen.get(g.origen) ?? {
      ...cifrasVacias(),
      origen: g.origen,
    };
    acumular(o, g.resultado, g.n);
    porOrigen.set(g.origen, o);
    const k = `${g.mes}|${g.origen}`;
    const f = filas.get(k) ?? {
      ...cifrasVacias(),
      mes: g.mes,
      origen: g.origen,
    };
    acumular(f, g.resultado, g.n);
    filas.set(k, f);
  }
  const ordenOrigen = (o: string) => {
    const i = (ORIGENES_HISTORICO as readonly string[]).indexOf(o);
    return i < 0 ? 99 : i;
  };
  return {
    totales: conPct(totales),
    porMes: [...porMes.values()]
      .sort((a, b) => a.mes.localeCompare(b.mes))
      .map(conPct),
    porOrigen: [...porOrigen.values()]
      .sort((a, b) => ordenOrigen(a.origen) - ordenOrigen(b.origen))
      .map(conPct),
    filas: [...filas.values()]
      .sort(
        (a, b) =>
          a.mes.localeCompare(b.mes) ||
          ordenOrigen(a.origen) - ordenOrigen(b.origen),
      )
      .map(conPct),
  };
}

/** Resumen desde la tabla liviana (un groupBy: no carga filas en memoria). */
export async function resumenHistorico(): Promise<ResumenHistorico> {
  const grupos = await prisma.mktPolizaHistorica.groupBy({
    by: ['mes', 'origen', 'resultado'],
    _count: { _all: true },
  });
  return armarResumenHistorico(
    grupos.map((g) => ({
      mes: g.mes,
      origen: g.origen,
      resultado: g.resultado,
      n: g._count._all,
    })),
  );
}

/** Lo que ve el monitor: resumen + estado de la carga (sin cursor ni datos personales). */
export async function vistaHistorico() {
  const cfg = historicoConfig();
  const [resumen, estado] = await Promise.all([
    resumenHistorico(),
    leerEstadoHistorico(),
  ]);
  const vp = estadoVistaPrevia();
  return {
    habilitada: !!cfg,
    motivoApagado: cfg ? null : historicoMotivoApagado(),
    etiquetasOrigen: ETIQUETA_ORIGEN,
    carga: {
      estado: estado.estado,
      desde: estado.desde ?? cfg?.desde ?? null,
      hasta: estado.hasta,
      paginas: estado.paginas,
      filasLeidas: estado.filasLeidas,
      nuevas: estado.nuevas,
      corridasConError: estado.corridasConError,
      ultimoError: estado.ultimoError,
      ultimaCorrida: estado.ultimaCorrida,
      enCurso: corriendo || !!estado.enCursoDesde,
      completadaEn: estado.completadaEn,
      ventana: cfg ? `${cfg.ventana.inicio}-${cfg.ventana.fin}` : null,
    },
    vistaPrevia: vp,
    ...resumen,
  };
}
