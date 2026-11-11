/**
 * Datos del reporte nocturno «Control documental diario» (correo 6, plantilla
 * `expediente-reporte-diario` de nest-api). Un reporte por grupo:
 * - canales: pólizas de canal, gestor (cuenta en su canal) y sin datos de quién emitió, según el
 *   alcance de la configuración. Es el reporte que va a Canales.
 * - productores: intermediarios. Listo pero apagado hasta su aprobación (ver expedientes.env).
 *
 * El asegurado sale protegido (iniciales y documento parcial; nunca correo ni teléfono). Nada de
 * esto se escribe en logs. Reglas de La Mundial: «Emitida por» (nunca «vendedor») y sin
 * «Sin información».
 */
import type {
  MktExpediente,
  MktExpedienteExclusion,
  MktExpedienteRequisito,
} from '@prisma/client';
import prisma from '../../config/prisma';
import { CatalogoCanales, catalogoCanales } from './expedientes.canales';
import {
  CATEGORIAS_INCOMPLETO,
  CategoriaIncompleto,
  categoriaIncompleto,
  desgloseIncompletos,
} from './expedientes.categorias';
import {
  AlcanceConfig,
  AreaExpediente,
  aseguradoProtegido,
  areasEnAlcance,
  canalDeExpediente,
  textoActorEmisor,
  caracasInicioDia,
  caracasParts,
  diasCaracasEntre,
  emailValido,
  ESTADO_DESCARTADA,
  ExpedientesConfig,
  grupoArea,
  productorDeExpediente,
  proximoEnvio,
  requisitoLabel,
  requisitosAplicables,
  SIN_IDENTIFICAR,
} from './expedientes.domain';
import { conDatosModificados, diagnosticoVigente } from './expedientes.ia';
import { estaExcluido, nombreActorDeSnapshot } from './expedientes.service';

type Exp = MktExpediente;
type Req = MktExpedienteRequisito;
type ReqLike = Pick<Req, 'tipo' | 'estado'> &
  Partial<
    Pick<Req, 'motivo' | 'ref' | 'decision' | 'diagnostico' | 'analisisRef'>
  >;

export type GrupoReporte = 'canales' | 'productores';
export const GRUPOS_REPORTE: GrupoReporte[] = ['canales', 'productores'];

/** Filas del listado de incompletas de hoy en el correo; el resto se ve en el monitor. */
export const MAX_FILAS_REPORTE = 200;

/** Correos al asegurado (los del resumen y las pruebas no cuentan). */
export const TIPOS_NO_ASEGURADO = ['resumen_nocturno', 'prueba'];

export interface FilaReporte {
  poliza: string;
  /** Protegido: «M. P. · V-12•••678». */
  asegurado: string;
  producto: string;
  emitidaPor: string;
  observacion: string;
  dias: number;
  intentos: number;
  ultimoResultado: string;
  noEnviar: boolean;
  siguienteAccion: string;
}

export interface ReporteDiario {
  grupo: GrupoReporte;
  /** Rótulo del asunto: «Canales» o «Productores». */
  areas: string;
  /** Día del reporte (YYYY-MM-DD, hora de Caracas). */
  fecha: string;
  /** DD/MM/AAAA. */
  fechaLocal: string;
  /** «DD/MM/AAAA HH:MM» del corte (hora de Caracas). */
  corte: string;
  dia: {
    emitidas: number;
    completas: number;
    incompletas: number;
    sinDatos: number;
  };
  /** Documentos pendientes de las pólizas incompletas de hoy. */
  distribucion: {
    faltantes: number;
    ilegibles: number;
    inconsistentes: number;
    porValidar: number;
  };
  polizas: FilaReporte[];
  polizasRestantes: number;
  cartera: {
    total: number;
    completos: number;
    incompletos: number;
    sinDatos: number;
    desglose: { label: string; valor: number }[];
  };
  historicos: {
    anteriores: number;
    sinRespuesta: number;
    sinCorreoValido: number;
    noEnviar: number;
  };
  /** Todas las áreas: la emisión de Nexus no guarda el área. */
  conciliacion: {
    emisionesNexus: number;
    enMonitor: number;
    noPasaronOcr: number;
    sinVinculo: number;
  };
  entregabilidad: {
    intentos: number;
    entregados: number;
    conError: number;
    sinCorreo: number;
    bloqueados: number;
    excluidos: number;
  };
  tecnicos: { documentosNoLeidos: number; fallasTecnicas: number };
  enlace: string | null;
}

