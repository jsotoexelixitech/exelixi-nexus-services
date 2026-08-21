/**
 * flow.service.ts
 *
 * Gestiona el flujo secuencial entre módulos (OCR → Formulario → Emisión → Pagos).
 * Usa sesiones en memoria + consulta Prisma para saber qué submódulos están activos
 * para cada empresa. Sin base de datos propia: el estado de sesión vive en proceso.
 */

import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import {
  appendExelixiFlowToUrl,
  appendProductToUrl,
  resolveFlowProduct,
  type FlowProduct,
} from '../../utils/flow-product';

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface SubmoduloSlot {
  order: number; // posición en el flujo (1, 2, 3, 4 …)
  submoduloId: number;
  nombre: string;
  accessUrl: string; // URL con nexus_token ya incluido
}

interface FlowSession {
  sid: string;
  empresaId: number;
  moduloGroupId: number; // módulo padre (ej. 7 = RCV Modular)
  slots: SubmoduloSlot[]; // submódulos activos ordenados
  current: number; // order del módulo en curso
  history: number[]; // orders ya completados
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface FlowMeta {
  moduloGroupId: number;
  current: number;
  history: number[];
}

// ─── Almacén en memoria ───────────────────────────────────────────────────────

const SESSIONS = new Map<string, FlowSession>();
const TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

// Limpieza periódica
setInterval(
  () => {
    const cutoff = Date.now() - TTL_MS;
    for (const [sid, s] of SESSIONS) {
      if (s.updatedAt < cutoff) SESSIONS.delete(sid);
    }
  },
  5 * 60 * 1000,
);

// ─── Helpers Prisma ───────────────────────────────────────────────────────────

async function createCotizacion(empresaId: number): Promise<string> {
  const cot = await prisma.cotizacion.create({
    data: {
      empresaId,
      jsonData: {},
    },
  });
  return String(cot.id);
}

// ─── Helpers Prisma ───────────────────────────────────────────────────────────

/**
 * Obtiene los submódulos ACTIVOS para una empresa en un grupo (moduloId),
 * ordenados por submoduloId ascendente (que coincide con el orden de creación).
 */
async function getActiveSlots(
  empresaId: number,
  moduloGroupId: number,
): Promise<SubmoduloSlot[]> {
  const empresaSubmodulos = await prisma.empresaSubmodulo.findMany({
    where: {
      empresaId,
      activo: true,
      submodulo: {
        moduloId: moduloGroupId,
        activo: true,
      },
    },
    include: {
      submodulo: {
        select: { id: true, nombre: true, url: true },
      },
    },
    orderBy: { submoduloId: 'asc' },
  });

  return empresaSubmodulos
    .filter((es) => es.submodulo?.url) // solo los que tienen URL configurada
    .map((es, idx) => {
      const sub = es.submodulo!;
      // Construye accessUrl con el token ya firmado (re-usa la lógica del access module)
      const baseUrl = sub.url!;
      // El token lo tenemos que generar; reutilizamos el import dinámico para evitar
      // dependencia circular. Lo generamos aquí mismo.
      return {
        order: idx + 1,
        submoduloId: sub.id,
        nombre: sub.nombre,
        accessUrl: baseUrl, // placeholder; se resuelve con buildAccessUrl
      };
    });
}

/** Normaliza URL pública para comparar entradas OCR (17 / 33 / 37 → mismo /ocr/). */
function normalizeModulePublicUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.origin.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, '');
  }
}

