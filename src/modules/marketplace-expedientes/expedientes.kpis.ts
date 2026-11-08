/**
 * KPI del monitor de expedientes (solo agregados, sin listas de pólizas).
 * Respeta el mismo filtro que la bandeja (área en alcance y fechas de emisión).
 * Regla: si un dato no se puede calcular bien, va `null` (la pantalla dice «sin dato»).
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import { caracasInicioDia, caracasParts } from './expedientes.domain';

const DIA_MS = 86_400_000;
/** Correos de la cadencia (la notificación «prueba» y los avisos de evento no cuentan). */
export const TIPOS_RECORDATORIO = ['solicitud_inicial', 'recordatorio'];
const TOP = 5;
const DIAS_TENDENCIA = 30;

export interface TopItem {
  codigo: string;
  incompletos: number;
  total: number;
}

export interface KpisExpedientes {
  /** completos / (completos + incompletos), 0..1; sin_informacion no cuenta. */
  tasaCompletitud: number | null;
  tiempoMedioCompletarDias: number | null;
  completadosUltimos7Dias: number;
  /** recuperados / expedientes que recibieron al menos un recordatorio enviado, 0..1. */
  tasaRecuperacion: number | null;
  /** Expedientes distintos por resultado de los correos de la cadencia. */
  recordatorios: {
    recibieron: number;
    recuperados: number;
    enviados: number;
    error: number;
    bloqueados: number;
    sinCorreo: number;
    agotados: number;
    excluidos: number;
    noEnviar: number;
  };
  porProducto: {
    producto: string;
    total: number;
    completos: number;
    incompletos: number;
  }[];
  porDocumento: {
    tipo: string;
    faltante: number;
    recibido: number;
    observado: number;
    validado: number;
  }[];
  topIncompletos: {
    canales: TopItem[];
    gestores: TopItem[];
    productores: TopItem[];
  };
  /** Últimos 30 días (hora Caracas) que terminan en `hasta` o hoy. */
  tendencia: { fecha: string; emitidas: number; completadas: number }[];
}

const ratio = (n: number, d: number) =>
  d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null;

type GrupoCount = { _count: { _all: number } };

async function topPor(
  campo: 'ccanalalt' | 'cgestor' | 'cproductor',
  where: Prisma.MktExpedienteWhereInput,
): Promise<TopItem[]> {
  const rows = (await prisma.mktExpediente.groupBy({
    by: [campo, 'estadoDocumental'],
    where: { AND: [where, { [campo]: { not: null } }] },
    _count: { _all: true },
  })) as unknown as (GrupoCount & Record<string, string | null>)[];
  const m = new Map<string, TopItem>();
  for (const r of rows) {
    const codigo = String(r[campo] ?? '').trim();
    if (!codigo) continue;
    const it = m.get(codigo) ?? { codigo, incompletos: 0, total: 0 };
    it.total += r._count._all;
    if (r.estadoDocumental === 'incompleto') it.incompletos += r._count._all;
    m.set(codigo, it);
  }
  return [...m.values()]
    .filter((x) => x.incompletos > 0)
    .sort(
      (a, b) =>
        b.incompletos - a.incompletos ||
        b.total - a.total ||
        a.codigo.localeCompare(b.codigo),
    )
    .slice(0, TOP);
}