// ─── Grupo y rótulo ─────────────────────────────────────────────────────────

/** Los gestores trabajan para los canales: cuentan en Canales, nunca como área aparte. */
export function areasDeGrupo(
  grupo: GrupoReporte,
  alcance: AlcanceConfig,
): AreaExpediente[] {
  if (grupo === 'productores') return ['productor'];
  return areasEnAlcance(alcance).filter((a) => a !== 'productor');
}

export function rotuloGrupo(
  grupo: GrupoReporte,
  alcance: AlcanceConfig,
): string {
  if (grupo === 'productores') return 'Productores';
  return alcance.canales ? 'Canales' : 'Marketplace';
}

/** YYYY-MM-DD → DD/MM/AAAA. */
export function fechaLocal(fecha: string): string {
  return `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}/${fecha.slice(0, 4)}`;
}

// ─── Fila del listado (reglas puras) ────────────────────────────────────────

const PRODUCTO_LABEL: Record<string, string> = {
  rcv: 'RCV',
  personas: 'Personas',
  patrimonial: 'Patrimoniales',
};

const DOC_CORTO: Record<string, string> = {
  cedula: 'cédula',
  cedula_titular: 'cédula del titular',
  cedula_beneficiario: 'cédula del beneficiario',
  licencia: 'licencia',
  certificado: 'certificado de circulación',
  rif: 'RIF',
  pasaporte: 'pasaporte',
  factura: 'factura',
};

const RE_ILEGIBLE = /leer|legib|nitid|borros/i;