function isOcrEntrySubmodulo(nombre: string, url: string | null): boolean {
  if (nombre.toLowerCase().includes('ocr')) return true;
  if (!url) return false;
  try {
    return /\/ocr(\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function isChainEntrySubmodulo(
  tokenSubmoduloId: number,
  tokenUrl: string | null,
  rawSlots: SubmoduloSlot[],
): boolean {
  if (rawSlots.length === 0) return false;
  if (rawSlots[0].submoduloId === tokenSubmoduloId) return true;
  if (!tokenUrl) return false;
  return (
    normalizeModulePublicUrl(tokenUrl) ===
    normalizeModulePublicUrl(rawSlots[0].accessUrl)
  );
}

/**
 * Si el token apunta a un OCR huérfano (ej. sub 33 con solo 1 activo en módulo 7),
 * busca otra cadena RCV de la empresa con la misma URL de entrada (prioriza módulo 14 QA).
 */
async function findRcvChainForEntryUrl(
  empresaId: number,
  entryUrl: string,
): Promise<{ moduloGroupId: number; rawSlots: SubmoduloSlot[] } | null> {
  const target = normalizeModulePublicUrl(entryUrl);

  const rows = await prisma.empresaSubmodulo.findMany({
    where: {
      empresaId,
      activo: true,
      submodulo: { activo: true, url: { not: null } },
    },
    include: {
      submodulo: {
        select: { id: true, nombre: true, url: true, moduloId: true },
      },
    },
    orderBy: { submoduloId: 'asc' },
  });

  const byModulo = new Map<number, SubmoduloSlot[]>();
  for (const row of rows) {
    const sub = row.submodulo!;
    const list = byModulo.get(sub.moduloId) ?? [];
    list.push({
      order: list.length + 1,
      submoduloId: sub.id,
      nombre: sub.nombre,
      accessUrl: sub.url!,
    });
    byModulo.set(sub.moduloId, list);
  }

  let best: {
    moduloGroupId: number;
    rawSlots: SubmoduloSlot[];
    score: number;
  } | null = null;

  for (const [moduloGroupId, slots] of byModulo) {
    if (slots.length < 2) continue;
    if (normalizeModulePublicUrl(slots[0].accessUrl) !== target) continue;

    const score = (moduloGroupId === 14 ? 1000 : 0) + slots.length;
    if (!best || score > best.score) {
      best = { moduloGroupId, rawSlots: slots, score };
    }
  }

  return best
    ? { moduloGroupId: best.moduloGroupId, rawSlots: best.rawSlots }
    : null;
}

async function resolveFlowChainFromToken(
  empresaId: number,
  submodulo: {
    id: number;
    moduloId: number;
    nombre: string;
    url: string | null;
  },
): Promise<{ moduloGroupId: number; rawSlots: SubmoduloSlot[] }> {
  const moduloGroupId = submodulo.moduloId;
  const rawSlots = await getActiveSlots(empresaId, moduloGroupId);

  if (rawSlots.length >= 2) {
    return { moduloGroupId, rawSlots };
  }

  if (submodulo.url && isOcrEntrySubmodulo(submodulo.nombre, submodulo.url)) {
    const fallback = await findRcvChainForEntryUrl(empresaId, submodulo.url);
    if (fallback) {
      logger.info(
        `[flow] chain-fallback empresa=${empresaId} tokenSub=${submodulo.id} group=${moduloGroupId} -> group=${fallback.moduloGroupId} slots=${fallback.rawSlots.length}`,
      );
      return fallback;
    }
  }

  return { moduloGroupId, rawSlots };
}

/**
 * Genera la URL de acceso con el nexus_token firmado.
 */
async function buildAccessUrl(
  empresaId: number,
  submoduloId: number,
  baseUrl: string,
  metadata?: any,
): Promise<string> {
  const {
    generateSsoToken,
    generateTenantToken,
    buildAccessUrl: buildUrl,
  } = await import('../../utils/tenant-token');
  const token = metadata
    ? generateSsoToken(empresaId, submoduloId, metadata)
    : generateTenantToken(empresaId, submoduloId);
  return buildUrl(baseUrl, token);
}

/** Quita nexus_token de una URL de submódulo para regenerar acceso fresco. */
function stripNexusTokenFromUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('nexus_token');
    const qs = u.searchParams.toString();
    return `${u.origin}${u.pathname}${qs ? `?${qs}` : ''}`;
  } catch {
    return url.replace(/([?&])nexus_token=[^&]*&?/g, '$1').replace(/[?&]$/, '');
  }
}

function resolveFlowMetadata(data: Record<string, unknown>): unknown {
  if (data.metadata && typeof data.metadata === 'object') {
    return data.metadata;
  }
  return undefined;
}

type FlowDocSlot = {
  status?: string;
  progress?: number;
  file?: { url?: string };
  ocr?: unknown;
};

function hasProcessedDocuments(documents: unknown): boolean {
  if (!documents || typeof documents !== 'object') return false;
  return Object.values(documents as Record<string, FlowDocSlot>).some(
    (d) => d?.status === 'done',
  );
}

/** Evita que formulario/emisión/pagos borren el expediente OCR al hacer advance/save. */
function mergeFlowSessionData(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing, ...patch };
  if (
    patch.documents &&
    hasProcessedDocuments(existing.documents) &&
    !hasProcessedDocuments(patch.documents)
  ) {
    merged.documents = existing.documents;
  }
  return merged;
}

