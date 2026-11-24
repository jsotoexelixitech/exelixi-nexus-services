/**
 * OCR obligatorio u opcional por canal, desde la pestaña Configuración del monitor.
 *
 * Lee y escribe la MISMA configuración que la pestaña «OCR por canal» del parametrizador
 * del módulo OCR: la fila product_config (empresa, producto, 'ocr'), clave `ocrOpcional`.
 * Es la fila que guarda PUT /api/config/:empresaId/:producto/ocr y que el OCR lee en
 * tiempo de ejecución con GET /api/config/... (useOcrOpcional → isOcrOpcionalForActor):
 *
 *   ocrOpcional: { gestores: string[], canales: string[] }   // códigos con OCR OPCIONAL
 *
 * Todo canal no listado queda obligatorio. Desde aquí solo cambia `ocrOpcional.canales`:
 * `ocrOpcional.gestores` y el resto de la configuración del OCR quedan tal cual. Los
 * gestores no se muestran (cuentan dentro de su canal), pero tampoco se borran.
 *
 * Productores: `ocrOpcional.productores: string[]` (cproductor con OCR OPCIONAL; ausente =
 * ninguno) y `ocrOpcional.productoresNombres` (código → nombre, solo para mostrar). La vista
 * trae el catálogo de productores (nest-api) para listarlos; si no carga, se agregan por
 * código. Solo cambian si el guardado manda `productores`.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/app-error';
import logger from '../../utils/logger';
import {
  catalogoCanales,
  catalogoProductores,
  type CanalCatalogo,
  type ProductorCatalogo,
  type PuntoCatalogo,
} from './expedientes.canales';
import type {
  OcrPorCanalUpdate,
  ProductoOcr,
  PuntosCanalQuery,
} from './expedientes.schema';

const MODULO = 'ocr';
export const EVENTO_OCR_POR_CANAL = 'ocr_por_canal_actualizado';
const MAX_CAMBIOS = 10;

type Json = Record<string, unknown>;

export interface CanalOcr {
  codigo: string;
  nombre: string | null;
  /** false: está en la config del OCR pero ya no en el catálogo de canales activos. */
  enCatalogo: boolean;
  ocrOpcional: boolean;
  /** Puntos de comercialización activos del canal (la lista va aparte, por canal). */
  puntos: number;
}

export interface PuntosDeCanal {
  canal: string;
  total: number;
  pagina: number;
  porPagina: number;
  puntos: PuntoCatalogo[];
}

export interface CambioOcrPorCanal {
  id: number;
  fecha: Date;
  actor: string;
  motivo: string | null;
  agregados: string[];
  quitados: string[];
  /** Productores que pasaron a OCR opcional / volvieron a obligatorio en ese cambio. */
  productoresAgregados: string[];
  productoresQuitados: string[];
}

/** Productor (cproductor) con OCR opcional. Los no listados quedan obligatorios. */
export interface ProductorOcr {
  codigo: string;
  nombre: string | null;
  ocrOpcional: true;
}

interface ProductoresConfig {
  lista: string[];
  nombres: Record<string, string>;
}

export interface OcrPorCanalVista {
  empresaId: number;
  empresaNombre: string | null;
  producto: ProductoOcr;
  canales: CanalOcr[];
  /** ocrOpcional.canales tal como queda en la config (incluye los que no están en el catálogo). */
  opcionales: string[];
  /** Gestores con OCR opcional puestos desde el panel del OCR: se conservan, no se muestran. */
  gestoresConfigurados: number;
  /** Productores con OCR opcional (ocrOpcional.productores), con su nombre si se guardó. */
  productores: ProductorOcr[];
  /** ocrOpcional.productores tal como queda en la config. */
  productoresOpcionales: string[];
  /** Catálogo de productores para la lista con buscador; null si nest-api no lo entregó. */
  catalogoProductores: ProductorCatalogo[] | null;
  cambios: CambioOcrPorCanal[];
  sinCambios?: boolean;
}

function rec(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

const codigo = (v: unknown): string => (v == null ? '' : String(v).trim());

function codigos(v: unknown): string[] {
  return Array.isArray(v)
    ? Array.from(new Set(v.map(codigo).filter(Boolean)))
    : [];
}

/** ocrOpcional.productoresNombres: solo pares código → texto no vacío. */
function nombresDe(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, n] of Object.entries(rec(v) ?? {})) {
    const cod = codigo(k);
    const nombre = typeof n === 'string' ? n.trim().slice(0, 120) : '';
    if (cod && nombre) out[cod] = nombre;
  }
  return out;
}

