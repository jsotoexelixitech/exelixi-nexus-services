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
  order: number;           // posición en el flujo (1, 2, 3, 4 …)
  submoduloId: number;
  nombre: string;
  accessUrl: string;       // URL con nexus_token ya incluido
}

interface FlowSession {
  sid: string;
  empresaId: number;
  moduloGroupId: number;   // módulo padre (ej. 7 = RCV Modular)
  slots: SubmoduloSlot[];  // submódulos activos ordenados
  current: number;         // order del módulo en curso
  history: number[];       // orders ya completados
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// ─── Almacén en memoria ───────────────────────────────────────────────────────

const SESSIONS = new Map<string, FlowSession>();
const TTL_MS   = 2 * 60 * 60 * 1000; // 2 horas

// Limpieza periódica
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [sid, s] of SESSIONS) {
    if (s.updatedAt < cutoff) SESSIONS.delete(sid);
  }
}, 5 * 60 * 1000);

function newSid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ─── Helpers Prisma ───────────────────────────────────────────────────────────

/**
 * Obtiene los submódulos ACTIVOS para una empresa en un grupo (moduloId),
 * ordenados por submoduloId ascendente (que coincide con el orden de creación).
 */
async function getActiveSlots(empresaId: number, moduloGroupId: number): Promise<SubmoduloSlot[]> {
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
    .filter(es => es.submodulo?.url)       // solo los que tienen URL configurada
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
        accessUrl: baseUrl,   // placeholder; se resuelve con buildAccessUrl
      };
    });
}

/**
 * Genera la URL de acceso con el nexus_token firmado.
 */
async function buildAccessUrl(empresaId: number, submoduloId: number, baseUrl: string): Promise<string> {
  const { generateTenantToken } = await import('../../utils/tenant-token');
  const token = generateTenantToken(empresaId, submoduloId);
  return `${baseUrl}?nexus_token=${token}`;
}

// ─── Operaciones de sesión ────────────────────────────────────────────────────

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

  const sid = newSid();
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

  logger.info(`[flow] start sid=${sid} empresa=${empresaId} modulo=${moduloGroupId} slots=${slots.length}`);

  const first = slots[0];
  return {
    sid,
    firstUrl: `${first.accessUrl}&sid=${sid}`,
    firstModule: { order: first.order, submoduloId: first.submoduloId, nombre: first.nombre },
    totalActive: slots.length,
  };
}

export function getSession(sid: string) {
  const s = SESSIONS.get(sid);
  if (!s) return null;
  s.updatedAt = Date.now();
  const cur = s.slots.find(sl => sl.order === s.current) ?? null;
  return {
    sid: s.sid,
    empresaId: s.empresaId,
    current: s.current,
    currentModule: cur ? { order: cur.order, submoduloId: cur.submoduloId, nombre: cur.nombre } : null,
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
  return { sid, savedKeys: Object.keys(patch) };
}

export function advanceSession(sid: string, fromOrder: number, patch: Record<string, unknown>) {
  const s = SESSIONS.get(sid);
  if (!s) return null;

  // Guardar datos del paso actual
  if (patch && typeof patch === 'object') {
    s.data = { ...s.data, ...patch };
  }

  // Registrar en historial
  if (!s.history.includes(fromOrder)) s.history.push(fromOrder);

  // Encontrar el siguiente slot activo después del orden actual
  const nextSlot = s.slots.find(sl => sl.order > fromOrder) ?? null;

  if (nextSlot) {
    s.current = nextSlot.order;
    s.updatedAt = Date.now();
    logger.info(`[flow] advance sid=${sid} from=${fromOrder} → next=${nextSlot.order} (${nextSlot.nombre})`);
    return {
      finished: false,
      nextUrl: `${nextSlot.accessUrl}&sid=${sid}`,
      nextModule: { order: nextSlot.order, submoduloId: nextSlot.submoduloId, nombre: nextSlot.nombre },
    };
  }

  // Flujo completado
  s.updatedAt = Date.now();
  logger.info(`[flow] finished sid=${sid} after order=${fromOrder}`);
  return { finished: true, sid };
}
