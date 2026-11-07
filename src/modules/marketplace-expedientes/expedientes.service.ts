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
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { AppError } from '../../utils/app-error';
import {
  AreaExpediente,
  aseguradoKey,
  areaDesdeVendedor,
  areasEnAlcance,
  calcularEstadoDocumental,
  compararOcrConSnapshot,
  emailValido,
  esPendiente,
  ExpedientesConfig,
  maskEmail,
  maskPoliza,
  mergeConfig,
  normalizarEstadoPago,
  normalizarProducto,
  proximoEnvio,
  requisitoLabel,
  requisitosAplicables,
  separarIdentificacion,
} from './expedientes.domain';
import { expedientesEnabled, linkDias, publicBaseUrl } from './expedientes.env';
import {
  ArchivoCargado,
  enviarDocumentoAlOcr,
  formatoTokenValido,
  generarToken,
  hashToken,
  OcrDocumentoResultado,
  OcrNoConfiguradoError,
  OcrRechazoError,
} from './expedientes.files';
import {
  correoCompleto,
  correoObservado,
  correoRecibido,
  entregarCorreo,
} from './expedientes.mail';
import {
  expedientePayloadSchema,
  ExpedientePayload,
  ListQuery,
} from './expedientes.schema';

const CONFIG_KEY = 'global';

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

export function estaExcluido(
  e: Pick<Exp, 'id' | 'empresaId' | 'cnpoliza' | 'aseguradoKey'>,
  exclusiones: MktExpedienteExclusion[],
): boolean {
  return exclusiones.some((x) => {
    if (!x.activo) return false;
    if (x.alcance === 'poliza') {
      if (x.expedienteId != null) return x.expedienteId === e.id;
      return (
        x.cnpoliza === e.cnpoliza &&
        (x.empresaId == null || x.empresaId === e.empresaId)
      );
    }
    return !!x.aseguradoKey && x.aseguradoKey === e.aseguradoKey;
  });
}