function mismosNombres(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

function empresaDelPortal(): number | null {
  const n = Number(process.env.PORTAL_SIS2000_EMPRESA_ID);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Empresa cuya config del OCR se toca: la de la sesión del administrador (la misma que
 * lleva el token SSO con el que el portal abre el OCR). Si el portal declara su empresa
 * (PORTAL_SIS2000_EMPRESA_ID) y no coincide, no se toca nada. QA sin sesión: la del portal.
 */
export function empresaOcrPorCanal(
  accesoLibre: boolean,
  empresaSesion?: number | null,
): number {
  const portal = empresaDelPortal();
  if (accesoLibre) {
    if (!portal) {
      throw new AppError(
        'Sin sesión no se sabe la empresa: defina PORTAL_SIS2000_EMPRESA_ID en nexus-api.',
        500,
      );
    }
    return portal;
  }
  const propia = Number(empresaSesion);
  if (!Number.isInteger(propia) || propia <= 0) {
    throw new AppError('Su sesión no indica la empresa.', 403);
  }
  if (portal && portal !== propia) {
    throw new AppError(
      'Su usuario no pertenece a la empresa del portal: no puede cambiar el OCR por canal.',
      403,
    );
  }
  return propia;
}

async function empresaNombre(empresaId: number): Promise<string | null> {
  const emp = await prisma.empresa.findUnique({
    where: { id: empresaId },
    select: { nombre: true },
  });
  if (!emp)
    throw new AppError(`La empresa ${empresaId} no existe en Nexus.`, 404);
  return emp.nombre?.trim() || null;
}

/** Sin catálogo no se muestra ni se guarda nada (un catálogo vacío también es una falla). */
async function canalesActivos(mensaje: string): Promise<{
  canales: CanalCatalogo[];
  puntos: Map<string, PuntoCatalogo[]>;
}> {
  const cat = await catalogoCanales();
  const canales =
    cat?.canales ??
    Array.from(cat?.nombres ?? [], ([cod, nombre]) => ({
      codigo: cod,
      nombre,
    }));
  if (!cat || canales.length === 0) throw new AppError(mensaje, 502);
  return { canales, puntos: cat.puntos ?? new Map() };
}

const MENSAJE_SIN_CATALOGO =
  'No se pudo consultar el catálogo de canales (nest-api). Intente de nuevo en unos minutos.';

/**
 * Puntos de comercialización de un canal, paginados (hay canales con miles). Solo lectura:
 * siguen la configuración del canal; filtro opcional por código o nombre.
 */
export async function puntosDeCanal(
  q: PuntosCanalQuery,
): Promise<PuntosDeCanal> {
  const { canales, puntos } = await canalesActivos(MENSAJE_SIN_CATALOGO);
  if (!canales.some((c) => c.codigo === q.canal)) {
    throw new AppError(
      'Ese canal no está en el catálogo de canales activos.',
      404,
    );
  }
  const filtro = q.q?.toLocaleLowerCase('es') ?? '';
  const todos = puntos.get(q.canal) ?? [];
  const lista = filtro
    ? todos.filter(
        (p) =>
          p.codigo.toLocaleLowerCase('es').includes(filtro) ||
          p.nombre.toLocaleLowerCase('es').includes(filtro),
      )
    : todos;
  const inicio = (q.pagina - 1) * q.porPagina;
  return {
    canal: q.canal,
    total: lista.length,
    pagina: q.pagina,
    porPagina: q.porPagina,
    puntos: lista.slice(inicio, inicio + q.porPagina),
  };
}

type Db = Pick<typeof prisma, 'productConfig' | 'mktExpedienteEvento'>;

/** La fila tal cual está guardada (sin defaults: ocrOpcional no tiene default). */
async function leerConfigOcr(db: Db, empresaId: number, producto: ProductoOcr) {
  const row = await db.productConfig.findUnique({
    where: {
      empresaId_producto_modulo: { empresaId, producto, modulo: MODULO },
    },
  });
  const configJson = row ? rec(row.configJson) : {};
  if (!configJson) {
    throw new AppError(
      'La configuración del OCR tiene un formato inesperado; no se modificó.',
      409,
    );
  }
  const oc = rec(configJson.ocrOpcional);
  return {
    existe: Boolean(row),
    configJson,
    ocrOpcional: oc,
    canales: codigos(oc?.canales),
    gestores: codigos(oc?.gestores).length,
    // Configs anteriores no traen la clave: ausente = ningún productor opcional.
    productores: codigos(oc?.productores),
    productoresNombres: nombresDe(oc?.productoresNombres),
  };
}

async function cambiosRecientes(
  empresaId: number,
  producto: ProductoOcr,
): Promise<CambioOcrPorCanal[]> {
  const eventos = await prisma.mktExpedienteEvento.findMany({
    where: { expedienteId: null, tipo: EVENTO_OCR_POR_CANAL },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return eventos
    .map((ev) => ({ ev, d: rec(ev.detalle) ?? {} }))
    .filter(({ d }) => d.empresaId === empresaId && d.producto === producto)
    .slice(0, MAX_CAMBIOS)
    .map(({ ev, d }) => ({
      id: ev.id,
      fecha: ev.createdAt,
      actor: ev.actor,
      motivo: typeof d.motivo === 'string' ? d.motivo : null,
      agregados: codigos(d.agregados),
      quitados: codigos(d.quitados),
      productoresAgregados: codigos(d.productoresAgregados),
      productoresQuitados: codigos(d.productoresQuitados),
    }));
}

function armarVista(
  empresaId: number,
  nombre: string | null,
  producto: ProductoOcr,
  { canales: catalogo, puntos }: Awaited<ReturnType<typeof canalesActivos>>,
  opcionales: string[],
  gestores: number,
  cambios: CambioOcrPorCanal[],
  productores: ProductoresConfig = { lista: [], nombres: {} },
  catProductores: ProductorCatalogo[] | null = null,
): OcrPorCanalVista {
  const marcados = new Set(opcionales);
  const enCatalogo = new Set(catalogo.map((c) => c.codigo));
  return {
    empresaId,
    empresaNombre: nombre,
    producto,
    // Orden del catálogo, sin depender de lo marcado; al final, lo que ya no está activo.
    canales: [
      ...catalogo.map((c) => ({
        codigo: c.codigo,
        nombre: c.nombre || null,
        enCatalogo: true,
        ocrOpcional: marcados.has(c.codigo),
        puntos: puntos.get(c.codigo)?.length ?? 0,
      })),
      ...opcionales
        .filter((c) => !enCatalogo.has(c))
        .map((c) => ({
          codigo: c,
          nombre: null,
          enCatalogo: false,
          ocrOpcional: true,
          puntos: 0,
        })),
    ],
    opcionales,
    gestoresConfigurados: gestores,
    productores: productores.lista.map((c) => ({
      codigo: c,
      nombre: productores.nombres[c] ?? null,
      ocrOpcional: true as const,
    })),
    productoresOpcionales: productores.lista,
    catalogoProductores: catProductores,
    cambios,
  };
}

export async function obtenerOcrPorCanal(
  empresaId: number,
  producto: ProductoOcr,
): Promise<OcrPorCanalVista> {
  const nombre = await empresaNombre(empresaId);
  // El de productores nunca lanza: sin él la sección sigue con «agregar por código».
  const [catalogo, catProductores] = await Promise.all([
    canalesActivos(MENSAJE_SIN_CATALOGO),
    catalogoProductores(),
  ]);
  const actual = await leerConfigOcr(prisma, empresaId, producto);
  return armarVista(
    empresaId,
    nombre,
    producto,
    catalogo,
    actual.canales,
    actual.gestores,
    await cambiosRecientes(empresaId, producto),
    { lista: actual.productores, nombres: actual.productoresNombres },
    catProductores,
  );
}

/**
 * Reemplaza `ocrOpcional.canales` por la lista recibida y, solo si el guardado manda
 * `productores`, también `ocrOpcional.productores` (+ nombres). Lo demás de la fila (gestores,
 * documentos, mapeador, visual…) se escribe tal como estaba. Config y evento de auditoría
 * van en la misma transacción: no hay cambio sin registro.
 */
export async function guardarOcrPorCanal(
  empresaId: number,
  body: OcrPorCanalUpdate,
  actor: string,
): Promise<OcrPorCanalVista> {
  const { producto, motivo } = body;
  const nombre = await empresaNombre(empresaId);
  const catalogo = await canalesActivos(
    'No se pudo consultar el catálogo de canales (nest-api). No se guardó ningún cambio; intente de nuevo en unos minutos.',
  );
  const activos = new Set(catalogo.canales.map((c) => c.codigo));
  const pedidos = codigos(body.canales);
  // Sin `productores` en el cuerpo (cliente anterior) no se toca esa lista.
  const pideProductores = body.productores !== undefined;
  const pedidosProd = codigos(body.productores);
  const nombresPedidos = nombresDe(body.productoresNombres);

  const r = await prisma.$transaction(async (tx) => {
    const actual = await leerConfigOcr(tx, empresaId, producto);
    const previos = new Set(actual.canales);

    if (body.base) {
      const base = new Set(codigos(body.base));
      const igual =
        base.size === previos.size && actual.canales.every((c) => base.has(c));
      if (!igual) {
        throw new AppError(
          'La configuración del OCR cambió mientras editaba (otra persona o el panel del OCR). Recargue la sección y vuelva a intentar.',
          409,
        );
      }
    }

    // Un código nuevo tiene que existir en el catálogo; uno ya configurado se tolera
    // (canal dado de baja) para no perderlo al guardar otro cambio.
    const desconocidos = pedidos.filter(
      (c) => !activos.has(c) && !previos.has(c),
    );
    if (desconocidos.length > 0) {
      throw new AppError(
        `Estos códigos no están en el catálogo de canales: ${desconocidos.slice(0, 10).join(', ')}.`,
        400,
      );
    }

    if (body.baseProductores) {
      const baseProd = new Set(codigos(body.baseProductores));
      const igual =
        baseProd.size === actual.productores.length &&
        actual.productores.every((c) => baseProd.has(c));
      if (!igual) {
        throw new AppError(
          'La lista de productores con OCR opcional cambió mientras editaba (otra persona o el panel del OCR). Recargue la sección y vuelva a intentar.',
          409,
        );
      }
    }

    const pedidosSet = new Set(pedidos);
    const agregados = pedidos.filter((c) => !previos.has(c));
    const quitados = actual.canales.filter((c) => !pedidosSet.has(c));

    // Productores: mismo criterio que canales (los que siguen, luego los nuevos).
    const previosProd = new Set(actual.productores);
    const pedidosProdSet = new Set(pedidosProd);
    const prodAgregados = pideProductores
      ? pedidosProd.filter((c) => !previosProd.has(c))
      : [];
    const prodQuitados = pideProductores
      ? actual.productores.filter((c) => !pedidosProdSet.has(c))
      : [];
    const nuevoProd = pideProductores
      ? [
          ...actual.productores.filter((c) => pedidosProdSet.has(c)),
          ...prodAgregados,
        ]
      : actual.productores;
    const nombresProd: Record<string, string> = {};
    for (const c of nuevoProd) {
      const n = nombresPedidos[c] ?? actual.productoresNombres[c];
      if (n) nombresProd[c] = n;
    }
    const cambiaProd =
      pideProductores &&
      (prodAgregados.length > 0 ||
        prodQuitados.length > 0 ||
        !mismosNombres(nombresProd, actual.productoresNombres));

    if (agregados.length === 0 && quitados.length === 0 && !cambiaProd) {
      return {
        actual,
        nuevo: actual.canales,
        productores: {
          lista: actual.productores,
          nombres: actual.productoresNombres,
        },
        sinCambios: true,
      };
    }

    // Mismo orden que deja el panel del OCR: los que siguen, luego los nuevos al final.
    const nuevo = [
      ...actual.canales.filter((c) => pedidosSet.has(c)),
      ...agregados,
    ];
    const configJson = {
      ...actual.configJson,
      ocrOpcional: {
        ...(actual.ocrOpcional ?? {}),
        canales: nuevo,
        ...(cambiaProd
          ? { productores: nuevoProd, productoresNombres: nombresProd }
          : {}),
      },
    } as Prisma.InputJsonValue;
    const where = {
      empresaId_producto_modulo: { empresaId, producto, modulo: MODULO },
    };
    if (actual.existe) {
      await tx.productConfig.update({ where, data: { configJson } });
    } else {
      await tx.productConfig.create({
        data: { empresaId, producto, modulo: MODULO, configJson },
      });
    }
    await tx.mktExpedienteEvento.create({
      data: {
        expedienteId: null,
        tipo: EVENTO_OCR_POR_CANAL,
        actor: actor.slice(0, 128),
        detalle: {
          empresaId,
          producto,
          modulo: MODULO,
          anterior: actual.canales,
          nuevo,
          agregados,
          quitados,
          gestoresConservados: actual.gestores,
          ...(cambiaProd
            ? {
                productoresAnterior: actual.productores,
                productoresNuevo: nuevoProd,
                productoresAgregados: prodAgregados,
                productoresQuitados: prodQuitados,
              }
            : {}),
          motivo,
        },
      },
    });
    return {
      actual,
      nuevo,
      productores: cambiaProd
        ? { lista: nuevoProd, nombres: nombresProd }
        : { lista: actual.productores, nombres: actual.productoresNombres },
      sinCambios: false,
    };
  });

  if (!r.sinCambios) {
    logger.info(
      `[expedientes] OCR por canal: empresa=${empresaId} producto=${producto} opcionales=${r.nuevo.length} productores=${r.productores.lista.length} (gestores conservados: ${r.actual.gestores})`,
    );
  }
  const vista = armarVista(
    empresaId,
    nombre,
    producto,
    catalogo,
    r.nuevo,
    r.actual.gestores,
    await cambiosRecientes(empresaId, producto),
    r.productores,
    await catalogoProductores(),
  );
  return r.sinCambios ? { ...vista, sinCambios: true } : vista;
}