async function enrichDocumentsFromOcrTable(
  cotizacionId: number,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (hasProcessedDocuments(data.documents)) return data;

  const rows = await prisma.ocr.findMany({ where: { cotizacionId } });
  if (rows.length === 0) return data;

  const documents: Record<string, FlowDocSlot> = {
    ...(typeof data.documents === 'object' && data.documents
      ? (data.documents as Record<string, FlowDocSlot>)
      : {}),
  };

  for (const row of rows) {
    const key = String(row.tipoDocumento ?? '').trim();
    if (!key || !row.rutaDocumento) continue;
    const current = documents[key] ?? { status: 'idle', progress: 0 };
    if (current.status === 'done') continue;
    documents[key] = {
      ...current,
      status: 'done',
      progress: 100,
      file: { url: row.rutaDocumento },
      ocr:
        row.jsonData && typeof row.jsonData === 'object'
          ? row.jsonData
          : current.ocr,
    };
  }

  if (!hasProcessedDocuments(documents)) return data;

  return {
    ...data,
    documents,
    ocrDone: data.ocrDone ?? true,
  };
}

/** URL de navegación con token recién emitido (evita 401 tras pausas largas). */
async function buildFreshSlotUrl(
  empresaId: number,
  slot: SubmoduloSlot,
  sessionData: Record<string, unknown>,
  sid: string,
): Promise<string> {
  const base = stripNexusTokenFromUrl(slot.accessUrl);
  const metadata = resolveFlowMetadata(sessionData);
  const withToken = await buildAccessUrl(
    empresaId,
    slot.submoduloId,
    base,
    metadata,
  );
  const product = (sessionData.product as FlowProduct) || 'rcv';
  return appendExelixiFlowToUrl(
    appendProductToUrl(`${withToken}&sid=${sid}`, product),
    Boolean(sessionData.exelixiCatalogFlow),
  );
}

// ─── Operaciones de sesión ────────────────────────────────────────────────────

function touchFlowMeta(s: FlowSession): void {
  s.data._flowMeta = {
    moduloGroupId: s.moduloGroupId,
    current: s.current,
    history: s.history,
  } satisfies FlowMeta;
}

function formatSessionResponse(s: FlowSession) {
  const cur = s.slots.find((sl) => sl.order === s.current) ?? null;
  return {
    sid: s.sid,
    empresaId: s.empresaId,
    current: s.current,
    currentModule: cur
      ? { order: cur.order, submoduloId: cur.submoduloId, nombre: cur.nombre }
      : null,
    history: s.history,
    data: s.data,
    totalActive: s.slots.length,
  };
}