export class ExpedientesService {
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
    };
    if (!vendedor.centidad && vendedor.cusuario) {
      vendedor = {
        ...vendedor,
        ...(await this.vendedorDesdePerfil(vendedor.cusuario)),
      };
    }
    const area: AreaExpediente = areaDesdeVendedor(vendedor);

    const producto = normalizarProducto(
      str(extra.producto) ?? str(jd.producto),
      str(p.producto),
    );
    const cramoRaw = p.cramo ?? Number(jd.cramo);
    const snapshot =
      p.snapshot ??
      ({
        tomador: {
          nombre: nombreTomador ?? null,
          identificacion: str(jd.tomadorIdentificacion) ?? null,
        },
        plan: str(extra.planNombre) ?? str(jd.planNombre) ?? null,
        prima: extra.monto ?? (jd.monto != null ? Number(jd.monto) : null),
      } as Record<string, unknown>);

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
  private async vendedorDesdePerfil(cusuario: string) {
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
    if (p.snapshot) out.snapshot = datos.snapshot;
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
        return {
          tipo,
          label: requisitoLabel(tipo),
          estado:
            r?.estado ?? (e.infoDocumental ? 'faltante' : 'sin_informacion'),
          motivo: r?.motivo ?? null,
          ref: r?.ref ?? null,
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
      noEnviar: estaExcluido(e, exclusiones),
      sinCorreo: !emailValido(e.aseguradoEmail),
      cambiosDetectados: e.cambiosDetectados,
      emitidaEn: e.emitidaEn,
    };
  }

  async listar(q: ListQuery) {
    const config = await this.getConfig();
    const where = this.whereLista(q, config);
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
        };
      }),
      exclusiones: exclusiones
        .filter((x) => estaExcluido(e, [x]))
        .map((x) => ({
          id: x.id,
          alcance: x.alcance,
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

  // ─── Validación manual ──────────────────────────────────────────────────

  async validarManual(
    id: number,
    tipo: string,
    accion: 'validar' | 'observar',
    actor: string,
    motivo?: string,
  ) {
    const config = await this.getConfig();
    if (config.validacion !== 'manual') {
      throw new AppError(
        'La validación está configurada como automática.',
        409,
      );
    }
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
        },
      });
      await this.evento(id, 'requisito_validado', actor, {
        tipo,
        anterior: r.estado,
      });
    } else {
      if (r.estado === 'faltante' || r.estado === 'sin_informacion') {
        throw new AppError('No hay documento recibido para observar.', 409);
      }
      await prisma.mktExpedienteRequisito.update({
        where: { id: r.id },
        data: {
          estado: 'observado',
          motivo: motivo ?? null,
          validadoEn: null,
          validadoPor: actor,
        },
      });
      await this.evento(id, 'requisito_observado', actor, {
        tipo,
        anterior: r.estado,
        motivo,
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
          motivo: motivo ?? '',
        });
    }
    return {
      id,
      tipo,
      estado: accion === 'validar' ? 'validado' : 'observado',
      estadoDocumental: estado,
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
      ocrRes = await enviarDocumentoAlOcr({
        file,
        tipo,
        cnpoliza: principal.cnpoliza,
        cnrecibo: principal.cnrecibo,
        documento: principal.aseguradoDocumento,
        empresaId: principal.empresaId,
        empresaNombre,
      });
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
    }[] = [];
    for (const exp of expedientes) {
      await this.asegurarRequisitos(exp, config);
      const r = await prisma.mktExpedienteRequisito.findUnique({
        where: { expedienteId_tipo: { expedienteId: exp.id, tipo } },
      });
      if (!r) continue;

      let estado = 'recibido';
      let motivo: string | null = null;
      if (ocrDisponible && config.validacion === 'automatica') {
        const cmp = compararOcrConSnapshot(tipo, ocrRes?.ocr, {
          documento: exp.aseguradoDocumento,
          nombre: exp.aseguradoNombre,
          apellido: exp.aseguradoApellido,
          snapshot: exp.snapshot,
        });
        estado = cmp.estado;
        motivo = cmp.estado === 'observado' ? cmp.motivo : null;
      }
      await prisma.mktExpedienteRequisito.update({
        where: { id: r.id },
        data: {
          estado,
          motivo,
          origen,
          ref: ocrRes?.ref ?? null,
          ocrDatos: (ocrRes?.ocr?.extraido ?? undefined) as
            | Prisma.InputJsonValue
            | undefined,
          ocrConfianza:
            ocrRes?.ocr?.confianza != null &&
            Number.isFinite(Number(ocrRes.ocr.confianza))
              ? Number(ocrRes.ocr.confianza)
              : null,
          recibidoEn: new Date(),
          validadoEn: estado === 'validado' ? new Date() : null,
          validadoPor: estado === 'validado' ? 'auto' : null,
        },
      });
      await this.evento(exp.id, 'documento_recibido', actor, {
        tipo,
        origen,
        ocr: ocrDisponible,
        ubicacion: ocrRes?.ubicacion ?? null,
        tamanoKb: Math.round(file.size / 1024),
      });
      if (estado === 'validado') {
        await this.evento(exp.id, 'requisito_validado', 'auto', { tipo });
      } else if (estado === 'observado') {
        await this.evento(exp.id, 'requisito_observado', 'auto', {
          tipo,
          motivo,
        });
      }
      const { completadoAhora } = await this.recalcularEstado(exp.id, config);
      resultados.push({ expedienteId: exp.id, tipo, estado, motivo });

      const actualizado = await prisma.mktExpediente.findUnique({
        where: { id: exp.id },
      });
      if (actualizado) {
        if (completadoAhora) void this.notificarEvento(actualizado, 'completo');
        else if (estado === 'observado')
          void this.notificarEvento(actualizado, 'observado', {
            tipo,
            motivo: motivo ?? '',
          });
        else void this.notificarEvento(actualizado, 'recibido', { tipo });
      }
    }
    return resultados;
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
            return {
              tipo,
              label: requisitoLabel(tipo),
              estado,
              motivo: estado === 'observado' ? (r?.motivo ?? null) : null,
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
    return {
      tipo,
      estado: resultados.some((r) => r.estado === 'observado')
        ? 'observado'
        : 'recibido',
      motivo: resultados.find((r) => r.estado === 'observado')?.motivo ?? null,
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
      let content;
      if (tipo === 'completo') {
        content = correoCompleto({
          nombre,
          polizaOResumen: `la póliza N° ${exp.cnpoliza}`,
        });
      } else if (tipo === 'recibido') {
        content = correoRecibido({
          nombre,
          documento: requisitoLabel(extra.tipo ?? ''),
        });
      } else {
        const link = emailValido(exp.aseguradoEmail)
          ? await this.crearEnlace(exp.aseguradoKey, [exp.id])
          : null;
        content = correoObservado({
          nombre,
          documento: requisitoLabel(extra.tipo ?? ''),
          motivo: extra.motivo || 'el documento no se pudo verificar',
          poliza: `N° ${exp.cnpoliza}`,
          enlace: link?.url ?? null,
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

  // ─── Exclusiones («No enviar correos») ─────────────────────────────────

  async crearExclusion(
    body: {
      alcance: 'asegurado' | 'poliza';
      motivo: string;
      expedienteId?: number;
      cnpoliza?: string;
      empresaId?: number;
      documento?: string;
      tipoDoc?: string;
      /** documento (asegurado) o cnpoliza (póliza), según el alcance. */
      valor?: string;
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
    });
    return x;
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
      motivo: motivo ?? null,
    });
    return upd;
  }

  async listarExclusiones(incluirInactivas = false) {
    const rows = await prisma.mktExpedienteExclusion.findMany({
      where: incluirInactivas ? {} : { activo: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map((x) => {
      const asegurado = x.aseguradoKey?.startsWith('mail:')
        ? maskEmail(x.aseguradoKey.slice(5))
        : x.aseguradoKey;
      return {
        id: x.id,
        alcance: x.alcance,
        valor: (x.alcance === 'poliza' ? x.cnpoliza : asegurado) ?? '',
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
    });
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