export async function calcularKpis(args: {
  where: Prisma.MktExpedienteWhereInput;
  /** Ids del filtro (ya cargados por `indicadores`): notificaciones y requisitos no tienen relación filtrable. */
  ids: number[];
  noEnviar: number;
  /** Fin de la ventana de tendencia (YYYY-MM-DD, Caracas). */
  hasta?: string;
  ahora?: Date;
}): Promise<KpisExpedientes> {
  const { where, ids } = args;
  const ahora = args.ahora ?? new Date();
  const hoy = caracasParts(ahora).fecha;
  const finDia = args.hasta && args.hasta < hoy ? args.hasta : hoy;
  const finVentana = new Date(caracasInicioDia(finDia).getTime() + DIA_MS);
  const iniVentana = new Date(finVentana.getTime() - DIAS_TENDENCIA * DIA_MS);
  // Tendencia: solo el filtro de área (la ventana de 30 días es la de fechas).
  const whereArea: Prisma.MktExpedienteWhereInput = { area: where.area };
  const conIds = ids.length > 0;

  const [
    porProdEstado,
    completados7,
    tiempos,
    agotados,
    notifs,
    reqs,
    canales,
    gestores,
    productores,
    emitidas30,
    completadas30,
  ] = await Promise.all([
    prisma.mktExpediente.groupBy({
      by: ['producto', 'estadoDocumental'],
      where,
      _count: { _all: true },
    }),
    prisma.mktExpediente.count({
      where: {
        AND: [
          where,
          {
            estadoDocumental: 'completo',
            completadoEn: { gte: new Date(ahora.getTime() - 7 * DIA_MS) },
          },
        ],
      },
    }),
    // Prisma no promedia fechas: solo 2 columnas de los completos con fecha.
    prisma.mktExpediente.findMany({
      where: {
        AND: [
          where,
          { estadoDocumental: 'completo', completadoEn: { not: null } },
        ],
      },
      select: { emitidaEn: true, completadoEn: true },
    }),
    prisma.mktExpediente.count({
      where: { AND: [where, { cadenciaAgotada: true }] },
    }),
    conIds
      ? prisma.mktExpedienteNotificacion.groupBy({
          by: ['resultado', 'expedienteId'],
          where: {
            expedienteId: { in: ids },
            tipo: { in: TIPOS_RECORDATORIO },
          },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    conIds
      ? prisma.mktExpedienteRequisito.groupBy({
          by: ['tipo', 'estado'],
          where: { expedienteId: { in: ids } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    topPor('ccanalalt', where),
    topPor('cgestor', where),
    topPor('cproductor', where),
    prisma.mktExpediente.findMany({
      where: { ...whereArea, emitidaEn: { gte: iniVentana, lt: finVentana } },
      select: { emitidaEn: true },
    }),
    prisma.mktExpediente.findMany({
      where: {
        ...whereArea,
        estadoDocumental: 'completo',
        completadoEn: { gte: iniVentana, lt: finVentana },
      },
      select: { completadoEn: true },
    }),
  ]);

  // Por producto y completitud.
  const prod = new Map<
    string,
    { producto: string; total: number; completos: number; incompletos: number }
  >();
  let completos = 0;
  let incompletos = 0;
  for (const r of porProdEstado as unknown as (GrupoCount & {
    producto: string;
    estadoDocumental: string;
  })[]) {
    const n = r._count._all;
    const p = prod.get(r.producto) ?? {
      producto: r.producto,
      total: 0,
      completos: 0,
      incompletos: 0,
    };
    p.total += n;
    if (r.estadoDocumental === 'completo') {
      p.completos += n;
      completos += n;
    }
    if (r.estadoDocumental === 'incompleto') {
      p.incompletos += n;
      incompletos += n;
    }
    prod.set(r.producto, p);
  }

  // Tiempo medio: descarta fechas incoherentes (completado antes de emitir).
  const difs = tiempos
    .map((t) =>
      t.completadoEn ? t.completadoEn.getTime() - t.emitidaEn.getTime() : -1,
    )
    .filter((d) => d >= 0);
  const tiempoMedio = difs.length
    ? Math.round(
        (difs.reduce((a, d) => a + d, 0) / difs.length / DIA_MS) * 10,
      ) / 10
    : null;

  // Recordatorios: expedientes distintos por resultado.
  const porResultado = new Map<string, Set<number>>();
  for (const n of notifs as unknown as {
    resultado: string;
    expedienteId: number | null;
  }[]) {
    if (n.expedienteId == null) continue;
    const s = porResultado.get(n.resultado) ?? new Set<number>();
    s.add(n.expedienteId);
    porResultado.set(n.resultado, s);
  }
  const cuenta = (r: string) => porResultado.get(r)?.size ?? 0;
  const recibieronIds = [...(porResultado.get('enviado') ?? [])];
  const recuperados = recibieronIds.length
    ? await prisma.mktExpediente.count({
        where: {
          AND: [
            where,
            { id: { in: recibieronIds }, estadoDocumental: 'completo' },
          ],
        },
      })
    : 0;

  // Documentos por estado.
  const docs = new Map<string, KpisExpedientes['porDocumento'][number]>();
  for (const r of reqs as unknown as (GrupoCount & {
    tipo: string;
    estado: string;
  })[]) {
    if (!['faltante', 'recibido', 'observado', 'validado'].includes(r.estado))
      continue;
    const d = docs.get(r.tipo) ?? {
      tipo: r.tipo,
      faltante: 0,
      recibido: 0,
      observado: 0,
      validado: 0,
    };
    d[r.estado as 'faltante'] += r._count._all;
    docs.set(r.tipo, d);
  }

  // Tendencia por día Caracas.
  const dias = new Map<string, { emitidas: number; completadas: number }>();
  for (let i = DIAS_TENDENCIA - 1; i >= 0; i--) {
    const f = caracasParts(
      new Date(finVentana.getTime() - (i + 1) * DIA_MS + 1),
    ).fecha;
    dias.set(f, { emitidas: 0, completadas: 0 });
  }
  for (const e of emitidas30) {
    const d = dias.get(caracasParts(e.emitidaEn).fecha);
    if (d) d.emitidas++;
  }
  for (const e of completadas30) {
    if (!e.completadoEn) continue;
    const d = dias.get(caracasParts(e.completadoEn).fecha);
    if (d) d.completadas++;
  }

  return {
    tasaCompletitud: ratio(completos, completos + incompletos),
    tiempoMedioCompletarDias: tiempoMedio,
    completadosUltimos7Dias: completados7,
    tasaRecuperacion: ratio(recuperados, recibieronIds.length),
    recordatorios: {
      recibieron: recibieronIds.length,
      recuperados,
      enviados: cuenta('enviado'),
      error: cuenta('error'),
      bloqueados: cuenta('bloqueado_whitelist'),
      sinCorreo: cuenta('sin_correo'),
      agotados,
      excluidos: cuenta('excluido'),
      noEnviar: args.noEnviar,
    },
    porProducto: [...prod.values()].sort((a, b) => b.total - a.total),
    porDocumento: [...docs.values()].sort(
      (a, b) => b.faltante + b.observado - (a.faltante + a.observado),
    ),
    topIncompletos: { canales, gestores, productores },
    tendencia: [...dias.entries()].map(([fecha, v]) => ({ fecha, ...v })),
  };
}
