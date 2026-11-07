/**
 * Monitor de expedientes Marketplace. La fuente de pólizas es la tabla `emision`
 * (feed que ya llega a Nexus); aquí solo vive lo que el feed no trae.
 */
import type {
  MktExpediente,
  MktExpedienteExclusion,
  MktExpedienteRequisito,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { AppError } from '../../utils/app-error';
import {
  ALCANCES_EXCLUSION,
  AlcanceExclusion,
  AreaExpediente,
  aseguradoKey,
  areaDesdeVendedor,
  areasEnAlcance,
  calcularEstadoDocumental,
  emailValido,
  esPendiente,
  esTipoActor,
  ExpedientesConfig,
  maskEmail,
  maskPoliza,
  mergeConfig,
  normalizarCodigoActor,
  normalizarEstadoPago,
  normalizarProducto,
  proximoEnvio,
  requisitoLabel,
  requisitosAplicables,
  separarIdentificacion,
  TipoActor,
  valorActor,
} from './expedientes.domain';
import {
  expedientesEnabled,
  linkDias,
  ocrInternalConfig,
  publicBaseUrl,
} from './expedientes.env';
import {
  analizarEnOcr,
  ArchivoCargado,
  enviarDocumentoAlOcr,
  formatoTokenValido,
  generarToken,
  hashToken,
  OcrAnalisisError,
  OcrDocumentoResultado,
  OcrLectura,
  OcrNoConfiguradoError,
  OcrRechazoError,
} from './expedientes.files';
import {
  ColaConcurrencia,
  conDatosModificados,
  ContextoPoliza,
  contextoPoliza,
  Diagnostico,
  diagnosticar,
  diagnosticoCorto,
  diagnosticoErrorTecnico,
  diagnosticoVigente,
  esperaReintentoMs,
  estadoPorDiagnostico,
  huellaPoliza,
  MotivoAnalisis,
  motivoAnalisis,
  motivoParaAsegurado,
  ocrLeidoDe,
  VERSION_COMPARADOR,
} from './expedientes.ia';
import {
  correoCompleto,
  correoObservado,
  correoRecibido,
  correoSolicitudInicial,
  DocumentoCorreo,
  entregarCorreo,
  estadoDocCorreo,
} from './expedientes.mail';
import {
  expedientePayloadSchema,
  ExpedientePayload,
  ListQuery,
} from './expedientes.schema';

const CONFIG_KEY = 'global';

/** Validación automática con IA: no más de 2 análisis OCR a la vez (cargas con prioridad). */
export const colaIa = new ColaConcurrencia(2);

export interface ResumenRevisionIa {
  omitido: string | null;
  revisados: number;
  analizados: number;
  sinCambios: number;
  validados: number;
  observados: number;
  erroresTecnicos: number;
  motivos: Record<string, number>;
}

function mensajeErrorOcr(err: unknown): string {
  if (err instanceof OcrAnalisisError) return err.message;
  if (err instanceof OcrNoConfiguradoError) return 'OCR no configurado.';
  const name = (err as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError')
    return 'el OCR no respondió en 90 s.';
  return 'OCR no disponible.';
}

/** Cédula o RIF en el mismo documento solo en patrimoniales (igual que la emisión). */
function aceptaRifEn(producto: string, tipo: string): boolean {
  return producto === 'patrimonial' && tipo === 'cedula';
}

type Exp = MktExpediente;
type Req = MktExpedienteRequisito;

export interface EmisionFuente {
  id: number;
  empresaId: number;
  polizaNumero: string;
  jsonData?: unknown;
  createdAt?: Date | null;
}

export interface RegistroEmisionExtra {
  expediente?: unknown;
  jsonData?: Record<string, unknown> | null;
  cnrecibo?: string | null;
  tomadorNombre?: string | null;
  tomadorIdentificacion?: string | null;
  producto?: string | null;
  planNombre?: string | null;
  monto?: number | null;
}

function str(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim();
  return s ? s : undefined;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function primerNombre(e: Pick<Exp, 'aseguradoNombre'>): string {
  const n = String(e.aseguradoNombre ?? '').trim();
  return n ? n.split(/\s+/)[0] : 'cliente';
}

/**
 * Documentos del asegurado para el correo, solo de sus propias pólizas. El motivo de
 * «envíalo de nuevo» es el mismo que ve en la página pública (nunca el resumen de la IA).
 * `recienRecibido`: el tipo que acaba de cargar se muestra «Recibido» en vez de «En revisión».
 */
export function documentosCorreo(
  exps: Exp[],
  reqs: Map<number, Req[]>,
  config: ExpedientesConfig,
  recienRecibido?: string,
): DocumentoCorreo[] {
  const varias = exps.length > 1;
  const out: DocumentoCorreo[] = [];
  for (const e of exps) {
    const porTipo = new Map((reqs.get(e.id) ?? []).map((r) => [r.tipo, r]));
    for (const tipo of requisitosAplicables(e.producto, config)) {
      const r = porTipo.get(tipo);
      let estado = estadoDocCorreo(r?.estado ?? 'faltante');
      if (!estado) continue;
      if (estado === 'en_revision' && recienRecibido === tipo)
        estado = 'recibido';
      const diag = r ? diagnosticoVigente(r) : null;
      const motivo =
        estado === 'corregir'
          ? diag && r?.decision === 'ia'
            ? motivoParaAsegurado(diag)
            : (r?.motivo ?? '')
          : '';
      out.push({
        nombre: requisitoLabel(tipo),
        estado,
        ...(motivo ? { motivo } : {}),
        ...(varias ? { poliza: e.cnpoliza } : {}),
      });
    }
  }
  return out;
}

export function polizaOResumen(exps: Pick<Exp, 'cnpoliza'>[]): string {
  if (exps.length === 1) return `N° ${exps[0].cnpoliza}`;
  return `de tus ${exps.length} pólizas`;
}

const AREA_CODIGO: Record<string, string> = {
  canal: 'C',
  gestor: 'G',
  productor: 'P',
};

/** Filtro de área: acepta C/G/P (centidad del SSO) o el nombre. */
export function areaDesdeFiltro(v: string): string {
  const s = v.trim().toUpperCase();
  if (s === 'C' || s.startsWith('CANAL')) return 'canal';
  if (s === 'G' || s.startsWith('GESTOR')) return 'gestor';
  if (s === 'P' || s.startsWith('PRODUCTOR')) return 'productor';
  if (s.startsWith('DESCONOCID')) return 'desconocida';
  return '__ninguna__';
}

type ExpExcluible = Pick<
  Exp,
  'id' | 'empresaId' | 'cnpoliza' | 'aseguradoKey'
> &
  Partial<
    Pick<Exp, 'centidad' | 'citem' | 'cgestor' | 'ccanalalt' | 'cproductor'>
  >;

function aplicaExclusion(e: ExpExcluible, x: MktExpedienteExclusion): boolean {
  if (!x.activo) return false;
  if (x.alcance === 'poliza') {
    if (x.expedienteId != null) return x.expedienteId === e.id;
    return (
      x.cnpoliza === e.cnpoliza &&
      (x.empresaId == null || x.empresaId === e.empresaId)
    );
  }
  if (x.alcance === 'asegurado')
    return !!x.aseguradoKey && x.aseguradoKey === e.aseguradoKey;
  if (esTipoActor(x.alcance)) {
    const v = normalizarCodigoActor(x.valor);
    return !!v && v === valorActor(e, x.alcance);
  }
  return false;
}

/** Exclusiones activas que alcanzan a la póliza, de la más específica a la más general. */
export function exclusionesQueAplican(
  e: ExpExcluible,
  exclusiones: MktExpedienteExclusion[],
): MktExpedienteExclusion[] {
  const orden = (a: string) =>
    (ALCANCES_EXCLUSION as readonly string[]).indexOf(a);
  return exclusiones
    .filter((x) => aplicaExclusion(e, x))
    .sort((a, b) => orden(a.alcance) - orden(b.alcance));
}

/** Asegurado, póliza, canal, gestor o intermediario: cualquier exclusión activa detiene el envío. */
export function estaExcluido(
  e: ExpExcluible,
  exclusiones: MktExpedienteExclusion[],
): boolean {
  return exclusiones.some((x) => aplicaExclusion(e, x));
}

/** Texto corto del valor excluido (el correo del asegurado va enmascarado). */
function valorExclusion(x: MktExpedienteExclusion): string {
  if (x.alcance === 'poliza') return x.cnpoliza ?? '';
  if (x.alcance === 'asegurado') {
    const k = x.aseguradoKey ?? '';
    return k.startsWith('mail:') ? (maskEmail(k.slice(5)) ?? '') : k;
  }
  return x.valor ?? '';
}

const ETIQUETA_ACTOR: Record<TipoActor, string> = {
  canal: 'canal',
  gestor: 'gestor',
  intermediario: 'intermediario',
};

/** Exclusión tal como la ve la pantalla de configuración. */
export function exclusionDto(x: MktExpedienteExclusion) {
  const asegurado =
    x.alcance === 'asegurado' && x.aseguradoKey ? valorExclusion(x) : null;
  return {
    id: x.id,
    alcance: x.alcance,
    valor: valorExclusion(x),
    expedienteId: x.expedienteId,
    empresaId: x.empresaId,
    cnpoliza: x.cnpoliza,
    asegurado,
    motivo: x.motivo,
    actor: x.creadoPor,
    creadoPor: x.creadoPor,
    activo: x.activo,
    createdAt: x.createdAt,
    eliminadoPor: x.eliminadoPor,
    eliminadoEn: x.eliminadoEn,
  };
}

/** Nombre del actor si la emisión lo dejó en el snapshot (no se consulta Sis2000). */
function nombreActorDeSnapshot(
  snapshot: unknown,
  tipo: TipoActor,
): string | null {
  const s = rec(snapshot);
  const claves: Record<TipoActor, string[]> = {
    canal: ['canal', 'canalAlterno', 'xcanal', 'xcanalalt', 'canalNombre'],
    gestor: ['gestor', 'xgestor', 'gestorNombre'],
    intermediario: [
      'intermediario',
      'productor',
      'xproductor',
      'productorNombre',
      'intermediarioNombre',
    ],
  };
  for (const k of claves[tipo]) {
    const v = s[k];
    // `canal`/`gestor` sueltos pueden ser el código: solo se aceptan como objeto con nombre.
    const esCampoNombre = k.startsWith('x') || k.endsWith('Nombre');
    const nombre =
      typeof v === 'string'
        ? esCampoNombre
          ? str(v)
          : undefined
        : (str(rec(v).nombre) ?? str(rec(v).xnombre));
    if (nombre) return nombre.slice(0, 150);
  }
  return null;
}

export class ExpedientesService {
  /** Requisitos en análisis ahora mismo (evita analizar dos veces el mismo). */
  private readonly enAnalisis = new Set<number>();
  /** Análisis programados en segundo plano (creación del expediente). */
  private readonly pendientesIa = new Set<Promise<unknown>>();

  // ─── Configuración ──────────────────────────────────────────────────────

  async getConfig(): Promise<ExpedientesConfig> {
    const row = await prisma.mktExpedienteConfig.findUnique({
      where: { clave: CONFIG_KEY },
    });
    return mergeConfig(row?.valor);
  }

  async updateConfig(
    patch: Partial<ExpedientesConfig> & { motivo: string },
    actor: string,
  ): Promise<ExpedientesConfig> {
    const { motivo, ...cambios } = patch;
    const anterior = await this.getConfig();
    const nuevo = mergeConfig({
      ...anterior,
      ...cambios,
      alcance: { ...anterior.alcance, ...(cambios.alcance ?? {}) },
      requisitosPorProducto: {
        ...anterior.requisitosPorProducto,
        ...(cambios.requisitosPorProducto ?? {}),
      },
    });
    const existe = await prisma.mktExpedienteConfig.findUnique({
      where: { clave: CONFIG_KEY },
    });
    if (existe) {
      await prisma.mktExpedienteConfig.update({
        where: { clave: CONFIG_KEY },
        data: {
          valor: nuevo as unknown as Prisma.InputJsonValue,
          actualizadoPor: actor,
        },
      });
    } else {
      await prisma.mktExpedienteConfig.create({
        data: {
          clave: CONFIG_KEY,
          valor: nuevo as unknown as Prisma.InputJsonValue,
          actualizadoPor: actor,
        },
      });
    }
    await this.evento(null, 'config_actualizada', actor, {
      anterior,
      nuevo,
      motivo,
    });
    return nuevo;
  }

  // ─── Auditoría ──────────────────────────────────────────────────────────

  async evento(
    expedienteId: number | null,
    tipo: string,
    actor: string,
    detalle?: Record<string, unknown>,
  ): Promise<void> {
    await prisma.mktExpedienteEvento.create({
      data: {
        expedienteId,
        tipo,
        actor: actor.slice(0, 128),
        detalle: (detalle ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async eventoTecnico(
    detalle: Record<string, unknown>,
    expedienteId: number | null = null,
  ) {
    try {
      await this.evento(expedienteId, 'error_tecnico', 'sistema', detalle);
    } catch (err) {
      logger.error(
        `[expedientes] no se pudo registrar evento técnico: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ─── Creación / actualización desde la emisión (idempotente) ───────────

  /**
   * Crea o actualiza el expediente de una emisión (empresa + cnpoliza).
   * No toca la tabla `emision`. Con EXPEDIENTES_ENABLED apagado no hace nada.
   */
  async registrarDesdeEmision(
    emision: EmisionFuente,
    extra: RegistroEmisionExtra = {},
    origen: 'emision' | 'conciliacion' = 'emision',
  ): Promise<{ id: number; creado: boolean } | null> {
    if (!expedientesEnabled()) return null;
    const cnpoliza = String(emision.polizaNumero ?? '').trim();
    if (!emision.empresaId || !cnpoliza) return null;

    const jd = { ...rec(emision.jsonData), ...rec(extra.jsonData) };
    const rawPayload = extra.expediente ?? jd.expediente;
    let payload: ExpedientePayload = {};
    if (rawPayload != null) {
      const parsed = expedientePayloadSchema.safeParse(rawPayload);
      if (parsed.success) payload = parsed.data;
      else
        logger.warn(
          `[expedientes] campo expediente inválido en póliza de empresa ${emision.empresaId}; se usa el registro sin él`,
        );
    }

    const config = await this.getConfig();
    const datos = await this.construirDatos(emision, extra, jd, payload);

    let exp = await prisma.mktExpediente.findUnique({
      where: { empresaId_cnpoliza: { empresaId: emision.empresaId, cnpoliza } },
    });
    let creado = false;
    if (!exp) {
      try {
        exp = await prisma.mktExpediente.create({
          data: {
            ...datos,
            empresaId: emision.empresaId,
            cnpoliza,
            emisionId: emision.id ?? null,
            emitidaEn: emision.createdAt ?? new Date(),
            origen,
          },
        });
        creado = true;
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
        exp = await prisma.mktExpediente.findUnique({
          where: {
            empresaId_cnpoliza: { empresaId: emision.empresaId, cnpoliza },
          },
        });
        if (!exp) throw err;
      }
    }

    if (creado) {
      await this.evento(exp.id, 'expediente_creado', origen, {
        area: exp.area,
        producto: exp.producto,
        cproducto: payload.cproducto ?? null,
        estadoPago: exp.estadoPago,
        conDatosExpediente: rawPayload != null,
        infoDocumental: exp.infoDocumental,
      });
    } else {
      const cambios = this.fusionar(exp, datos, emision, payload);
      if (Object.keys(cambios).length) {
        exp = await prisma.mktExpediente.update({
          where: { id: exp.id },
          data: cambios,
        });
        if (cambios.infoDocumental === true) {
          // Ahora sí se conocen los documentos: "sin_informacion" pasa a "faltante".
          await prisma.mktExpedienteRequisito.updateMany({
            where: { expedienteId: exp.id, estado: 'sin_informacion' },
            data: { estado: 'faltante' },
          });
        }
        await this.evento(exp.id, 'expediente_actualizado', origen, {
          campos: Object.keys(cambios),
        });
      }
    }

    await this.asegurarRequisitos(exp, config);
    if (payload.documentos) {
      await this.aplicarDocumentosEmision(exp, payload.documentos, config);
    }
    if (!exp.infoDocumental) await this.cruzarMesaTecnica(exp, config);
    await this.recalcularEstado(exp.id, config);
    // Validación automática de lo recibido (incluye los documentos del wizard), sin esperar.
    this.programarAnalisis(exp.id);
    return { id: exp.id, creado };
  }

  /**
   * Personas sin documentos en el wizard: si la mesa técnica guardó el snapshot con
   * `documents`, se usa para saber qué se recibió (lo demás pasa a faltante).
   */
  async cruzarMesaTecnica(
    exp: Exp,
    config: ExpedientesConfig,
  ): Promise<boolean> {
    let documents: Record<string, unknown> | null = null;
    try {
      const sub = await prisma.funeralSubmission.findFirst({
        where: { empresaId: exp.empresaId, cnpoliza: exp.cnpoliza },
        orderBy: { createdAt: 'desc' },
      });
      const snap = rec(sub?.snapshotJson);
      const docs = snap.documents ?? rec(snap.data).documents;
      if (docs && typeof docs === 'object' && !Array.isArray(docs)) {
        documents = docs as Record<string, unknown>;
      }
    } catch {
      return false;
    }
    if (!documents) return false;
    await prisma.mktExpediente.update({
      where: { id: exp.id },
      data: { infoDocumental: true },
    });
    await prisma.mktExpedienteRequisito.updateMany({
      where: { expedienteId: exp.id, estado: 'sin_informacion' },
      data: { estado: 'faltante' },
    });
    const aplicables = new Set(requisitosAplicables(exp.producto, config));
    for (const [tipo, raw] of Object.entries(documents)) {
      if (!aplicables.has(tipo)) continue;
      const d = rec(raw);
      const url = str(rec(d.file).url) ?? str(d.url) ?? str(d.ref);
      if (d.status !== 'done' && !url) continue;
      const r = await prisma.mktExpedienteRequisito.findUnique({
        where: { expedienteId_tipo: { expedienteId: exp.id, tipo } },
      });
      if (!r || r.estado !== 'faltante') continue;
      await prisma.mktExpedienteRequisito.update({
        where: { id: r.id },
        data: {
          estado: 'recibido',
          origen: 'mesa_tecnica',
          ref: url ?? null,
          recibidoEn: new Date(),
        },
      });
      await this.evento(exp.id, 'documento_recibido', 'mesa_tecnica', {
        tipo,
        origen: 'mesa_tecnica',
      });
    }
    return true;
  }

  private async construirDatos(
    emision: EmisionFuente,
    extra: RegistroEmisionExtra,
    jd: Record<string, unknown>,
    p: ExpedientePayload,
  ) {
    const aseg = rec(p.asegurado);
    const idTomador = separarIdentificacion(
      str(extra.tomadorIdentificacion) ?? str(jd.tomadorIdentificacion),
    );
    const tipoDoc =
      str(aseg.tipoDoc)?.toUpperCase() ?? idTomador.tipoDoc ?? null;
    const documento =
      (str(aseg.documento)
        ? String(aseg.documento).replace(/\D/g, '')
        : undefined) ||
      idTomador.documento ||
      null;
    const nombreTomador = str(extra.tomadorNombre) ?? str(jd.tomadorNombre);
    const nombre = str(aseg.nombre) ?? nombreTomador ?? null;
    const apellido = str(aseg.apellido) ?? null;
    const emailRaw = str(aseg.email)?.toLowerCase() ?? null;
    const email = emailRaw && emailValido(emailRaw) ? emailRaw : null;

    const centidadP = str(p.centidad)?.toUpperCase() ?? null;
    let vendedor = {
      centidad: centidadP,
      citem:
        str(p.citem) ??
        (centidadP === 'P' ? (str(p.cproductor) ?? null) : null) ??
        null,
      cgestor: str(p.cgestor) ?? null,
      ccanalalt: str(p.ccanalalt) ?? null,
      cusuario: str(p.cusuario) ?? null,
      xlogin: str(p.xlogin) ?? null,
      // Intermediario de la póliza (también en ventas de canal o gestor).
      cproductor: str(p.cproductor) ?? null,
    };
    if (!vendedor.centidad && vendedor.cusuario) {
      const perfil = await this.vendedorDesdePerfil(vendedor.cusuario);
      vendedor = {
        ...vendedor,
        ...perfil,
        cproductor: vendedor.cproductor ?? perfil.cproductor ?? null,
      };
    }
    const area: AreaExpediente = areaDesdeVendedor(vendedor);

    const producto = normalizarProducto(
      str(extra.producto) ?? str(jd.producto),
      str(p.producto),
    );
    const cramoRaw = p.cramo ?? Number(jd.cramo);
    // v1.3: lo que el OCR leyó al emitir, por requisito (snapshot.ocrLeido[tipo], sin migración).
    const ocrLeido = ocrLeidoDe(
      Object.fromEntries(
        Object.entries(p.documentos ?? {}).map(([t, d]) => [t, d?.ocrLeido]),
      ),
    );
    const snapshot = {
      ...(p.snapshot ??
        ({
          tomador: {
            nombre: nombreTomador ?? null,
            identificacion: str(jd.tomadorIdentificacion) ?? null,
          },
          plan: str(extra.planNombre) ?? str(jd.planNombre) ?? null,
          prima: extra.monto ?? (jd.monto != null ? Number(jd.monto) : null),
        } as Record<string, unknown>)),
      ...(ocrLeido ? { ocrLeido } : {}),
    };

    return {
      // Sin campo `expediente` (registros viejos) o personas sin documentos en el
      // wizard: no se sabe qué falta → requisitos "sin_informacion", no incompleto.
      infoDocumental:
        Object.keys(p).length > 0 && p.documentosEnWizard !== false,
      cnrecibo: str(extra.cnrecibo) ?? str(jd.cnrecibo) ?? null,
      producto,
      cramo: Number.isFinite(cramoRaw) ? Number(cramoRaw) : null,
      area,
      ...vendedor,
      estadoPago: normalizarEstadoPago(p.estadoPago, jd.estadoPago),
      aseguradoKey: aseguradoKey({ tipoDoc, documento, email }),
      aseguradoTipoDoc: tipoDoc,
      aseguradoDocumento: documento,
      aseguradoNombre: nombre,
      aseguradoApellido: apellido,
      aseguradoEmail: email,
      aseguradoTelefono: str(aseg.telefono) ?? null,
      snapshot: snapshot as Prisma.InputJsonValue,
      carpetaExpediente: str(p.carpetaExpediente) ?? null,
    };
  }

  /** Área desde el perfil del portal cuando la emisión no trae centidad. */
  private async vendedorDesdePerfil(
    cusuario: string,
  ): Promise<
    Partial<
      Record<
        'centidad' | 'citem' | 'cgestor' | 'ccanalalt' | 'cproductor',
        string | null
      >
    >
  > {
    try {
      const perfil = await prisma.usuarioPortalPerfil.findFirst({
        where: { cusuario },
      });
      if (!perfil) return {};
      return {
        centidad: perfil.centidad?.toUpperCase() ?? null,
        citem: perfil.citem ?? null,
        cgestor: perfil.cgestor ?? null,
        ccanalalt: perfil.ccanalaltIn ?? null,
        cproductor: perfil.cproductor ?? null,
      };
    } catch {
      return {};
    }
  }

  /** Solo completa lo vacío; el estado de pago se actualiza si la emisión lo informa. */
  private fusionar(
    exp: Exp,
    datos: Awaited<ReturnType<ExpedientesService['construirDatos']>>,
    emision: EmisionFuente,
    p: ExpedientePayload,
  ): Prisma.MktExpedienteUpdateInput {
    const out: Record<string, unknown> = {};
    const llenar = [
      'cnrecibo',
      'cramo',
      'centidad',
      'citem',
      'cgestor',
      'ccanalalt',
      'cusuario',
      'xlogin',
      'cproductor',
      'aseguradoTipoDoc',
      'aseguradoDocumento',
      'aseguradoNombre',
      'aseguradoApellido',
      'aseguradoEmail',
      'aseguradoTelefono',
      'carpetaExpediente',
    ] as const;
    for (const k of llenar) {
      if ((exp[k] == null || exp[k] === '') && datos[k] != null)
        out[k] = datos[k];
    }
    if (exp.emisionId == null && emision.id) out.emisionId = emision.id;
    if (exp.area === 'desconocida' && datos.area !== 'desconocida')
      out.area = datos.area;
    if (!exp.aseguradoKey && datos.aseguradoKey)
      out.aseguradoKey = datos.aseguradoKey;
    // v1.3: un reenvío sin `ocrLeido` no borra lo que el OCR leyó al emitir.
    const ocrNuevo = rec(rec(datos.snapshot).ocrLeido);
    const hayOcrNuevo = Object.keys(ocrNuevo).length > 0;
    if (p.snapshot || hayOcrNuevo) {
      const base = p.snapshot ? rec(datos.snapshot) : rec(exp.snapshot);
      const ocrLeido = hayOcrNuevo ? ocrNuevo : rec(rec(exp.snapshot).ocrLeido);
      out.snapshot = {
        ...base,
        ...(Object.keys(ocrLeido).length ? { ocrLeido } : {}),
      };
    }
    if (p.producto && exp.producto !== datos.producto)
      out.producto = datos.producto;
    if (p.estadoPago && exp.estadoPago !== datos.estadoPago)
      out.estadoPago = datos.estadoPago;
    if (!exp.infoDocumental && datos.infoDocumental) out.infoDocumental = true;
    return out as Prisma.MktExpedienteUpdateInput;
  }

  private async asegurarRequisitos(exp: Exp, config: ExpedientesConfig) {
    const aplicables = requisitosAplicables(exp.producto, config);
    const existentes = await prisma.mktExpedienteRequisito.findMany({
      where: { expedienteId: exp.id },
    });
    const tipos = new Set(existentes.map((r) => r.tipo));
    for (const tipo of aplicables) {
      if (tipos.has(tipo)) continue;
      try {
        await prisma.mktExpedienteRequisito.create({
          data: {
            expedienteId: exp.id,
            tipo,
            estado: exp.infoDocumental ? 'faltante' : 'sin_informacion',
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }
  }

  /** Documentos ya recibidos en la emisión: faltante → recibido (nunca validado). */
  private async aplicarDocumentosEmision(
    exp: Exp,
    documentos: NonNullable<ExpedientePayload['documentos']>,
    config: ExpedientesConfig,
  ) {
    const aplicables = new Set(requisitosAplicables(exp.producto, config));
    for (const [tipo, d] of Object.entries(documentos)) {
      if (!aplicables.has(tipo) || !d?.recibido) continue;
      const r = await prisma.mktExpedienteRequisito.findUnique({
        where: { expedienteId_tipo: { expedienteId: exp.id, tipo } },
      });
      if (!r || (r.estado !== 'faltante' && r.estado !== 'sin_informacion'))
        continue;
      await prisma.mktExpedienteRequisito.update({
        where: { id: r.id },
        data: {
          estado: 'recibido',
          origen: 'emision',
          ref: d.ref ?? d.url ?? null,
          recibidoEn: new Date(),
        },
      });
      await this.evento(exp.id, 'documento_recibido', 'emision', {
        tipo,
        origen: 'emision',
      });
    }
  }

  /** Recalcula estado documental. Devuelve si quedó completo en este paso. */
  async recalcularEstado(
    expedienteId: number,
    config?: ExpedientesConfig,
  ): Promise<{ estado: string; completadoAhora: boolean }> {
    const cfg = config ?? (await this.getConfig());
    const exp = await prisma.mktExpediente.findUnique({
      where: { id: expedienteId },
    });
    if (!exp) throw new AppError('Expediente no encontrado.', 404);
    await this.asegurarRequisitos(exp, cfg);
    const reqs = await prisma.mktExpedienteRequisito.findMany({
      where: { expedienteId },
    });
    const estado = calcularEstadoDocumental(
      requisitosAplicables(exp.producto, cfg),
      reqs,
    );
    if (estado === exp.estadoDocumental) {
      return { estado, completadoAhora: false };
    }
    await prisma.mktExpediente.update({
      where: { id: exp.id },
      data: {
        estadoDocumental: estado,
        completadoEn: estado === 'completo' ? new Date() : null,
      },
    });
    await this.evento(exp.id, 'estado_documental', 'sistema', {
      anterior: exp.estadoDocumental,
      nuevo: estado,
    });
    return { estado, completadoAhora: estado === 'completo' };
  }

  /** Conciliación: expediente para toda fila de `emision` que no lo tenga. */
  async conciliar(): Promise<{
    revisadas: number;
    creadas: number;
    errores: number;
    noCubiertos: { producto: string; motivo: string }[];
  }> {
    const existentes = await prisma.mktExpediente.findMany({
      select: { empresaId: true, cnpoliza: true },
    });
    const claves = new Set(
      existentes.map((e) => `${e.empresaId}|${e.cnpoliza}`),
    );
    let revisadas = 0;
    let creadas = 0;
    let errores = 0;
    let cursor = 0;
    for (;;) {
      const lote = await prisma.emision.findMany({
        where: { id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take: 500,
        select: {
          id: true,
          empresaId: true,
          polizaNumero: true,
          jsonData: true,
          createdAt: true,
        },
      });
      if (!lote.length) break;
      for (const e of lote) {
        cursor = e.id;
        revisadas++;
        if (claves.has(`${e.empresaId}|${String(e.polizaNumero).trim()}`))
          continue;
        try {
          const r = await this.registrarDesdeEmision(e, {}, 'conciliacion');
          if (r?.creado) creadas++;
          claves.add(`${e.empresaId}|${String(e.polizaNumero).trim()}`);
        } catch (err) {
          errores++;
          await this.eventoTecnico({
            etapa: 'conciliacion',
            emisionId: e.id,
            error: err instanceof Error ? err.message.slice(0, 300) : 'error',
          });
        }
      }
      if (lote.length < 500) break;
    }
    return {
      revisadas,
      creadas,
      errores,
      // Patrimonial no registra en POST /api/emisiones: no llega al feed.
      noCubiertos: [
        {
          producto: 'patrimonial',
          motivo: 'La emisión patrimonial no registra la póliza en Nexus.',
        },
      ],
    };
  }

  /** Requisitos "sin_informacion": reintenta el cruce con la mesa técnica. */
  async cruzarSinInformacion(config: ExpedientesConfig): Promise<number> {
    const exps = await prisma.mktExpediente.findMany({
      where: { infoDocumental: false, estadoDocumental: 'sin_informacion' },
    });
    let cruzados = 0;
    for (const e of exps) {
      if (await this.cruzarMesaTecnica(e, config)) {
        cruzados++;
        await this.recalcularEstado(e.id, config);
      }
    }
    return cruzados;
  }

  // ─── Lectura ────────────────────────────────────────────────────────────

  private whereLista(q: Partial<ListQuery>, config: ExpedientesConfig) {
    const areas = areasEnAlcance(config.alcance) as string[];
    const area = q.area ? areaDesdeFiltro(q.area) : null;
    const where: Prisma.MktExpedienteWhereInput = {
      area: { in: area ? areas.filter((a) => a === area) : areas },
    };
    if (q.estadoDoc) where.estadoDocumental = q.estadoDoc;
    if (q.estadoPago) where.estadoPago = q.estadoPago;
    if (q.producto) where.producto = q.producto;
    if (q.desde || q.hasta) {
      where.emitidaEn = {
        ...(q.desde ? { gte: new Date(`${q.desde}T04:00:00.000Z`) } : {}),
        ...(q.hasta
          ? {
              lt: new Date(
                new Date(`${q.hasta}T04:00:00.000Z`).getTime() + 86_400_000,
              ),
            }
          : {}),
      };
    }
    const and: Prisma.MktExpedienteWhereInput[] = [];
    if (q.q) {
      const t = q.q;
      and.push({
        OR: [
          { cnpoliza: { contains: t, mode: 'insensitive' } },
          { aseguradoDocumento: { contains: t.replace(/\D/g, '') || t } },
          { aseguradoNombre: { contains: t, mode: 'insensitive' } },
          { aseguradoApellido: { contains: t, mode: 'insensitive' } },
        ],
      });
    }
    if (q.vendedor) {
      const v = q.vendedor;
      and.push({
        OR: [
          { xlogin: { contains: v, mode: 'insensitive' } },
          { cusuario: v },
          { citem: v },
          { cgestor: v },
          { ccanalalt: v },
          { cproductor: v },
        ],
      });
    }
    if (and.length) where.AND = and;
    return where;
  }

  private async requisitosDe(ids: number[]): Promise<Map<number, Req[]>> {
    const map = new Map<number, Req[]>();
    if (!ids.length) return map;
    const reqs = await prisma.mktExpedienteRequisito.findMany({
      where: { expedienteId: { in: ids } },
    });
    for (const r of reqs) {
      const list = map.get(r.expedienteId) ?? [];
      list.push(r);
      map.set(r.expedienteId, list);
    }
    return map;
  }

  async exclusionesActivas(): Promise<MktExpedienteExclusion[]> {
    return prisma.mktExpedienteExclusion.findMany({
      where: { activo: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  toItem(
    e: Exp,
    reqs: Req[],
    exclusiones: MktExpedienteExclusion[],
    config: ExpedientesConfig,
  ) {
    const aplicables = requisitosAplicables(e.producto, config);
    const porTipo = new Map(reqs.map((r) => [r.tipo, r]));
    const vendedor =
      e.xlogin ||
      (e.cusuario ? `Usuario ${e.cusuario}` : null) ||
      (e.cgestor ? `Gestor ${e.cgestor}` : null) ||
      (e.citem ? `${e.centidad ?? ''}${e.citem}` : null);
    const noEnviarPor = exclusionesQueAplican(e, exclusiones);
    return {
      id: e.id,
      empresaId: e.empresaId,
      cnpoliza: e.cnpoliza,
      cnrecibo: e.cnrecibo,
      producto: e.producto,
      area: e.area,
      areaCodigo: AREA_CODIGO[e.area] ?? null,
      vendedor,
      vendedorDetalle: {
        centidad: e.centidad,
        citem: e.citem,
        cgestor: e.cgestor,
        ccanalalt: e.ccanalalt,
        cusuario: e.cusuario,
        xlogin: e.xlogin,
        cproductor: valorActor(e, 'intermediario'),
      },
      asegurado: {
        documento: e.aseguradoDocumento
          ? `${e.aseguradoTipoDoc ?? ''}${e.aseguradoTipoDoc ? '-' : ''}${e.aseguradoDocumento}`
          : null,
        nombre:
          [e.aseguradoNombre, e.aseguradoApellido].filter(Boolean).join(' ') ||
          null,
        emailMasked: maskEmail(e.aseguradoEmail),
      },
      estadoPago: e.estadoPago,
      estadoDocumental: e.estadoDocumental,
      requisitos: aplicables.map((tipo) => {
        const r = porTipo.get(tipo);
        const estado =
          r?.estado ?? (e.infoDocumental ? 'faltante' : 'sin_informacion');
        return {
          tipo,
          label: requisitoLabel(tipo),
          estado,
          motivo: r?.motivo ?? null,
          ref: r?.ref ?? null,
          /** Bandeja: solo resultado y resumen de la IA (del archivo actual). */
          diagnostico: r ? diagnosticoCorto(diagnosticoVigente(r)) : null,
          /** Quién validó u observó: 'ia' o el usuario (manual). */
          actor:
            estado === 'validado' || estado === 'observado'
              ? (r?.validadoPor ?? null)
              : null,
          validadoPor: r?.validadoPor ?? null,
          decision: r?.decision ?? null,
        };
      }),
      intentos: e.intentos,
      ultimoEnvio: e.ultimoEnvio,
      proximoEnvio:
        e.estadoDocumental === 'completo' || e.cadenciaAgotada
          ? null
          : proximoEnvio(
              e.emitidaEn,
              config.cadenciaDias,
              e.etapaEnviada,
              config.horaDiaria,
            ),
      noEnviar: noEnviarPor.length > 0,
      /** Por qué no se envía: la exclusión más específica primero (p. ej. canal 45). */
      noEnviarPor: noEnviarPor.map((x) => ({
        id: x.id,
        alcance: x.alcance,
        valor: valorExclusion(x),
        motivo: x.motivo,
      })),
      sinCorreo: !emailValido(e.aseguradoEmail),
      cambiosDetectados: e.cambiosDetectados,
      /** v1.3: algún documento con datos cambiados en el formulario respecto al OCR al emitir. */
      datosModificados: aplicables.some((tipo) => {
        const r = porTipo.get(tipo);
        return !!r && conDatosModificados(r);
      }),
      emitidaEn: e.emitidaEn,
    };
  }

  /** Expedientes con algún documento errado (observado: no coincide, ilegible o sin certeza). */
  private async idsConErrores(): Promise<number[]> {
    const rows = await prisma.mktExpedienteRequisito.findMany({
      where: { estado: 'observado' },
      select: { expedienteId: true },
    });
    return Array.from(new Set(rows.map((r) => r.expedienteId)));
  }

  /** v1.3: expedientes con datos cambiados en el formulario (observado `datos_modificados`). */
  private async idsDatosModificados(): Promise<number[]> {
    const rows = await prisma.mktExpedienteRequisito.findMany({
      where: { estado: 'observado' },
      select: {
        expedienteId: true,
        estado: true,
        diagnostico: true,
        analisisRef: true,
        ref: true,
      },
    });
    return Array.from(
      new Set(
        rows.filter((r) => conDatosModificados(r)).map((r) => r.expedienteId),
      ),
    );
  }

  async listar(q: ListQuery) {
    const config = await this.getConfig();
    const where = this.whereLista(q, config);
    let ids: number[] | null = null;
    if (q.conErrores) ids = await this.idsConErrores();
    if (q.datosModificados) {
      const dm = await this.idsDatosModificados();
      ids = ids ? ids.filter((i) => dm.includes(i)) : dm;
    }
    if (ids) where.id = { in: ids };
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const exclusiones = await this.exclusionesActivas();

    // agrupar=asegurado: la misma lista plana, ordenada por asegurado.
    const orderBy: Prisma.MktExpedienteOrderByWithRelationInput[] =
      q.agrupar === 'asegurado'
        ? [{ aseguradoKey: 'asc' }, { emitidaEn: 'desc' }]
        : [{ emitidaEn: 'desc' }];
    const [total, exps] = await Promise.all([
      prisma.mktExpediente.count({ where }),
      prisma.mktExpediente.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const reqs = await this.requisitosDe(exps.map((e) => e.id));
    return {
      items: exps.map((e) =>
        this.toItem(e, reqs.get(e.id) ?? [], exclusiones, config),
      ),
      total,
      page,
      pageSize,
      agrupar: q.agrupar ?? 'poliza',
    };
  }

  async indicadores(q: Pick<ListQuery, 'area' | 'desde' | 'hasta'>) {
    const config = await this.getConfig();
    const exps = await prisma.mktExpediente.findMany({
      where: this.whereLista(q, config),
    });
    const reqs = await this.requisitosDe(exps.map((e) => e.id));
    const exclusiones = await this.exclusionesActivas();
    const conEstado = (e: Exp, estado: string) =>
      (reqs.get(e.id) ?? []).some((r) => r.estado === estado);
    const automatica = config.validacion === 'automatica';
    return {
      total: exps.length,
      completos: exps.filter((e) => e.estadoDocumental === 'completo').length,
      incompletos: exps.filter((e) => e.estadoDocumental === 'incompleto')
        .length,
      /** Sin datos documentales (registros viejos o personas sin wizard): no son incompletos. */
      sinInformacion: exps.filter(
        (e) => e.estadoDocumental === 'sin_informacion',
      ).length,
      pagadas: exps.filter((e) => e.estadoPago === 'pagada').length,
      pendientesPago: exps.filter((e) => e.estadoPago === 'pendiente').length,
      porValidar: exps.filter((e) => conEstado(e, 'recibido')).length,
      observados: exps.filter((e) => conEstado(e, 'observado')).length,
      /** Completos en los que la IA validó todos los documentos (sin intervención manual). */
      validadosIa: exps.filter(
        (e) =>
          e.estadoDocumental === 'completo' &&
          requisitosAplicables(e.producto, config).every(
            (t) =>
              (reqs.get(e.id) ?? []).find((r) => r.tipo === t)?.validadoPor ===
              'ia',
          ),
      ).length,
      /** Con algún documento errado (no coincide, ilegible o sin certeza): observado. */
      conErrores: exps.filter((e) => conEstado(e, 'observado')).length,
      /** v1.3: con datos cambiados en el formulario respecto a lo que leyó el OCR al emitir. */
      datosModificados: exps.filter((e) =>
        (reqs.get(e.id) ?? []).some(
          (r) =>
            requisitosAplicables(e.producto, config).includes(r.tipo) &&
            conDatosModificados(r),
        ),
      ).length,
      /** Con documentos recibidos que la IA aún no resuelve (incluye reintentos por error técnico). */
      analizando: automatica
        ? exps.filter((e) =>
            (reqs.get(e.id) ?? []).some(
              (r) =>
                r.estado === 'recibido' && !!r.ref && r.decision !== 'manual',
            ),
          ).length
        : 0,
      sinCorreo: exps.filter((e) => !emailValido(e.aseguradoEmail)).length,
      noEnviar: exps.filter((e) => estaExcluido(e, exclusiones)).length,
      intentos: exps.reduce((a, e) => a + e.intentos, 0),
      recuperados: exps.filter(
        (e) => e.estadoDocumental === 'completo' && e.intentos > 0,
      ).length,
      aseguradosUnicos: new Set(
        exps.map((e) => e.aseguradoKey ?? `exp:${e.id}`),
      ).size,
    };
  }

  async detalle(id: number) {
    const config = await this.getConfig();
    const e = await prisma.mktExpediente.findUnique({ where: { id } });
    if (!e) throw new AppError('Expediente no encontrado.', 404);
    const [reqs, eventos, notificaciones, exclusiones] = await Promise.all([
      prisma.mktExpedienteRequisito.findMany({ where: { expedienteId: id } }),
      prisma.mktExpedienteEvento.findMany({
        where: { expedienteId: id },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      prisma.mktExpedienteNotificacion.findMany({
        where: { expedienteId: id },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.exclusionesActivas(),
    ]);
    const item = this.toItem(e, reqs, exclusiones, config);
    const texto = (v: unknown) => (typeof v === 'string' ? v : null);
    return {
      ...item,
      validacion: config.validacion,
      documentos: Object.fromEntries(
        reqs
          .filter((r) => r.ref)
          .map((r) => [
            r.tipo,
            { ref: r.ref, recibido: r.estado !== 'faltante' },
          ]),
      ),
      requisitos: item.requisitos.map((r) => {
        const row = reqs.find((x) => x.tipo === r.tipo);
        return {
          ...r,
          origen: row?.origen ?? null,
          tieneArchivo: !!row?.ref,
          recibidoEn: row?.recibidoEn ?? null,
          validadoEn: row?.validadoEn ?? null,
          validadoPor: row?.validadoPor ?? null,
          /** Detalle: diagnóstico completo de la IA (campo por campo) del archivo actual. */
          diagnostico: row ? diagnosticoVigente(row) : null,
          analisis: row
            ? {
                intentos: row.analisisIntentos ?? 0,
                proximoAnalisis: row.proximoAnalisis ?? null,
                archivoHash: row.archivoHash ?? null,
              }
            : null,
        };
      }),
      exclusiones: exclusionesQueAplican(e, exclusiones).map((x) => ({
        id: x.id,
        alcance: x.alcance,
        valor: valorExclusion(x),
        motivo: x.motivo,
        creadoPor: x.creadoPor,
        createdAt: x.createdAt,
      })),
      eventos: eventos.map((ev) => {
        const d = rec(ev.detalle);
        return {
          id: ev.id,
          tipo: ev.tipo,
          actor: ev.actor,
          motivo: texto(d.motivo),
          requisito: texto(d.tipo),
          detalle: ev.detalle,
          fecha: ev.createdAt,
          createdAt: ev.createdAt,
        };
      }),
      notificaciones: notificaciones.map((n) => ({
        id: n.id,
        tipo: n.tipo,
        etapa: n.etapa,
        canal: 'correo',
        estado: n.resultado,
        resultado: n.resultado,
        destinoMasked: n.destinatarioMasked,
        error: n.error,
        fecha: n.createdAt,
        createdAt: n.createdAt,
      })),
      cambios: eventos
        .filter((ev) => ev.tipo === 'cambio_detectado')
        .flatMap((ev) => {
          const d = rec(ev.detalle);
          const lista = Array.isArray(d.cambios) ? d.cambios : [d];
          return lista.map((c) => {
            const x = rec(c);
            return {
              id: ev.id,
              campo: String(x.campo ?? ''),
              anterior: x.anterior ?? null,
              nuevo: x.nuevo ?? null,
              origen: texto(x.origen) ?? 'sis2000',
              fecha: ev.createdAt,
              createdAt: ev.createdAt,
            };
          });
        }),
    };
  }

  // ─── Validación manual (administrador) ─────────────────────────────────

  /**
   * Validar u observar a mano. Con validación automática es la excepción del administrador:
   * queda auditada (actor, motivo y lo que había dicho la IA) y prevalece sobre la IA, que no
   * vuelve a tocar ese requisito salvo que llegue un archivo nuevo.
   */
  async validarManual(
    id: number,
    tipo: string,
    accion: 'validar' | 'observar',
    actor: string,
    motivo?: string,
  ) {
    const config = await this.getConfig();
    const motivoTxt = motivo?.trim() ? motivo.trim().slice(0, 500) : null;
    const exp = await prisma.mktExpediente.findUnique({ where: { id } });
    if (!exp) throw new AppError('Expediente no encontrado.', 404);
    if (!requisitosAplicables(exp.producto, config).includes(tipo)) {
      throw new AppError('El requisito no aplica a este expediente.', 400);
    }
    await this.asegurarRequisitos(exp, config);
    const r = await prisma.mktExpedienteRequisito.findUnique({
      where: { expedienteId_tipo: { expedienteId: id, tipo } },
    });
    if (!r) throw new AppError('Requisito no encontrado.', 404);

    // Lo que había dicho la IA (si decidió ella), para la auditoría de la excepción.
    const ia =
      r.decision === 'ia' ? diagnosticoCorto(diagnosticoVigente(r)) : null;
    const auditoria = {
      tipo,
      anterior: r.estado,
      manual: true,
      validacion: config.validacion,
      sobreIa: !!ia,
      ia: ia ? { resultado: ia.resultado, resumen: ia.resumen } : null,
    };
    if (accion === 'validar') {
      if (r.estado !== 'recibido' && r.estado !== 'observado') {
        throw new AppError('Solo se valida un documento recibido.', 409);
      }
      await prisma.mktExpedienteRequisito.update({
        where: { id: r.id },
        data: {
          estado: 'validado',
          motivo: null,
          validadoEn: new Date(),
          validadoPor: actor,
          decision: 'manual',
          proximoAnalisis: null,
        },
      });
      await this.evento(id, 'requisito_validado', actor, {
        ...auditoria,
        motivo: motivoTxt,
      });
    } else {
      if (r.estado === 'faltante' || r.estado === 'sin_informacion') {
        throw new AppError('No hay documento recibido para observar.', 409);
      }
      await prisma.mktExpedienteRequisito.update({
        where: { id: r.id },
        data: {
          estado: 'observado',
          motivo: motivoTxt,
          validadoEn: null,
          validadoPor: actor,
          decision: 'manual',
          proximoAnalisis: null,
        },
      });
      await this.evento(id, 'requisito_observado', actor, {
        ...auditoria,
        motivo: motivoTxt,
      });
    }
    const { estado, completadoAhora } = await this.recalcularEstado(id, config);
    const actualizado = await prisma.mktExpediente.findUnique({
      where: { id },
    });
    if (actualizado) {
      if (completadoAhora) void this.notificarEvento(actualizado, 'completo');
      else if (accion === 'observar')
        void this.notificarEvento(actualizado, 'observado', {
          tipo,
          motivo: motivoTxt ?? '',
        });
    }
    return {
      id,
      tipo,
      estado: accion === 'validar' ? 'validado' : 'observado',
      estadoDocumental: estado,
      actor,
      decision: 'manual',
    };
  }

  // ─── Cargas (vendedor y página pública) ────────────────────────────────

  /**
   * Reenvía el archivo al OCR (que lo guarda) y actualiza el requisito.
   * Sin OCR configurado → recibido + evento técnico. Recibir nunca valida solo.
   */
  async cargarDocumento(params: {
    expedientes: Exp[];
    tipo: string;
    file: ArchivoCargado;
    origen: 'vendedor' | 'publico';
    actor: string;
  }) {
    const { expedientes, tipo, file, origen, actor } = params;
    if (!expedientes.length)
      throw new AppError('No hay pólizas para este documento.', 409);
    const config = await this.getConfig();
    const principal = expedientes[0];

    let ocrRes: OcrDocumentoResultado | null = null;
    let ocrDisponible = true;
    const empresaNombre = await prisma.empresa
      .findUnique({
        where: { id: principal.empresaId },
        select: { nombre: true },
      })
      .then((emp) => emp?.nombre ?? null)
      .catch(() => null);
    try {
      // La lectura OCR cuenta en el tope de análisis simultáneos; la carga va primero en la cola.
      ocrRes = await colaIa.ejecutar(
        () =>
          enviarDocumentoAlOcr({
            file,
            tipo,
            cnpoliza: principal.cnpoliza,
            cnrecibo: principal.cnrecibo,
            documento: principal.aseguradoDocumento,
            empresaId: principal.empresaId,
            empresaNombre,
            aceptaRif: aceptaRifEn(principal.producto, tipo),
          }),
        true,
      );
    } catch (err) {
      if (err instanceof OcrNoConfiguradoError) {
        ocrDisponible = false;
        await this.eventoTecnico(
          { etapa: 'carga', motivo: 'ocr_no_configurado', tipo },
          principal.id,
        );
      } else if (err instanceof OcrRechazoError) {
        // 400/413/422 del OCR: el archivo es el problema, no el servicio.
        throw new AppError(err.message, err.status);
      } else {
        await this.eventoTecnico(
          {
            etapa: 'carga',
            motivo: 'ocr_error',
            tipo,
            error: err instanceof Error ? err.message.slice(0, 300) : 'error',
          },
          principal.id,
        );
        throw new AppError(
          'No se pudo guardar el documento. Intente de nuevo.',
          502,
        );
      }
    }

    const resultados: {
      expedienteId: number;
      tipo: string;
      estado: string;
      motivo: string | null;
      diagnostico: Diagnostico | null;
    }[] = [];
    const ref = ocrRes?.ref ?? null;
    for (const exp of expedientes) {
      await this.asegurarRequisitos(exp, config);
      const r = await prisma.mktExpedienteRequisito.findUnique({
        where: { expedienteId_tipo: { expedienteId: exp.id, tipo } },
      });
      if (!r) continue;

      // Archivo nuevo: queda recibido y sin decisión previa (ni de la IA ni manual).
      const recibido = await prisma.mktExpedienteRequisito.update({
        where: { id: r.id },
        data: {
          estado: 'recibido',
          motivo: null,
          origen,
          ref,
          ocrDatos: (ocrRes?.ocr?.extraido ?? undefined) as
            | Prisma.InputJsonValue
            | undefined,
          ocrConfianza:
            ocrRes?.ocr?.confianza != null &&
            Number.isFinite(Number(ocrRes.ocr.confianza))
              ? Number(ocrRes.ocr.confianza)
              : null,
          recibidoEn: new Date(),
          validadoEn: null,
          validadoPor: null,
          decision: null,
          analisisIntentos: 0,
          proximoAnalisis: null,
        },
      });
      await this.evento(exp.id, 'documento_recibido', actor, {
        tipo,
        origen,
        ocr: ocrDisponible,
        ubicacion: ocrRes?.ubicacion ?? null,
        tamanoKb: Math.round(file.size / 1024),
      });

      let estado = 'recibido';
      let motivo: string | null = null;
      let diagnostico: Diagnostico | null = null;
      let completadoAhora = false;
      if (ocrDisponible && ref && this.iaActiva(config)) {
        // La lectura ya la hizo la carga: se compara contra la póliza sin otra llamada al OCR.
        const ctx = contextoPoliza(exp);
        const diag = diagnosticar(tipo, ocrRes?.ocr, ctx, {
          motivoAnalisis: 'carga',
        });
        const res = await this.aplicarDiagnostico(exp, recibido, diag, {
          ref,
          hash: ocrRes?.hash ?? null,
          lectura: ocrRes?.ocr ?? null,
          ctx,
          config,
          carga: true,
        });
        if (res) {
          estado = res.estado;
          motivo = res.motivo;
          diagnostico = res.diagnostico;
          completadoAhora = res.completadoAhora;
        }
      } else {
        ({ completadoAhora } = await this.recalcularEstado(exp.id, config));
      }
      resultados.push({
        expedienteId: exp.id,
        tipo,
        estado,
        motivo,
        diagnostico,
      });

      const actualizado = await prisma.mktExpediente.findUnique({
        where: { id: exp.id },
      });
      if (actualizado) {
        if (completadoAhora) void this.notificarEvento(actualizado, 'completo');
        else if (estado === 'observado')
          void this.notificarEvento(actualizado, 'observado', {
            tipo,
            // Al asegurado nunca el resumen de la IA (trae datos de la póliza).
            motivo: diagnostico
              ? motivoParaAsegurado(diagnostico)
              : (motivo ?? ''),
          });
        else void this.notificarEvento(actualizado, 'recibido', { tipo });
      }
    }
    return resultados;
  }

  // ─── Validación automática con IA ───────────────────────────────────────

  /** La IA corre con validación automática y el OCR interno configurado. */
  iaActiva(config: ExpedientesConfig): boolean {
    return config.validacion === 'automatica' && !!ocrInternalConfig();
  }

  /** Analiza en segundo plano lo recibido de un expediente (al crearlo o actualizarlo). */
  programarAnalisis(expedienteId: number): void {
    if (!expedientesEnabled() || !ocrInternalConfig()) return;
    const p: Promise<unknown> = new Promise<void>((resolve) =>
      setImmediate(resolve),
    )
      .then(() => this.revisarConIa({ expedienteIds: [expedienteId] }))
      .catch((err: unknown) => {
        logger.warn(
          `[expedientes] validación IA del expediente ${expedienteId} falló: ${
            err instanceof Error ? err.message : 'error'
          }`,
        );
      })
      .finally(() => {
        this.pendientesIa.delete(p);
      });
    this.pendientesIa.add(p);
  }

  /** Pruebas y apagado ordenado: espera los análisis en segundo plano. */
  async esperarAnalisisPendientes(): Promise<void> {
    while (this.pendientesIa.size) {
      await Promise.allSettled(Array.from(this.pendientesIa));
    }
    await colaIa.vacia();
  }

  /**
   * Revisión de la IA: analiza todo requisito recibido con archivo (incluidos los del wizard de
   * emisión y los reintentos por error técnico vencidos) y, en modo completo, vuelve a comparar
   * lo decidido por la IA si cambió el archivo o los datos de la póliza. Sin cambios no llama al OCR.
   * Nunca toca decisiones manuales. Máximo 2 análisis simultáneos (colaIa).
   */
  async revisarConIa(
    opts: {
      modo?: 'completo' | 'recibidos';
      expedienteIds?: number[];
      ahora?: Date;
    } = {},
  ): Promise<ResumenRevisionIa> {
    const resumen: ResumenRevisionIa = {
      omitido: null,
      revisados: 0,
      analizados: 0,
      sinCambios: 0,
      validados: 0,
      observados: 0,
      erroresTecnicos: 0,
      motivos: {},
    };
    if (!expedientesEnabled()) return { ...resumen, omitido: 'apagado' };
    const config = await this.getConfig();
    if (config.validacion !== 'automatica')
      return { ...resumen, omitido: 'validacion_manual' };
    if (!ocrInternalConfig())
      return { ...resumen, omitido: 'ocr_no_configurado' };
    const ahora = opts.ahora ?? new Date();

    const estados: Prisma.MktExpedienteRequisitoWhereInput =
      opts.modo === 'recibidos'
        ? { estado: 'recibido' }
        : {
            OR: [
              { estado: 'recibido' },
              { decision: 'ia', estado: { in: ['validado', 'observado'] } },
            ],
          };
    const reqs = await prisma.mktExpedienteRequisito.findMany({
      where: {
        ...estados,
        ref: { not: null },
        ...(opts.expedienteIds
          ? { expedienteId: { in: opts.expedienteIds } }
          : {}),
      },
      orderBy: { id: 'asc' },
    });
    if (!reqs.length) return resumen;
    const exps = await prisma.mktExpediente.findMany({
      where: {
        id: { in: Array.from(new Set(reqs.map((r) => r.expedienteId))) },
        area: { in: areasEnAlcance(config.alcance) },
      },
    });
    const porId = new Map(exps.map((e) => [e.id, e]));

    const trabajos: Promise<void>[] = [];
    for (const r of reqs) {
      const exp = porId.get(r.expedienteId);
      if (!exp || !requisitosAplicables(exp.producto, config).includes(r.tipo))
        continue;
      resumen.revisados++;
      const ctx = contextoPoliza(exp);
      const motivo = motivoAnalisis(r, huellaPoliza(ctx), ahora);
      if (!motivo) {
        resumen.sinCambios++;
        continue;
      }
      resumen.motivos[motivo] = (resumen.motivos[motivo] ?? 0) + 1;
      trabajos.push(
        this.analizarRequisito(exp, r, motivo, ctx, config).then((res) => {
          if (!res) return;
          resumen.analizados++;
          if (res.diagnostico.resultado === 'error_tecnico')
            resumen.erroresTecnicos++;
          else if (res.estado === 'validado') resumen.validados++;
          else if (res.estado === 'observado') resumen.observados++;
        }),
      );
    }
    await Promise.all(trabajos);
    return resumen;
  }

  private async analizarRequisito(
    exp: Exp,
    r: Req,
    motivo: MotivoAnalisis,
    ctx: ContextoPoliza,
    config: ExpedientesConfig,
  ) {
    if (!r.ref || this.enAnalisis.has(r.id)) return null;
    this.enAnalisis.add(r.id);
    try {
      let diag: Diagnostico;
      let hash: string | null = r.archivoHash ?? null;
      let lectura: OcrLectura | null | undefined;
      if (
        (motivo === 'cambio_poliza' || motivo === 'cambio_comparador') &&
        r.analisisRef === r.ref
      ) {
        // Mismo archivo: se compara de nuevo lo ya leído, sin otra llamada al OCR.
        if (!r.ocrDatos || typeof r.ocrDatos !== 'object') {
          // Ilegible o de otro tipo: no hay datos que comparar; solo se marca como revisado.
          await prisma.mktExpedienteRequisito.update({
            where: { id: r.id },
            data: {
              huellaPoliza: huellaPoliza(ctx),
              diagnostico: {
                ...rec(r.diagnostico),
                comparador: VERSION_COMPARADOR,
              } as Prisma.InputJsonValue,
            },
          });
          return null;
        }
        const previo = rec(r.diagnostico);
        diag = diagnosticar(
          r.tipo,
          {
            extraido: r.ocrDatos,
            confianza: r.ocrConfianza,
            proveedor: str(previo.proveedor) ?? null,
          },
          ctx,
          { motivoAnalisis: motivo },
        );
      } else {
        try {
          const res = await colaIa.ejecutar(() =>
            analizarEnOcr({
              ref: r.ref as string,
              tipo: r.tipo,
              aceptaRif: aceptaRifEn(exp.producto, r.tipo),
            }),
          );
          hash = res.hash;
          lectura = res.ocr;
          diag = diagnosticar(r.tipo, res.ocr, ctx, { motivoAnalisis: motivo });
        } catch (err) {
          diag = diagnosticoErrorTecnico(r.tipo, mensajeErrorOcr(err), {
            motivoAnalisis: motivo,
          });
        }
      }
      return await this.aplicarDiagnostico(exp, r, diag, {
        ref: r.ref,
        hash,
        lectura,
        ctx,
        config,
      });
    } finally {
      this.enAnalisis.delete(r.id);
    }
  }

  /**
   * Guarda el diagnóstico y aplica el estado: coincide → validado (actor ia);
   * no_coincide/ilegible → observado con el resumen; sin_certeza → observado «Revisar»;
   * error_tecnico → recibido con reintento en espera creciente. Cada análisis queda como
   * evento de auditoría con el diagnóstico.
   */
  private async aplicarDiagnostico(
    exp: Exp,
    antes: Req,
    diag: Diagnostico,
    d: {
      ref: string;
      hash: string | null;
      /** undefined = no hubo lectura nueva (se conserva la guardada). */
      lectura?: OcrLectura | null;
      ctx: ContextoPoliza;
      config: ExpedientesConfig;
      carga?: boolean;
    },
  ): Promise<{
    estado: string;
    motivo: string | null;
    completadoAhora: boolean;
    diagnostico: Diagnostico;
  } | null> {
    const r = await prisma.mktExpedienteRequisito.findUnique({
      where: { id: antes.id },
    });
    // Llegó otro archivo o el administrador decidió mientras se analizaba: manda lo nuevo.
    if (!r || r.ref !== d.ref) return null;
    if (!d.carga && r.decision === 'manual') return null;

    const ahora = new Date();
    const data: Prisma.MktExpedienteRequisitoUpdateInput = {
      huellaPoliza: huellaPoliza(d.ctx),
      analisisRef: d.ref,
      archivoHash:
        d.hash ?? (r.analisisRef === d.ref ? (r.archivoHash ?? null) : null),
    };
    let estado: string;
    let motivo: string | null;
    if (diag.resultado === 'error_tecnico') {
      const previo = diagnosticoVigente(r);
      const intento =
        (previo?.resultado === 'error_tecnico' ? r.analisisIntentos : 0) + 1;
      const proximo = new Date(ahora.getTime() + esperaReintentoMs(intento));
      diag.intento = intento;
      diag.proximoIntento = proximo.toISOString();
      diag.resumen = `${diag.resumen} Se reintentará automáticamente.`;
      estado = 'recibido';
      motivo = null;
      Object.assign(data, {
        estado,
        motivo,
        validadoEn: null,
        validadoPor: null,
        decision: null,
        analisisIntentos: intento,
        proximoAnalisis: proximo,
      });
    } else {
      ({ estado, motivo } = estadoPorDiagnostico(diag));
      Object.assign(data, {
        estado,
        motivo,
        validadoEn: estado === 'validado' ? ahora : null,
        validadoPor: 'ia',
        decision: 'ia',
        analisisIntentos: 0,
        proximoAnalisis: null,
      });
      if (d.lectura !== undefined) {
        const conf = Number(d.lectura?.confianza);
        data.ocrDatos = (d.lectura?.extraido ?? undefined) as
          | Prisma.InputJsonValue
          | undefined;
        data.ocrConfianza = Number.isFinite(conf) ? conf : null;
      }
    }
    data.diagnostico = diag as unknown as Prisma.InputJsonValue;
    await prisma.mktExpedienteRequisito.update({ where: { id: r.id }, data });

    const tipoEvento =
      estado === r.estado
        ? 'analisis_ia'
        : estado === 'validado'
          ? 'requisito_validado'
          : estado === 'observado'
            ? 'requisito_observado'
            : 'analisis_ia';
    await this.evento(exp.id, tipoEvento, 'ia', {
      tipo: r.tipo,
      anterior: r.estado,
      nuevo: estado,
      motivo,
      resultado: diag.resultado,
      motivoAnalisis: diag.motivoAnalisis ?? null,
      diagnostico: diag,
    });
    const { completadoAhora } = await this.recalcularEstado(exp.id, d.config);
    return { estado, motivo, completadoAhora, diagnostico: diag };
  }

  async cargarVendedor(
    id: number,
    tipo: string,
    file: ArchivoCargado,
    actor: string,
  ) {
    const config = await this.getConfig();
    const exp = await prisma.mktExpediente.findUnique({ where: { id } });
    if (!exp) throw new AppError('Expediente no encontrado.', 404);
    if (!requisitosAplicables(exp.producto, config).includes(tipo)) {
      throw new AppError('El requisito no aplica a este expediente.', 400);
    }
    const r = await prisma.mktExpedienteRequisito.findUnique({
      where: { expedienteId_tipo: { expedienteId: id, tipo } },
    });
    if (r?.estado === 'validado') {
      throw new AppError('Ese documento ya está validado.', 409);
    }
    const [res] = await this.cargarDocumento({
      expedientes: [exp],
      tipo,
      file,
      origen: 'vendedor',
      actor,
    });
    return res;
  }

  // ─── Enlace del asegurado ───────────────────────────────────────────────

  async crearEnlace(aseguradoKeyValue: string | null, expedienteIds: number[]) {
    const { token, hash } = generarToken();
    const expiraEn = new Date(Date.now() + linkDias() * 86_400_000);
    await prisma.mktExpedienteEnlace.create({
      data: {
        tokenHash: hash,
        proposito: 'carga_documental',
        aseguradoKey: aseguradoKeyValue,
        expedienteIds: expedienteIds as unknown as Prisma.InputJsonValue,
        expiraEn,
      },
    });
    const base = publicBaseUrl();
    return {
      url: base ? `${base}/expediente?t=${token}` : null,
      expiraEn,
      token,
    };
  }

  /** Token → enlace vigente y expedientes del MISMO asegurado. */
  async resolverEnlace(token: string) {
    if (!formatoTokenValido(token)) {
      throw new AppError('Enlace no válido.', 404);
    }
    const enlace = await prisma.mktExpedienteEnlace.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!enlace || enlace.proposito !== 'carga_documental') {
      throw new AppError('Enlace no válido.', 404);
    }
    if (enlace.revocadoEn)
      throw new AppError('Este enlace ya no es válido.', 410);
    if (enlace.usadoEn)
      throw new AppError(
        'Este enlace ya fue utilizado. Ya recibimos tus documentos.',
        410,
      );
    if (enlace.expiraEn.getTime() <= Date.now())
      throw new AppError(
        'Este enlace venció. Revisa el correo más reciente.',
        410,
      );
    const ids = (
      Array.isArray(enlace.expedienteIds) ? enlace.expedienteIds : []
    )
      .map(Number)
      .filter((n) => Number.isInteger(n));
    const exps = ids.length
      ? await prisma.mktExpediente.findMany({ where: { id: { in: ids } } })
      : [];
    const propios = exps
      .filter(
        (e) => !enlace.aseguradoKey || e.aseguradoKey === enlace.aseguradoKey,
      )
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return { enlace, expedientes: propios };
  }

  async vistaPublica(token: string) {
    const config = await this.getConfig();
    const { enlace, expedientes } = await this.resolverEnlace(token);
    await prisma.mktExpedienteEnlace.update({
      where: { id: enlace.id },
      data: { ultimoAccesoEn: new Date(), accesos: { increment: 1 } },
    });
    const reqs = await this.requisitosDe(expedientes.map((e) => e.id));
    // Mismo vocabulario que el monitor; "sin_informacion" no se muestra.
    const prioridad: Record<string, number> = {
      observado: 4,
      faltante: 3,
      recibido: 2,
      validado: 1,
    };
    const polizas = expedientes.map((e, i) => {
      const porTipo = new Map((reqs.get(e.id) ?? []).map((r) => [r.tipo, r]));
      return {
        ref: i + 1,
        polizaMasked: maskPoliza(e.cnpoliza),
        producto: e.producto,
        requisitos: requisitosAplicables(e.producto, config)
          .map((tipo) => {
            const r = porTipo.get(tipo);
            const estado = r?.estado ?? 'faltante';
            // Solo el resultado de la IA: nunca el resumen ni datos de la póliza.
            const diag = r ? diagnosticoVigente(r) : null;
            const deIa = !!diag && r?.decision === 'ia';
            return {
              tipo,
              label: requisitoLabel(tipo),
              estado,
              motivo:
                estado === 'observado'
                  ? deIa
                    ? motivoParaAsegurado(diag)
                    : (r?.motivo ?? null)
                  : null,
              diagnostico: diag ? { resultado: diag.resultado } : null,
            };
          })
          .filter((r) => r.estado !== 'sin_informacion'),
      };
    });
    const agregados = new Map<
      string,
      (typeof polizas)[number]['requisitos'][number]
    >();
    for (const p of polizas) {
      for (const r of p.requisitos) {
        const prev = agregados.get(r.tipo);
        if (!prev || (prioridad[r.estado] ?? 0) > (prioridad[prev.estado] ?? 0))
          agregados.set(r.tipo, r);
      }
    }
    const requisitos = Array.from(agregados.values());
    return {
      nombre: expedientes[0] ? primerNombre(expedientes[0]) : null,
      polizaMasked: polizas.map((p) => p.polizaMasked).join(', ') || null,
      requisitos,
      pendientes: requisitos
        .filter((r) => esPendiente(r.estado))
        .map((r) => r.tipo),
      polizas,
      expiraEn: enlace.expiraEn,
    };
  }

  async cargaPublica(
    token: string,
    tipo: string,
    polizaRef: string | undefined,
    file: ArchivoCargado,
  ) {
    const config = await this.getConfig();
    const { enlace, expedientes } = await this.resolverEnlace(token);
    const reqs = await this.requisitosDe(expedientes.map((e) => e.id));
    const pendienteEn = (e: Exp) =>
      requisitosAplicables(e.producto, config).includes(tipo) &&
      esPendiente(
        (reqs.get(e.id) ?? []).find((r) => r.tipo === tipo)?.estado ??
          'faltante',
      );

    let destino: Exp[];
    if (polizaRef) {
      const idx = Number(polizaRef) - 1;
      const e = expedientes[idx];
      if (!e) throw new AppError('Póliza no válida para este enlace.', 400);
      destino = pendienteEn(e) ? [e] : [];
    } else {
      destino = expedientes.filter(pendienteEn);
      // El certificado es por vehículo: sin `poliza`, va a la primera pendiente.
      if (tipo === 'certificado' && destino.length > 1) destino = [destino[0]];
    }
    if (!destino.length) {
      throw new AppError('Ese documento no está pendiente.', 409);
    }
    const resultados = await this.cargarDocumento({
      expedientes: destino,
      tipo,
      file,
      origen: 'publico',
      actor: 'asegurado',
    });

    // Enlace consumido cuando ya no queda nada pendiente.
    const reqsDespues = await this.requisitosDe(expedientes.map((e) => e.id));
    const quedan = expedientes.some((e) =>
      requisitosAplicables(e.producto, config).some((t) =>
        esPendiente(
          (reqsDespues.get(e.id) ?? []).find((r) => r.tipo === t)?.estado ??
            'faltante',
        ),
      ),
    );
    if (!quedan) {
      await prisma.mktExpedienteEnlace.update({
        where: { id: enlace.id },
        data: { usadoEn: new Date() },
      });
    }
    const observado = resultados.find((r) => r.estado === 'observado');
    return {
      tipo,
      estado: observado
        ? 'observado'
        : resultados.length && resultados.every((r) => r.estado === 'validado')
          ? 'validado'
          : 'recibido',
      // Al asegurado nunca el resumen de la IA (trae datos de la póliza).
      motivo: observado
        ? observado.diagnostico
          ? motivoParaAsegurado(observado.diagnostico)
          : observado.motivo
        : null,
      diagnostico: observado?.diagnostico
        ? { resultado: observado.diagnostico.resultado }
        : resultados[0]?.diagnostico
          ? { resultado: resultados[0].diagnostico.resultado }
          : null,
      enlaceConsumido: !quedan,
    };
  }

  // ─── Correos por evento (3, 4 y 5) ─────────────────────────────────────

  async registrarNotificacion(data: {
    expedienteId: number | null;
    aseguradoKey?: string | null;
    tipo: string;
    etapa?: number | null;
    resultado: string;
    destinatarioMasked?: string | null;
    error?: string | null;
    lote?: string | null;
  }) {
    await prisma.mktExpedienteNotificacion.create({
      data: {
        expedienteId: data.expedienteId,
        aseguradoKey: data.aseguradoKey ?? null,
        tipo: data.tipo,
        etapa: data.etapa ?? null,
        resultado: data.resultado,
        destinatarioMasked: data.destinatarioMasked ?? null,
        proveedor: 'nest-mail',
        error: data.error ?? null,
        lote: data.lote ?? null,
      },
    });
  }

  async notificarEvento(
    exp: Exp,
    tipo: 'observado' | 'recibido' | 'completo',
    extra: { tipo?: string; motivo?: string } = {},
  ): Promise<void> {
    try {
      const exclusiones = await this.exclusionesActivas();
      if (estaExcluido(exp, exclusiones)) {
        await this.registrarNotificacion({
          expedienteId: exp.id,
          aseguradoKey: exp.aseguradoKey,
          tipo,
          resultado: 'excluido',
        });
        return;
      }
      const nombre = primerNombre(exp);
      const [config, reqs] = await Promise.all([
        this.getConfig(),
        this.requisitosDe([exp.id]),
      ]);
      const documentos = documentosCorreo(
        [exp],
        reqs,
        config,
        tipo === 'recibido' ? extra.tipo : undefined,
      );
      const base = { nombre, polizas: [exp.cnpoliza], documentos };
      let content;
      if (tipo === 'completo') {
        content = correoCompleto({ ...base, enlace: null });
      } else if (tipo === 'recibido') {
        content = correoRecibido({
          ...base,
          enlace: null,
          documento: requisitoLabel(extra.tipo ?? ''),
        });
      } else {
        const link = emailValido(exp.aseguradoEmail)
          ? await this.crearEnlace(exp.aseguradoKey, [exp.id])
          : null;
        const motivo = extra.motivo || 'el documento no se pudo verificar';
        content = correoObservado({
          ...base,
          // El motivo del evento manda sobre el guardado (es el de esta revisión).
          documentos: documentos.map((d) =>
            d.estado === 'corregir' &&
            d.nombre === requisitoLabel(extra.tipo ?? '')
              ? { ...d, motivo }
              : d,
          ),
          documento: requisitoLabel(extra.tipo ?? ''),
          motivo,
          enlace: link?.url ?? null,
          expiraEn: link?.expiraEn ?? null,
        });
      }
      const r = await entregarCorreo([exp.aseguradoEmail], nombre, content);
      await this.registrarNotificacion({
        expedienteId: exp.id,
        aseguradoKey: exp.aseguradoKey,
        tipo,
        resultado: r.resultado,
        destinatarioMasked: r.destinatarioMasked,
        error: r.error,
      });
    } catch (err) {
      logger.warn(
        `[expedientes] aviso ${tipo} expediente ${exp.id} no registrado: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * QA: envía la solicitud de documentos de un expediente, con un enlace real a la página del
   * asegurado, a un correo que no es el de la póliza (para mostrar el flujo). La ruta solo existe
   * fuera de producción y entregarCorreo sigue exigiendo la lista blanca. No suma intentos ni
   * avanza la cadencia; queda como notificación tipo 'prueba' y evento de auditoría.
   */
  async enviarPrueba(id: number, email: string, actor: string) {
    const destino = String(email ?? '')
      .trim()
      .toLowerCase();
    if (!emailValido(destino))
      throw new AppError('Indique un correo válido.', 400);
    const exp = await prisma.mktExpediente.findUnique({ where: { id } });
    if (!exp) throw new AppError('Expediente no encontrado.', 404);
    const [config, reqs] = await Promise.all([
      this.getConfig(),
      prisma.mktExpedienteRequisito.findMany({ where: { expedienteId: id } }),
    ]);
    const link = await this.crearEnlace(exp.aseguradoKey, [exp.id]);
    const nombre = primerNombre(exp);
    const base = correoSolicitudInicial({
      nombre,
      polizas: [exp.cnpoliza],
      documentos: documentosCorreo([exp], new Map([[exp.id, reqs]]), config),
      enlace: link.url,
      expiraEn: link.expiraEn,
    });
    const content = { ...base, subject: `[Prueba QA] ${base.subject}` };
    const r = await entregarCorreo([destino], nombre, content);
    await this.registrarNotificacion({
      expedienteId: exp.id,
      aseguradoKey: exp.aseguradoKey,
      tipo: 'prueba',
      resultado: r.resultado,
      destinatarioMasked: r.destinatarioMasked,
      error: r.error ?? null,
    });
    await this.evento(exp.id, 'envio_prueba', actor, {
      resultado: r.resultado,
      destinatario: r.destinatarioMasked,
    });
    return {
      resultado: r.resultado,
      destinatario: r.destinatarioMasked,
      enlace: link.url,
      expiraEn: link.expiraEn,
    };
  }

  // ─── Exclusiones («No enviar correos») ─────────────────────────────────

  async crearExclusion(
    body: {
      alcance: AlcanceExclusion;
      motivo: string;
      expedienteId?: number;
      cnpoliza?: string;
      empresaId?: number;
      documento?: string;
      tipoDoc?: string;
      /**
       * documento (asegurado), cnpoliza (póliza) o código de canal (ccanalalt),
       * gestor (cgestor) o intermediario (cproductor), según el alcance.
       */
      valor?: string;
      /** Acción de selección múltiple a la que pertenece (auditoría). */
      lote?: string;
    },
    actor: string,
  ) {
    let exp: Exp | null = null;
    if (body.expedienteId != null) {
      exp = await prisma.mktExpediente.findUnique({
        where: { id: body.expedienteId },
      });
      if (!exp) throw new AppError('Expediente no encontrado.', 404);
    }
    if (esTipoActor(body.alcance)) {
      return this.crearExclusionActor(body.alcance, body, exp, actor);
    }
    const documento =
      body.alcance === 'asegurado' ? (body.documento ?? body.valor) : undefined;
    const cnpolizaBody =
      body.alcance === 'poliza' ? (body.cnpoliza ?? body.valor) : undefined;
    const id = separarIdentificacion(documento);
    const key =
      body.alcance === 'asegurado'
        ? (exp?.aseguradoKey ??
          aseguradoKey({
            tipoDoc: body.tipoDoc ?? id.tipoDoc ?? 'V',
            documento: id.documento,
          }))
        : null;
    if (body.alcance === 'poliza' && !exp && !cnpolizaBody) {
      throw new AppError('Indique la póliza.', 400);
    }
    if (body.alcance === 'asegurado' && !key) {
      throw new AppError(
        'El expediente no tiene asegurado identificable.',
        400,
      );
    }
    const x = await prisma.mktExpedienteExclusion.create({
      data: {
        alcance: body.alcance,
        motivo: body.motivo,
        creadoPor: actor,
        expedienteId: body.alcance === 'poliza' ? (exp?.id ?? null) : null,
        empresaId:
          body.alcance === 'poliza'
            ? (exp?.empresaId ?? body.empresaId ?? null)
            : null,
        cnpoliza:
          body.alcance === 'poliza'
            ? (exp?.cnpoliza ?? cnpolizaBody?.trim() ?? null)
            : null,
        aseguradoKey: key,
      },
    });
    await this.evento(exp?.id ?? null, 'exclusion_creada', actor, {
      exclusionId: x.id,
      alcance: x.alcance,
      motivo: x.motivo,
      ...(body.lote ? { lote: body.lote } : {}),
    });
    return x;
  }

  /** Canal, gestor o intermediario: alcanza a todas sus pólizas, presentes y futuras. */
  private async crearExclusionActor(
    tipo: TipoActor,
    body: { motivo: string; valor?: string; lote?: string },
    exp: Exp | null,
    actor: string,
  ) {
    const valor =
      normalizarCodigoActor(body.valor) ?? (exp ? valorActor(exp, tipo) : null);
    if (!valor) {
      throw new AppError(
        exp
          ? `La póliza no tiene ${ETIQUETA_ACTOR[tipo]} registrado.`
          : `Indique el código del ${ETIQUETA_ACTOR[tipo]}.`,
        400,
      );
    }
    const x = await prisma.mktExpedienteExclusion.create({
      data: {
        alcance: tipo,
        valor,
        motivo: body.motivo,
        creadoPor: actor,
      },
    });
    await this.evento(exp?.id ?? null, 'exclusion_creada', actor, {
      exclusionId: x.id,
      alcance: x.alcance,
      valor,
      motivo: x.motivo,
      ...(body.lote ? { lote: body.lote } : {}),
    });
    return x;
  }

  /** Clave para no repetir una exclusión activa del mismo alcance y valor. */
  private claveExclusion(
    alcance: AlcanceExclusion,
    valor: string,
  ): string | null {
    if (esTipoActor(alcance)) return normalizarCodigoActor(valor);
    if (alcance === 'poliza') return str(valor) ?? null;
    const id = separarIdentificacion(valor);
    return aseguradoKey({
      tipoDoc: id.tipoDoc ?? 'V',
      documento: id.documento,
    });
  }

  private claveDeExclusion(x: MktExpedienteExclusion): string | null {
    if (esTipoActor(x.alcance)) return normalizarCodigoActor(x.valor);
    if (x.alcance === 'poliza') return x.cnpoliza;
    return x.aseguradoKey;
  }

  /**
   * Selección múltiple: un motivo común y una exclusión propia por valor (auditada y
   * reactivable por separado). Los valores repetidos o ya excluidos se informan, no se duplican.
   */
  async crearExclusionesLote(
    body: {
      alcance: AlcanceExclusion;
      motivo: string;
      valores: string[];
      empresaId?: number;
    },
    actor: string,
  ) {
    const lote = randomUUID();
    const activas = (await this.exclusionesActivas()).filter(
      (x) =>
        x.alcance === body.alcance &&
        (body.alcance !== 'poliza' ||
          x.empresaId == null ||
          x.empresaId === (body.empresaId ?? null)),
    );
    const yaActivas = new Set(activas.map((x) => this.claveDeExclusion(x)));
    const vistas = new Set<string>();
    const creadas: ReturnType<typeof exclusionDto>[] = [];
    const omitidas: { valor: string; motivo: string }[] = [];
    for (const valor of body.valores) {
      const clave = this.claveExclusion(body.alcance, valor);
      if (!clave) {
        omitidas.push({ valor, motivo: 'Valor no válido.' });
        continue;
      }
      if (vistas.has(clave)) continue;
      vistas.add(clave);
      if (yaActivas.has(clave)) {
        omitidas.push({ valor, motivo: 'Ya estaba excluido.' });
        continue;
      }
      try {
        const x = await this.crearExclusion(
          {
            alcance: body.alcance,
            motivo: body.motivo,
            valor,
            empresaId: body.empresaId,
            lote,
          },
          actor,
        );
        creadas.push(exclusionDto(x));
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        omitidas.push({ valor, motivo: err.message });
      }
    }
    return { lote, alcance: body.alcance, creadas, omitidas };
  }

  /**
   * Canales, gestores o intermediarios presentes en los expedientes guardados (sin
   * consultar Sis2000), con el nombre si la emisión lo dejó y el número de pólizas.
   */
  async actores(tipo: TipoActor, q?: string) {
    const exps = await prisma.mktExpediente.findMany({
      select: {
        id: true,
        centidad: true,
        citem: true,
        cgestor: true,
        ccanalalt: true,
        cproductor: true,
        snapshot: true,
      },
    });
    const excluidos = new Map(
      (await this.exclusionesActivas())
        .filter((x) => x.alcance === tipo)
        .map((x) => [normalizarCodigoActor(x.valor), x.id]),
    );
    const porValor = new Map<
      string,
      { nombre: string | null; polizas: number }
    >();
    for (const e of exps) {
      const valor = valorActor(e, tipo);
      if (!valor) continue;
      const a = porValor.get(valor) ?? { nombre: null, polizas: 0 };
      a.polizas++;
      a.nombre = a.nombre ?? nombreActorDeSnapshot(e.snapshot, tipo);
      porValor.set(valor, a);
    }
    const t = (q ?? '').trim().toLowerCase();
    return Array.from(porValor, ([valor, a]) => ({
      tipo,
      valor,
      nombre: a.nombre,
      polizas: a.polizas,
      excluido: excluidos.has(valor),
      exclusionId: excluidos.get(valor) ?? null,
    }))
      .filter(
        (a) =>
          !t ||
          a.valor.toLowerCase().includes(t) ||
          (a.nombre ?? '').toLowerCase().includes(t),
      )
      .sort((a, b) => b.polizas - a.polizas || a.valor.localeCompare(b.valor));
  }

  async eliminarExclusion(id: number, actor: string, motivo?: string) {
    const x = await prisma.mktExpedienteExclusion.findUnique({ where: { id } });
    if (!x || !x.activo) throw new AppError('Exclusión no encontrada.', 404);
    const upd = await prisma.mktExpedienteExclusion.update({
      where: { id },
      data: {
        activo: false,
        eliminadoPor: actor,
        eliminadoEn: new Date(),
        motivoEliminacion: motivo ?? null,
      },
    });
    await this.evento(x.expedienteId ?? null, 'exclusion_eliminada', actor, {
      exclusionId: id,
      alcance: x.alcance,
      ...(esTipoActor(x.alcance) ? { valor: x.valor } : {}),
      motivo: motivo ?? null,
    });
    return upd;
  }

  async listarExclusiones(
    incluirInactivas = false,
    alcance?: AlcanceExclusion,
  ) {
    const rows = await prisma.mktExpedienteExclusion.findMany({
      where: {
        ...(incluirInactivas ? {} : { activo: true }),
        ...(alcance ? { alcance } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map(exclusionDto);
  }

  /** Configuración + historial de cambios (uno por campo cambiado). */
  async getConfigConCambios() {
    const config = await this.getConfig();
    const eventos = await prisma.mktExpedienteEvento.findMany({
      where: { expedienteId: null, tipo: 'config_actualizada' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const cambios = eventos.flatMap((ev) => {
      const d = rec(ev.detalle);
      const anterior = rec(d.anterior);
      const nuevo = rec(d.nuevo);
      const campos = Object.keys(nuevo).filter(
        (k) => JSON.stringify(anterior[k]) !== JSON.stringify(nuevo[k]),
      );
      return campos.map((campo) => ({
        id: `${ev.id}-${campo}`,
        campo,
        anterior: anterior[campo] ?? null,
        nuevo: nuevo[campo] ?? null,
        actor: ev.actor,
        motivo: typeof d.motivo === 'string' ? d.motivo : null,
        fecha: ev.createdAt,
        createdAt: ev.createdAt,
      }));
    });
    return { ...config, cambios };
  }
}

export const expedientesService = new ExpedientesService();