export async function inferModuloGroupId(
  empresaId: number,
): Promise<number | null> {
  const rows = await prisma.empresaSubmodulo.findMany({
    where: {
      empresaId,
      activo: true,
      submodulo: { activo: true },
    },
    include: { submodulo: { select: { moduloId: true } } },
  });
  const counts = new Map<number, number>();
  for (const row of rows) {
    const moduloId = row.submodulo.moduloId;
    counts.set(moduloId, (counts.get(moduloId) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [moduloId, count] of counts) {
    if (count > bestCount) {
      best = moduloId;
      bestCount = count;
    }
  }
  return best;
}

async function restoreSessionFromDb(sid: string): Promise<FlowSession | null> {
  const cotizacionId = Number(sid);
  if (isNaN(cotizacionId)) return null;

  const cot = await prisma.cotizacion.findUnique({
    where: { id: cotizacionId },
  });
  if (!cot) return null;

  const data = (
    cot.jsonData && typeof cot.jsonData === 'object' ? cot.jsonData : {}
  ) as Record<string, unknown>;

  const enrichedData = await enrichDocumentsFromOcrTable(cotizacionId, data);

  const stored = data._flowMeta as Partial<FlowMeta> | undefined;
  let moduloGroupId = stored?.moduloGroupId;
  if (!moduloGroupId) {
    moduloGroupId = (await inferModuloGroupId(cot.empresaId)) ?? undefined;
  }
  if (!moduloGroupId) return null;

  const rawSlots = await getActiveSlots(cot.empresaId, moduloGroupId);
  if (rawSlots.length === 0) return null;

  const metadata = resolveFlowMetadata(data);
  const slots: SubmoduloSlot[] = await Promise.all(
    rawSlots.map(async (slot) => ({
      ...slot,
      accessUrl: await buildAccessUrl(
        cot.empresaId,
        slot.submoduloId,
        slot.accessUrl,
        metadata,
      ),
    })),
  );

  const session: FlowSession = {
    sid,
    empresaId: cot.empresaId,
    moduloGroupId,
    slots,
    current: stored?.current ?? slots[0].order,
    history: Array.isArray(stored?.history) ? stored.history : [],
    data: enrichedData,
    createdAt: cot.createdAt.getTime(),
    updatedAt: Date.now(),
  };
  touchFlowMeta(session);
  logger.info(
    `[flow] restored sid=${sid} from DB empresa=${cot.empresaId} modulo=${moduloGroupId}`,
  );
  return session;
}

async function loadSession(sid: string): Promise<FlowSession | null> {
  const cotizacionId = Number(sid);
  const cached = SESSIONS.get(sid);
  if (cached) {
    cached.updatedAt = Date.now();
    if (!hasProcessedDocuments(cached.data.documents) && !isNaN(cotizacionId)) {
      cached.data = await enrichDocumentsFromOcrTable(
        cotizacionId,
        cached.data,
      );
    }
    return cached;
  }

  const restored = await restoreSessionFromDb(sid);
  if (!restored) return null;

  SESSIONS.set(sid, restored);
  return restored;
}

/** SSO con checkout embebido: Pagos puede abrirse sin pasar por OCR. */
function isCheckoutSsoMetadata(metadata?: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const checkout = (metadata as Record<string, unknown>).checkout;
  if (!checkout || typeof checkout !== 'object') return false;
  const totalVes = Number((checkout as Record<string, unknown>).totalVes);
  return Number.isFinite(totalVes) && totalVes > 0;
}

/**
 * Inicia el flujo automáticamente a partir de un nexus_token existente.
 *
 * Decodifica el token (sin re-verificar firma, ya fue verificada por nexusAuth),
 * busca a qué grupo de módulos pertenece el submódulo, y arranca el flujo
 * solo si ese submódulo es el PRIMERO activo del grupo (el punto de entrada).
 *
 * Si el submódulo no es el primero → devuelve error (no es punto de entrada).
 * Si la empresa solo tiene ese submódulo activo → también devuelve error
 * (flujo de 1 solo módulo no tiene sentido encadenar).
 */
export async function startFlowFromToken(
  empresaId: number,
  submoduloId: number,
  metadata?: any,
): Promise<
  | { error: string }
  | { standalone: true; checkoutMode: true; totalActive: number }
  | {
      sid: string;
      firstUrl: string;
      totalActive: number;
      alreadyChained: boolean;
    }
> {
  // Buscar el grupo al que pertenece este submódulo
  const submodulo = await prisma.submodulo.findUnique({
    where: { id: submoduloId },
    select: {
      id: true,
      moduloId: true,
      nombre: true,
      url: true,
      modulo: { select: { nombre: true } },
    },
  });

  if (!submodulo) {
    return { error: 'Submódulo no encontrado.' };
  }

  const flowProduct = resolveFlowProduct({
    submoduloUrl: submodulo.url,
    submoduloNombre: submodulo.nombre,
    moduloNombre: submodulo.modulo?.nombre,
  });

  const { moduloGroupId, rawSlots } = await resolveFlowChainFromToken(
    empresaId,
    submodulo,
  );

  // Si solo hay 1 submódulo activo, no hay cadena que armar
  if (rawSlots.length <= 1) {
    return {
      error:
        'Solo hay un submódulo activo en este grupo; no se requiere encadenamiento.',
    };
  }

  // Checkout SSO embebido: Pagos (u otro submódulo) es entrada válida con metadata.checkout
  if (
    isCheckoutSsoMetadata(metadata) &&
    !isChainEntrySubmodulo(submoduloId, submodulo.url, rawSlots)
  ) {
    logger.info(
      `[flow] checkout-standalone empresa=${empresaId} submodulo=${submoduloId} (no OCR chain)`,
    );
    return {
      standalone: true,
      checkoutMode: true,
      totalActive: rawSlots.length,
    };
  }

  // Solo el primer slot puede iniciar el flujo (o un OCR alterno con la misma URL)
  if (!isChainEntrySubmodulo(submoduloId, submodulo.url, rawSlots)) {
    return {
      error: `Este submódulo no es el punto de entrada del flujo. El primero es ${rawSlots[0].nombre}.`,
    };
  }

  const slots: SubmoduloSlot[] = await Promise.all(
    rawSlots.map(async (s) => ({
      ...s,
      accessUrl: await buildAccessUrl(
        empresaId,
        s.submoduloId,
        s.accessUrl,
        metadata,
      ),
    })),
  );

  const sid = await createCotizacion(empresaId);
  const session: FlowSession = {
    sid,
    empresaId,
    moduloGroupId,
    slots,
    current: slots[0].order,
    history: [],
    data: {
      product: flowProduct,
      ...(metadata ? { metadata } : {}),
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  SESSIONS.set(sid, session);
  touchFlowMeta(session);

  logger.info(
    `[flow] auto-start sid=${sid} empresa=${empresaId} desde token submodulo=${submoduloId} product=${flowProduct} slots=${slots.length}`,
  );

  const first = slots[0];
  return {
    sid,
    firstUrl: appendProductToUrl(`${first.accessUrl}&sid=${sid}`, flowProduct),
    totalActive: slots.length,
    alreadyChained: true,
  };
}

export async function startFlow(empresaId: number, moduloGroupId: number) {
  const rawSlots = await getActiveSlots(empresaId, moduloGroupId);

  if (rawSlots.length === 0) {
    return { error: 'No hay submódulos activos para iniciar el flujo.' };
  }

  // Resolver las URLs con tokens
  const slots: SubmoduloSlot[] = await Promise.all(
    rawSlots.map(async (s) => ({
      ...s,
      accessUrl: await buildAccessUrl(empresaId, s.submoduloId, s.accessUrl),
    })),
  );

  const sid = await createCotizacion(empresaId);
  const session: FlowSession = {
    sid,
    empresaId,
    moduloGroupId,
    slots,
    current: slots[0].order,
    history: [],
    data: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  SESSIONS.set(sid, session);
  touchFlowMeta(session);

  logger.info(
    `[flow] start sid=${sid} empresa=${empresaId} modulo=${moduloGroupId} slots=${slots.length}`,
  );

  const first = slots[0];
  return {
    sid,
    firstUrl: `${first.accessUrl}&sid=${sid}`,
    firstModule: {
      order: first.order,
      submoduloId: first.submoduloId,
      nombre: first.nombre,
    },
    totalActive: slots.length,
  };
}

/**
 * Crea una sesión de checkout directo en Pagos (u otro submódulo final).
 * El sistema externo envía checkout + reglas; el cliente abre checkoutUrl.
 */
export async function startCheckoutLink(
  empresaId: number,
  moduloGroupId: number,
  patch: Record<string, unknown>,
): Promise<
  | { error: string }
  | {
      sid: string;
      checkoutUrl: string;
      pagosModule: { order: number; nombre: string };
    }
> {
  const checkout = patch.checkout as Record<string, unknown> | undefined;
  const totalVes = Number(checkout?.totalVes);
  if (!checkout || !Number.isFinite(totalVes) || totalVes <= 0) {
    return {
      error: 'Se requiere checkout.totalVes positivo.',
    };
  }

  const normalized: Record<string, unknown> = { ...patch };
  if (normalized.rules && !normalized.checkoutRules) {
    normalized.checkoutRules = normalized.rules;
    delete normalized.rules;
  }
  if (normalized.payer && !normalized.checkoutPayer) {
    normalized.checkoutPayer = normalized.payer;
    delete normalized.payer;
  }
  if (normalized.payload && !normalized.checkoutPayload) {
    normalized.checkoutPayload = normalized.payload;
    delete normalized.payload;
  }

  const rawSlots = await getActiveSlots(empresaId, moduloGroupId);
  if (rawSlots.length === 0) {
    return { error: 'No hay submódulos activos para esta empresa.' };
  }

  const pagosRaw =
    rawSlots.find((s) => /pago/i.test(s.nombre)) ??
    rawSlots[rawSlots.length - 1];

  const slots: SubmoduloSlot[] = await Promise.all(
    rawSlots.map(async (s) => ({
      ...s,
      accessUrl: await buildAccessUrl(empresaId, s.submoduloId, s.accessUrl),
    })),
  );

  const pagosSlot = slots.find((s) => s.submoduloId === pagosRaw.submoduloId);
  if (!pagosSlot) {
    return { error: 'No se encontró el submódulo de Pagos en el grupo.' };
  }

  const productHint =
    (normalized.product as FlowProduct | undefined) ??
    resolveFlowProduct({ submoduloNombre: pagosSlot.nombre });

  const sid = await createCotizacion(empresaId);
  const session: FlowSession = {
    sid,
    empresaId,
    moduloGroupId,
    slots,
    current: pagosSlot.order,
    history: [],
    data: {
      ...normalized,
      product: productHint,
      quoteState: normalized.quoteState ?? 'ready',
      quote:
        normalized.quote ??
        ({
          mprima: totalVes,
          mprimaext: Number(checkout.totalUsd) || totalVes,
          ptasa: Number(checkout.exchangeRate) || 1,
        } as Record<string, unknown>),
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  SESSIONS.set(sid, session);
  touchFlowMeta(session);
  await syncSessionToDb(sid);

  logger.info(
    `[flow] checkout-link sid=${sid} empresa=${empresaId} pagos=${pagosSlot.nombre} totalVes=${totalVes}`,
  );

  const base = appendProductToUrl(
    `${pagosSlot.accessUrl}&sid=${sid}`,
    productHint,
  );
  const checkoutUrl = base.includes('wizardStep=')
    ? base
    : `${base}${base.includes('?') ? '&' : '?'}wizardStep=5`;

  return {
    sid,
    checkoutUrl,
    pagosModule: { order: pagosSlot.order, nombre: pagosSlot.nombre },
  };
}

export async function getSession(sid: string) {
  const s = await loadSession(sid);
  if (!s) return null;
  return formatSessionResponse(s);
}

export async function saveSession(sid: string, patch: Record<string, unknown>) {
  const s = await loadSession(sid);
  if (!s) return null;
  s.data = mergeFlowSessionData(s.data, patch);
  s.updatedAt = Date.now();
  touchFlowMeta(s);

  // Sincronizar en background (no esperamos)
  syncSessionToDb(sid).catch((e) =>
    logger.error(`Error sync DB: ${e.message}`),
  );

  return { sid, savedKeys: Object.keys(patch) };
}

export async function advanceSession(
  sid: string,
  fromOrder: number,
  patch: Record<string, unknown>,
) {
  const s = await loadSession(sid);
  if (!s) return null;

  // Guardar datos del paso actual
  if (patch && typeof patch === 'object') {
    s.data = mergeFlowSessionData(s.data, patch);
  }

  // Registrar en historial
  if (!s.history.includes(fromOrder)) s.history.push(fromOrder);
  touchFlowMeta(s);

  // Encontrar el siguiente slot activo después del orden actual
  const nextSlot = s.slots.find((sl) => sl.order > fromOrder) ?? null;

  if (nextSlot) {
    s.current = nextSlot.order;
    s.updatedAt = Date.now();
    logger.info(
      `[flow] advance sid=${sid} from=${fromOrder} → next=${nextSlot.order} (${nextSlot.nombre})`,
    );
    const nextUrl = await buildFreshSlotUrl(s.empresaId, nextSlot, s.data, sid);
    return {
      finished: false,
      nextUrl,
      nextModule: {
        order: nextSlot.order,
        submoduloId: nextSlot.submoduloId,
        nombre: nextSlot.nombre,
      },
    };
  }

  // Flujo completado
  s.updatedAt = Date.now();
  logger.info(`[flow] finished sid=${sid} after order=${fromOrder}`);
  syncSessionToDb(sid).catch((e) =>
    logger.error(`Error sync DB: ${e.message}`),
  );
  return { finished: true, sid };
}

/**
 * Navega a un módulo del flujo (adelante o atrás) guardando el estado actual.
 * No altera el historial de completados; solo cambia `current`.
 */
export async function navigateSession(
  sid: string,
  toOrder: number,
  patch: Record<string, unknown>,
) {
  const s = await loadSession(sid);
  if (!s) return null;

  if (patch && typeof patch === 'object') {
    s.data = mergeFlowSessionData(s.data, patch);
  }

  const slot = s.slots.find((sl) => sl.order === toOrder);
  if (!slot) {
    return {
      error: `Módulo con orden ${toOrder} no está activo en esta sesión.`,
    };
  }

  s.current = toOrder;
  s.updatedAt = Date.now();
  touchFlowMeta(s);

  logger.info(`[flow] navigate sid=${sid} → order=${toOrder} (${slot.nombre})`);

  syncSessionToDb(sid).catch((e) =>
    logger.error(`Error sync DB: ${e.message}`),
  );

  const url = await buildFreshSlotUrl(s.empresaId, slot, s.data, sid);

  return {
    url,
    module: {
      order: slot.order,
      submoduloId: slot.submoduloId,
      nombre: slot.nombre,
    },
  };
}

// ─── Sincronización a Base de Datos (Persistencia Real) ───────────────────────

async function syncSessionToDb(sid: string) {
  const s = SESSIONS.get(sid);
  if (!s) return;
  touchFlowMeta(s);

  const cotizacionId = Number(sid);
  if (isNaN(cotizacionId)) return; // Prevención si alguien inyectó string inválido

  const empresaId = s.empresaId;
  const data = s.data as Record<string, any>;

  let estado = 'borrador';
  if (data.policy?.number) estado = 'emitida';
  else if (data.paymentVerified) estado = 'pagada';
  else if (data.ocrDone) estado = 'documentos_validados';

  // 1. Guardar estado del flujo en Cotizacion
  await prisma.cotizacion.update({
    where: { id: cotizacionId },
    data: { jsonData: data, estado },
  });

  // 2. Extraer y guardar documentos (OCR)
  if (data.documents) {
    for (const [docType, docData] of Object.entries(data.documents) as [
      string,
      any,
    ][]) {
      if (docData?.file?.url) {
        const existing = await prisma.ocr.findFirst({
          where: { cotizacionId, tipoDocumento: docType },
        });
        if (!existing) {
          await prisma.ocr.create({
            data: {
              empresaId,
              cotizacionId,
              tipoDocumento: docType,
              rutaDocumento: docData.file.url,
              jsonData: docData.extractedData || {},
            },
          });
        }
      }
    }
  }

  // 3. Extraer y guardar Pagos
  if (data.paymentVerified && data.paymentMethod) {
    const existPago = await prisma.pago.findFirst({
      where: { cotizacionId },
    });
    if (!existPago) {
      let metodo = await prisma.pagoMetodo.findFirst();
      if (!metodo) {
        metodo = await prisma.pagoMetodo.create({ data: { nombre: 'SyPago' } });
      }
      const monto = Number(
        data.checkout?.totalVes ?? data.quote?.mprima ?? data.otpAmount ?? 0,
      );
      const ref =
        data.paymentReference ||
        data.otpResult?.transaction_id ||
        `REF-${cotizacionId}`;

      await prisma.pago.create({
        data: {
          empresaId,
          cotizacionId,
          metodoId: metodo.id,
          referenciaBanco: String(ref),
          monto,
          moneda: 'VES',
          estado: 'aprobado',
          fechaPago: new Date(),
        },
      });
    }
  }

  // 4. Extraer y guardar Emisión
  if (data.policy?.number) {
    const existEmision = await prisma.emision.findFirst({
      where: { cotizacionId },
    });
    if (!existEmision) {
      const pago = await prisma.pago.findFirst({ where: { cotizacionId } });
      await prisma.emision.create({
        data: {
          empresaId,
          cotizacionId,
          pagoId: pago?.id,
          polizaNumero: data.policy.number,
          estado: 'emitida',
          jsonData: data.policy,
        },
      });
    }
  }
}