function recortar(v: string, max: number): string {
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

function docCorto(tipo: string): string {
  return DOC_CORTO[tipo] ?? requisitoLabel(tipo).toLowerCase();
}

function mayus(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function enLista(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function productoLabel(e: Pick<Exp, 'producto' | 'snapshot'>): string {
  const base = PRODUCTO_LABEL[e.producto] ?? e.producto;
  const plan = rec(e.snapshot).plan;
  return recortar(
    typeof plan === 'string' && plan.trim() ? `${base} · ${plan.trim()}` : base,
    40,
  );
}

/** Observado por ilegible o sin certeza (la IA), o por un motivo manual que lo dice. */
export function esIlegible(r: ReqLike): boolean {
  const d = diagnosticoVigente(r);
  if (d && (d.resultado === 'ilegible' || d.resultado === 'sin_certeza'))
    return true;
  return !conDatosModificados(r) && RE_ILEGIBLE.test(r.motivo ?? '');
}

function problemaObservado(r: ReqLike): string {
  const doc = mayus(docCorto(r.tipo));
  const d = diagnosticoVigente(r);
  if (d?.resultado === 'sin_certeza') return `${doc}: no se pudo confirmar`;
  if (esIlegible(r)) return `${doc} ilegible`;
  if (d?.resultado === 'no_coincide') {
    const campos = d.campos ?? [];
    if (campos.some((c) => c.campo === 'tipoDocumento' && c.coincide === false))
      return `${doc}: no es el documento solicitado`;
    const otros = campos.filter(
      (c) => c.coincide === false && c.campo !== 'vencimiento',
    );
    if (!otros.length && campos.some((c) => c.campo === 'vencimiento'))
      return `${doc}: documento vencido`;
    return `${doc}: datos no coinciden con la póliza`;
  }
  return `${doc}: con observación del analista`;
}

function aplicablesDe(
  e: Pick<Exp, 'producto'>,
  reqs: ReqLike[],
  config: ExpedientesConfig,
): ReqLike[] {
  const porTipo = new Map(reqs.map((r) => [r.tipo, r]));
  // Igual que calcularEstadoDocumental: el requisito aplicable sin fila cuenta como faltante.
  return requisitosAplicables(e.producto, config).map(
    (tipo) => porTipo.get(tipo) ?? { tipo, estado: 'faltante' },
  );
}

/** Motivo corto: «Falta cédula», «Licencia ilegible», «No se pudo leer el archivo (cédula)»… */
export function observacionCorta(
  e: Pick<Exp, 'producto' | 'estadoDocumental'>,
  reqs: ReqLike[],
  config: ExpedientesConfig,
): string {
  const aplicables = aplicablesDe(e, reqs, config);
  const faltan = aplicables
    .filter((r) => r.estado === 'faltante')
    .map((r) => docCorto(r.tipo));
  const textoFaltan = faltan.length
    ? `${faltan.length > 1 ? 'Faltan' : 'Falta'} ${enLista(faltan)}`
    : '';
  const observados = aplicables.filter((r) => r.estado === 'observado');
  const recibidos = aplicables.filter((r) => r.estado === 'recibido');
  let principal: string;
  switch (categoriaIncompleto(e, reqs, config)) {
    case 'conErrores':
      principal = observados
        .filter((r) => !conDatosModificados(r))
        .map(problemaObservado)
        .join('; ');
      break;
    case 'datosCambiados':
      principal = `Datos cambiados en la póliza (${enLista(observados.map((r) => docCorto(r.tipo)))})`;
      break;
    case 'noLeidos':
      principal = `No se pudo leer el archivo (${enLista(
        recibidos
          .filter((r) => diagnosticoVigente(r)?.resultado === 'error_tecnico')
          .map((r) => docCorto(r.tipo)),
      )})`;
      break;
    case 'porValidar':
      principal = `Por validar: ${enLista(recibidos.map((r) => docCorto(r.tipo)))}`;
      break;
    case 'analizando':
      principal = `En revisión automática: ${enLista(recibidos.map((r) => docCorto(r.tipo)))}`;
      break;
    case 'faltanDocumentos':
      return recortar(textoFaltan, 120);
    default:
      principal = 'Revisar el expediente';
  }
  const extra = textoFaltan
    ? `; ${textoFaltan.charAt(0).toLowerCase()}${textoFaltan.slice(1)}`
    : '';
  return recortar(`${principal}${extra}`, 120);
}

const RESULTADO_LABEL: Record<string, string> = {
  enviado: 'Enviado',
  sin_correo: 'Sin correo válido',
  bloqueado_whitelist: 'Bloqueado',
  error: 'Con error',
  rebotado: 'Con error',
  excluido: 'Excluido',
};

/** Último resultado del correo al asegurado; sin intentos: «Aún no enviado». */
export function ultimoResultadoLabel(resultado?: string | null): string {
  return (resultado && RESULTADO_LABEL[resultado]) || 'Aún no enviado';
}

/** Canal (nombre del catálogo), productor, o el usuario que emitió si no hay canal. */
export function emitidaPor(
  e: Pick<
    Exp,
    | 'area'
    | 'centidad'
    | 'citem'
    | 'cgestor'
    | 'ccanalalt'
    | 'cproductor'
    | 'xlogin'
    | 'cusuario'
    | 'snapshot'
  >,
  catalogo?: CatalogoCanales | null,
): string {
  const usuario = e.xlogin || (e.cusuario ? `Usuario ${e.cusuario}` : null);
  const gestorOProductor = () =>
    textoActorEmisor(
      e,
      catalogo
        ? {
            canal: catalogo.nombres,
            gestor: catalogo.gestorNombre ?? null,
            gestorCanal: catalogo.gestorCanal,
          }
        : null,
      {
        gestor: nombreActorDeSnapshot(e.snapshot, 'gestor'),
        productor: nombreActorDeSnapshot(e.snapshot, 'intermediario'),
      },
    );
  const g = grupoArea(e.area);
  if (g === 'productor') {
    const cod = productorDeExpediente(e);
    return (
      nombreActorDeSnapshot(e.snapshot, 'intermediario') ??
      (cod !== SIN_IDENTIFICAR ? `Productor ${cod}` : null) ??
      usuario ??
      'Productor sin identificar'
    );
  }
  if (g === 'canal') {
    const cod = canalDeExpediente(e, catalogo?.gestorCanal);
    return (
      (cod !== SIN_IDENTIFICAR ? catalogo?.nombres.get(cod) : null) ??
      nombreActorDeSnapshot(e.snapshot, 'canal') ??
      (cod !== SIN_IDENTIFICAR ? `Canal ${cod}` : null) ??
      // Gestor sin canal resuelto: el gestor antes que el cusuario de Sis2000.
      gestorOProductor() ??
      usuario ??
      'Canal sin identificar'
    );
  }
  return gestorOProductor() ?? usuario ?? 'No identificado';
}

/** Próxima corrida de la tarea diaria (recordatorios) después de `ahora`. */
function proximaCorridaDiaria(ahora: Date, horaDiaria: string): Date {
  const [hh, mm] = horaDiaria.split(':').map(Number);
  const hoy = caracasInicioDia(caracasParts(ahora).fecha).getTime();
  const corrida = new Date(hoy + (hh * 60 + mm) * 60_000);
  return corrida > ahora ? corrida : new Date(corrida.getTime() + 86_400_000);
}

export function siguienteAccion(
  e: Pick<
    Exp,
    'aseguradoEmail' | 'cadenciaAgotada' | 'emitidaEn' | 'etapaEnviada'
  >,
  opts: {
    excluido: boolean;
    config: ExpedientesConfig;
    ahora: Date;
    grupo: GrupoReporte;
  },
): string {
  if (opts.excluido) return 'Excluido de correos';
  if (!emailValido(e.aseguradoEmail))
    return `Sin correo válido: gestionar por ${opts.grupo === 'productores' ? 'el productor' : 'el canal'}`;
  const prox = e.cadenciaAgotada
    ? null
    : proximoEnvio(
        e.emitidaEn,
        opts.config.cadenciaDias,
        e.etapaEnviada,
        opts.config.horaDiaria,
      );
  if (!prox) return 'Recordatorios agotados: escalar';
  const corrida = proximaCorridaDiaria(opts.ahora, opts.config.horaDiaria);
  return `Recordatorio el ${fechaLocal(caracasParts(prox > corrida ? prox : corrida).fecha)}`;
}

// ─── Desglose de la cartera ─────────────────────────────────────────────────

/** Las mismas etiquetas del resumen del monitor. */
const CATEGORIA_LABEL: Record<CategoriaIncompleto, string> = {
  conErrores: 'Con errores',
  datosCambiados: 'Datos cambiados',
  noLeidos: 'No se pudo leer',
  porValidar: 'Por validar',
  analizando: 'Analizando',
  faltanDocumentos: 'Faltan documentos',
  otros: 'Otros',
};

/** Solo de la validación automática / manual; «Otros» solo si hay. */
const CATEGORIA_MODO: Partial<
  Record<CategoriaIncompleto, ExpedientesConfig['validacion'] | 'siHay'>
> = {
  noLeidos: 'automatica',
  analizando: 'automatica',
  porValidar: 'manual',
  otros: 'siHay',
};

function desgloseVisible(
  d: Record<CategoriaIncompleto, number>,
  validacion: ExpedientesConfig['validacion'],
): { label: string; valor: number }[] {
  return CATEGORIAS_INCOMPLETO.filter((c) => {
    if (d[c] > 0) return true;
    const modo = CATEGORIA_MODO[c];
    return !modo || modo === validacion;
  }).map((c) => ({ label: CATEGORIA_LABEL[c], valor: d[c] }));
}

// ─── Armado (lee la BD) ─────────────────────────────────────────────────────

async function requisitosDe(ids: number[]): Promise<Map<number, Req[]>> {
  const map = new Map<number, Req[]>();
  if (!ids.length) return map;
  const rows = await prisma.mktExpedienteRequisito.findMany({
    where: { expedienteId: { in: ids } },
  });
  for (const r of rows) {
    const l = map.get(r.expedienteId) ?? [];
    l.push(r);
    map.set(r.expedienteId, l);
  }
  return map;
}

/** Nexus vs monitor del día, todas las áreas (la emisión no guarda el área). */
async function conciliacionDelDia(
  inicio: Date,
  fin: Date,
): Promise<ReporteDiario['conciliacion']> {
  const [emisiones, expedientes] = await Promise.all([
    prisma.emision.findMany({
      where: { createdAt: { gte: inicio, lt: fin } },
      select: { empresaId: true, polizaNumero: true },
    }),
    prisma.mktExpediente.findMany({
      where: { emitidaEn: { gte: inicio, lt: fin } },
      select: { estadoDocumental: true },
    }),
  ]);
  const poliza = (v: unknown) => String(v ?? '').trim();
  const numeros = Array.from(
    new Set(emisiones.map((e) => poliza(e.polizaNumero)).filter(Boolean)),
  );
  const vinculadas = numeros.length
    ? await prisma.mktExpediente.findMany({
        where: { cnpoliza: { in: numeros } },
        select: { empresaId: true, cnpoliza: true },
      })
    : [];
  const claves = new Set(vinculadas.map((v) => `${v.empresaId}|${v.cnpoliza}`));
  return {
    emisionesNexus: emisiones.length,
    enMonitor: expedientes.filter(
      (x) => x.estadoDocumental !== ESTADO_DESCARTADA,
    ).length,
    noPasaronOcr: expedientes.filter(
      (x) => x.estadoDocumental === ESTADO_DESCARTADA,
    ).length,
    sinVinculo: emisiones.filter(
      (e) => !claves.has(`${e.empresaId}|${poliza(e.polizaNumero)}`),
    ).length,
  };
}

export async function armarReporteDiario(
  grupo: GrupoReporte,
  opts: {
    config: ExpedientesConfig;
    /** Día del reporte (YYYY-MM-DD, Caracas). */
    fecha: string;
    /** Momento del corte. */
    ahora: Date;
    exclusiones: MktExpedienteExclusion[];
  },
): Promise<ReporteDiario> {
  const { config, fecha, ahora, exclusiones } = opts;
  const inicio = caracasInicioDia(fecha);
  const fin = new Date(inicio.getTime() + 86_400_000);
  const enDia = (d: Date) => d >= inicio && d < fin;
  const areas = areasDeGrupo(grupo, config.alcance);

  // Descartadas (no pasaron por el OCR): fuera de la cartera y del día; solo en la conciliación.
  const cartera = areas.length
    ? await prisma.mktExpediente.findMany({
        where: {
          area: { in: areas },
          estadoDocumental: { not: ESTADO_DESCARTADA },
        },
      })
    : [];
  const incompletos = cartera.filter(
    (e) => e.estadoDocumental === 'incompleto',
  );
  const hoy = cartera.filter((e) => enDia(e.emitidaEn));
  const incompletasHoy = incompletos.filter((e) => enDia(e.emitidaEn));
  const reqs = await requisitosDe(incompletos.map((e) => e.id));
  const reqsDe = (e: Exp) => reqs.get(e.id) ?? [];
  const excluido = (e: Exp) => estaExcluido(e, exclusiones);

  // Distribución por documento de las incompletas de hoy.
  const distribucion = {
    faltantes: 0,
    ilegibles: 0,
    inconsistentes: 0,
    porValidar: 0,
  };
  for (const e of incompletasHoy) {
    for (const r of aplicablesDe(e, reqsDe(e), config)) {
      if (r.estado === 'faltante') distribucion.faltantes++;
      else if (r.estado === 'recibido') distribucion.porValidar++;
      else if (r.estado === 'observado') {
        if (esIlegible(r)) distribucion.ilegibles++;
        else distribucion.inconsistentes++;
      }
    }
  }

  // Último correo al asegurado por póliza (de las incompletas de hoy).
  const ids = incompletasHoy.map((e) => e.id);
  const ultimas = ids.length
    ? await prisma.mktExpedienteNotificacion.findMany({
        where: {
          expedienteId: { in: ids },
          tipo: { notIn: TIPOS_NO_ASEGURADO },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { expedienteId: true, resultado: true },
      })
    : [];
  const ultimaDe = new Map<number, string>();
  for (const n of ultimas) {
    if (n.expedienteId != null && !ultimaDe.has(n.expedienteId))
      ultimaDe.set(n.expedienteId, n.resultado);
  }

  const catalogo = incompletasHoy.some((e) => grupoArea(e.area) === 'canal')
    ? await catalogoCanales()
    : null;
  const prioridad = (e: Exp) => {
    const c = categoriaIncompleto(e, reqsDe(e), config);
    return c ? CATEGORIAS_INCOMPLETO.indexOf(c) : CATEGORIAS_INCOMPLETO.length;
  };
  // Primero lo que está mal, luego lo que falta; dentro, por hora de emisión.
  const ordenadas = [...incompletasHoy].sort(
    (a, b) =>
      prioridad(a) - prioridad(b) ||
      a.emitidaEn.getTime() - b.emitidaEn.getTime() ||
      a.id - b.id,
  );
  const polizas: FilaReporte[] = ordenadas
    .slice(0, MAX_FILAS_REPORTE)
    .map((e) => {
      const ex = excluido(e);
      return {
        poliza: e.cnpoliza,
        asegurado: aseguradoProtegido(e),
        producto: productoLabel(e),
        emitidaPor: recortar(emitidaPor(e, catalogo), 80),
        observacion: observacionCorta(e, reqsDe(e), config),
        dias: Math.max(0, diasCaracasEntre(e.emitidaEn, ahora)),
        intentos: e.intentos,
        ultimoResultado: ultimoResultadoLabel(ultimaDe.get(e.id)),
        noEnviar: ex,
        siguienteAccion: siguienteAccion(e, {
          excluido: ex,
          config,
          ahora,
          grupo,
        }),
      };
    });

  // Entregabilidad del día: correos al asegurado de este grupo.
  const idsGrupo = new Set(cartera.map((e) => e.id));
  const notifsDia = (
    await prisma.mktExpedienteNotificacion.findMany({
      where: {
        createdAt: { gte: inicio, lt: fin },
        tipo: { notIn: TIPOS_NO_ASEGURADO },
      },
      select: { expedienteId: true, resultado: true },
    })
  ).filter((n) => n.expedienteId != null && idsGrupo.has(n.expedienteId));
  const cuenta = (...resultados: string[]) =>
    notifsDia.filter((n) => resultados.includes(n.resultado)).length;

  const automatica = config.validacion === 'automatica';
  const documentosNoLeidos = automatica
    ? incompletos.reduce(
        (a, e) =>
          a +
          aplicablesDe(e, reqsDe(e), config).filter(
            (r) =>
              r.estado === 'recibido' &&
              !!r.ref &&
              r.decision !== 'manual' &&
              diagnosticoVigente(r)?.resultado === 'error_tecnico',
          ).length,
        0,
      )
    : 0;

  const [conciliacion, fallasTecnicas] = await Promise.all([
    conciliacionDelDia(inicio, fin),
    prisma.mktExpedienteEvento.count({
      where: { tipo: 'error_tecnico', createdAt: { gte: inicio, lt: fin } },
    }),
  ]);

  const { hora } = caracasParts(ahora);
  return {
    grupo,
    areas: rotuloGrupo(grupo, config.alcance),
    fecha,
    fechaLocal: fechaLocal(fecha),
    corte: `${fechaLocal(caracasParts(ahora).fecha)} ${hora}`,
    dia: {
      emitidas: hoy.length,
      completas: hoy.filter((e) => e.estadoDocumental === 'completo').length,
      incompletas: incompletasHoy.length,
      sinDatos: hoy.filter((e) => e.estadoDocumental === 'sin_informacion')
        .length,
    },
    distribucion,
    polizas,
    polizasRestantes: Math.max(0, incompletasHoy.length - polizas.length),
    cartera: {
      total: cartera.length,
      completos: cartera.filter((e) => e.estadoDocumental === 'completo')
        .length,
      incompletos: incompletos.length,
      sinDatos: cartera.filter((e) => e.estadoDocumental === 'sin_informacion')
        .length,
      desglose: desgloseVisible(
        desgloseIncompletos(incompletos, reqsDe, config),
        config.validacion,
      ),
    },
    historicos: {
      anteriores: incompletos.filter((e) => e.emitidaEn < inicio).length,
      sinRespuesta: incompletos.filter(
        (e) =>
          e.cadenciaAgotada && emailValido(e.aseguradoEmail) && !excluido(e),
      ).length,
      sinCorreoValido: incompletos.filter((e) => !emailValido(e.aseguradoEmail))
        .length,
      noEnviar: incompletos.filter(excluido).length,
    },
    conciliacion,
    entregabilidad: {
      intentos: cuenta('enviado', 'error', 'bloqueado_whitelist'),
      entregados: cuenta('enviado'),
      conError: cuenta('error', 'rebotado'),
      sinCorreo: cuenta('sin_correo'),
      bloqueados: cuenta('bloqueado_whitelist'),
      excluidos: cuenta('excluido'),
    },
    tecnicos: { documentosNoLeidos, fallasTecnicas },
    // El correo no remite a ninguna pantalla (solo la ven Luis, Yennifer y el usuario).
    enlace: null,
  };
}

// ─── Versión simple (pedido de La Mundial, 9-nov-2026) ─────────────────────
//
// «Yo solo quiero decir quién no cargó el expediente»: el correo lleva solo cuatro cifras y el
// detalle va en un Excel adjunto (expedientes.excel). El Excel sí trae nombre y documento del
// asegurado (lo pidió La Mundial); nunca correo ni teléfono, y nada de esto va a logs.

export type AreaReporte = 'Canales' | 'Productores' | 'Sin datos';

export interface CifrasControl {
  completados: number;
  incompletos: number;
  canales: { completos: number; incompletos: number };
  productores: { completos: number; incompletos: number };
  /** Pólizas sin datos de quién las emitió (área desconocida). */
  sinDatos: number;
}

export interface FilaIncompleto {
  poliza: string;
  asegurado: string;
  documento: string;
  producto: string;
  area: AreaReporte;
  canalOProductor: string;
  emitidaEn: Date;
  dias: number;
  observacion: string;
  intentos: number;
  ultimoCorreo: string;
  noEnviar: boolean;
}

export interface FilaCompletado {
  poliza: string;
  asegurado: string;
  documento: string;
  producto: string;
  area: AreaReporte;
  canalOProductor: string;
  emitidaEn: Date;
  completadoEn: Date | null;
}

export interface ReporteSimple {
  grupo: GrupoReporte;
  /** Rótulo del asunto: «Canales» o «Productores». */
  areas: string;
  /** YYYY-MM-DD (Caracas). */
  fecha: string;
  /** DD/MM/AAAA. */
  fechaLocal: string;
  /** «DD/MM/AAAA HH:MM» (Caracas). */
  corte: string;
  cifras: CifrasControl;
  /** Más recientes primero. */
  incompletos: FilaIncompleto[];
  completados: FilaCompletado[];
}

/**
 * Áreas del reporte simple. Canales cubre toda la cartera del alcance (canales con sus gestores,
 * productores si están en el alcance y las pólizas sin datos de quién las emitió), para que las
 * cifras de canales y productores salgan juntas. Productores (apagado) solo los suyos.
 */
export function areasReporteSimple(
  grupo: GrupoReporte,
  alcance: AlcanceConfig,
): AreaExpediente[] {
  return grupo === 'productores' ? ['productor'] : areasEnAlcance(alcance);
}

export function areaReporte(area: string): AreaReporte {
  const g = grupoArea(area);
  return g === 'canal'
    ? 'Canales'
    : g === 'productor'
      ? 'Productores'
      : 'Sin datos';
}

/** Completados e incompletos por área visible; la suma de las áreas da el total. */
export function cifrasControl(
  exps: Pick<Exp, 'area' | 'estadoDocumental'>[],
): CifrasControl {
  const c: CifrasControl = {
    completados: 0,
    incompletos: 0,
    canales: { completos: 0, incompletos: 0 },
    productores: { completos: 0, incompletos: 0 },
    sinDatos: 0,
  };
  for (const e of exps) {
    const completo = e.estadoDocumental === 'completo';
    if (!completo && e.estadoDocumental !== 'incompleto') continue;
    if (completo) c.completados++;
    else c.incompletos++;
    const g = grupoArea(e.area);
    if (g === 'desconocida') c.sinDatos++;
    else {
      const a = g === 'canal' ? c.canales : c.productores;
      if (completo) a.completos++;
      else a.incompletos++;
    }
  }
  return c;
}

function nombreCompleto(e: Pick<Exp, 'aseguradoNombre' | 'aseguradoApellido'>) {
  return recortar(
    [e.aseguradoNombre, e.aseguradoApellido]
      .map((v) => String(v ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' '),
    120,
  );
}

function documentoCompleto(
  e: Pick<Exp, 'aseguradoTipoDoc' | 'aseguradoDocumento'>,
): string {
  const doc = String(e.aseguradoDocumento ?? '').trim();
  if (!doc) return '';
  const tipo = String(e.aseguradoTipoDoc ?? '')
    .trim()
    .toUpperCase();
  return tipo ? `${tipo}-${doc}` : doc;
}

export async function armarReporteSimple(
  grupo: GrupoReporte,
  opts: {
    config: ExpedientesConfig;
    fecha: string;
    ahora: Date;
    exclusiones: MktExpedienteExclusion[];
  },
): Promise<ReporteSimple> {
  const { config, fecha, ahora, exclusiones } = opts;
  const areas = areasReporteSimple(grupo, config.alcance);
  const cartera = areas.length
    ? await prisma.mktExpediente.findMany({
        where: {
          area: { in: areas },
          estadoDocumental: { in: ['completo', 'incompleto'] },
        },
      })
    : [];
  const recientes = (a: Exp, b: Exp) =>
    b.emitidaEn.getTime() - a.emitidaEn.getTime() || b.id - a.id;
  const incompletos = cartera
    .filter((e) => e.estadoDocumental === 'incompleto')
    .sort(recientes);
  const completados = cartera
    .filter((e) => e.estadoDocumental === 'completo')
    .sort(recientes);

  const reqs = await requisitosDe(incompletos.map((e) => e.id));
  const ids = incompletos.map((e) => e.id);
  const ultimas = ids.length
    ? await prisma.mktExpedienteNotificacion.findMany({
        where: {
          expedienteId: { in: ids },
          tipo: { notIn: TIPOS_NO_ASEGURADO },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { expedienteId: true, resultado: true, createdAt: true },
      })
    : [];
  const ultimaDe = new Map<number, { resultado: string; createdAt: Date }>();
  for (const n of ultimas) {
    if (n.expedienteId != null && !ultimaDe.has(n.expedienteId))
      ultimaDe.set(n.expedienteId, n);
  }
  const catalogo = cartera.some((e) => grupoArea(e.area) === 'canal')
    ? await catalogoCanales()
    : null;
  const comunes = (e: Exp) => ({
    poliza: e.cnpoliza,
    asegurado: nombreCompleto(e),
    documento: documentoCompleto(e),
    producto: productoLabel(e),
    area: areaReporte(e.area),
    canalOProductor: recortar(emitidaPor(e, catalogo), 80),
    emitidaEn: e.emitidaEn,
  });

  const { hora } = caracasParts(ahora);
  return {
    grupo,
    areas: rotuloGrupo(grupo, config.alcance),
    fecha,
    fechaLocal: fechaLocal(fecha),
    corte: `${fechaLocal(caracasParts(ahora).fecha)} ${hora}`,
    cifras: cifrasControl(cartera),
    incompletos: incompletos.map((e) => {
      const u = ultimaDe.get(e.id);
      return {
        ...comunes(e),
        dias: Math.max(0, diasCaracasEntre(e.emitidaEn, ahora)),
        observacion: observacionCorta(e, reqs.get(e.id) ?? [], config),
        intentos: e.intentos,
        ultimoCorreo: u
          ? `${ultimoResultadoLabel(u.resultado)} · ${fechaLocal(caracasParts(u.createdAt).fecha)}`
          : ultimoResultadoLabel(null),
        noEnviar: estaExcluido(e, exclusiones),
      };
    }),
    completados: completados.map((e) => ({
      ...comunes(e),
      completadoEn: e.completadoEn ?? null,
    })),
  };
}
