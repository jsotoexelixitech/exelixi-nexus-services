/**
 * flow.service.ts
 *
 * Gestiona el flujo secuencial entre módulos (OCR → Formulario → Emisión → Pagos).
 * Usa sesiones en memoria + consulta Prisma para saber qué submódulos están activos
 * para cada empresa. Sin base de datos propia: el estado de sesión vive en proceso.
 */

import prisma from '../../config/prisma';
import logger from '../../utils/logger';

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
      const baseUrl = sub.url!.replace(/\/$/, '');
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

/**
 * Genera la URL de acceso con el nexus_token firmado.
 */
async function buildAccessUrl(
  empresaId: number,
  submoduloId: number,
  baseUrl: string,
  metadata?: any,
): Promise<string> {
  const { generateSsoToken, generateTenantToken } =
    await import('../../utils/tenant-token');
  const token = metadata
    ? generateSsoToken(empresaId, submoduloId, metadata)
    : generateTenantToken(empresaId, submoduloId);
  // Query-aware: respeta un ?product=... ya presente en la URL del submódulo.
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}nexus_token=${token}`;
}

// ─── Operaciones de sesión ────────────────────────────────────────────────────

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
    select: { id: true, moduloId: true },
  });

  if (!submodulo) {
    return { error: 'Submódulo no encontrado.' };
  }

  const moduloGroupId = submodulo.moduloId;
  const rawSlots = await getActiveSlots(empresaId, moduloGroupId);

  // Si solo hay 1 submódulo activo, no hay cadena que armar
  if (rawSlots.length <= 1) {
    return {
      error:
        'Solo hay un submódulo activo en este grupo; no se requiere encadenamiento.',
    };
  }

  // Solo el primer slot puede iniciar el flujo automático
  if (rawSlots[0].submoduloId !== submoduloId) {
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
    data: metadata ? { metadata } : {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  SESSIONS.set(sid, session);

  logger.info(
    `[flow] auto-start sid=${sid} empresa=${empresaId} desde token submodulo=${submoduloId} slots=${slots.length}`,
  );

  const first = slots[0];
  return {
    sid,
    firstUrl: `${first.accessUrl}&sid=${sid}`,
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

export function getSession(sid: string) {
  const s = SESSIONS.get(sid);
  if (!s) return null;
  s.updatedAt = Date.now();
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

export function saveSession(sid: string, patch: Record<string, unknown>) {
  const s = SESSIONS.get(sid);
  if (!s) return null;
  s.data = { ...s.data, ...patch };
  s.updatedAt = Date.now();

  // Sincronizar en background (no esperamos)
  syncSessionToDb(sid).catch((e) =>
    logger.error(`Error sync DB: ${e.message}`),
  );

  return { sid, savedKeys: Object.keys(patch) };
}

export function advanceSession(
  sid: string,
  fromOrder: number,
  patch: Record<string, unknown>,
) {
  const s = SESSIONS.get(sid);
  if (!s) return null;

  // Guardar datos del paso actual
  if (patch && typeof patch === 'object') {
    s.data = { ...s.data, ...patch };
  }

  // Registrar en historial
  if (!s.history.includes(fromOrder)) s.history.push(fromOrder);

  // Encontrar el siguiente slot activo después del orden actual
  const nextSlot = s.slots.find((sl) => sl.order > fromOrder) ?? null;

  if (nextSlot) {
    s.current = nextSlot.order;
    s.updatedAt = Date.now();
    logger.info(
      `[flow] advance sid=${sid} from=${fromOrder} → next=${nextSlot.order} (${nextSlot.nombre})`,
    );
    return {
      finished: false,
      nextUrl: `${nextSlot.accessUrl}&sid=${sid}`,
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

// ─── Sincronización a Base de Datos (Persistencia Real) ───────────────────────

async function syncSessionToDb(sid: string) {
  const s = SESSIONS.get(sid);
  if (!s) return;

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
      const monto = Number(data.quote?.mprima || data.otpAmount || 0);
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
