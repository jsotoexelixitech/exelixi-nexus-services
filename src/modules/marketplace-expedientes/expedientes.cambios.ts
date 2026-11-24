/**
 * Fase 2 (preparada, NO conectada): monitor de cambios snapshot vs Sis2000.
 * Falta implementar `fetchPolicyCurrentData` con un endpoint de LECTURA en nest-api
 * (SELECT parametrizado). Mientras tanto el proveedor devuelve null y no se hace nada.
 * No está enganchado a la tarea nocturna.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import { areasEnAlcance } from './expedientes.domain';
import { expedientesService as svc } from './expedientes.service';

export interface PolicyCurrentData {
  tomador?: { identificacion?: string | null; nombre?: string | null } | null;
  asegurado?: { documento?: string | null; nombre?: string | null } | null;
  vehiculo?: { placa?: string | null; serialCarroceria?: string | null } | null;
  plan?: string | null;
  estadoPoliza?: string | null;
}

export interface PolicyCurrentDataProvider {
  fetchPolicyCurrentData(cnpoliza: string): Promise<PolicyCurrentData | null>;
}

/** Sin implementar contra Sis2000: no hay datos actuales, no se compara. */
export const proveedorNoImplementado: PolicyCurrentDataProvider = {
  async fetchPolicyCurrentData() {
    return null;
  },
};

export interface CambioDetectado {
  campo: string;
  anterior: string | null;
  nuevo: string | null;
}

function val(obj: unknown, path: string[]): string | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  const s = cur == null ? '' : String(cur).trim();
  return s ? s : null;
}

function norm(v: string | null): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

const CAMPOS: { campo: string; path: string[] }[] = [
  { campo: 'tomador.identificacion', path: ['tomador', 'identificacion'] },
  { campo: 'tomador.nombre', path: ['tomador', 'nombre'] },
  { campo: 'asegurado.documento', path: ['asegurado', 'documento'] },
  { campo: 'asegurado.nombre', path: ['asegurado', 'nombre'] },
  { campo: 'vehiculo.placa', path: ['vehiculo', 'placa'] },
  {
    campo: 'vehiculo.serialCarroceria',
    path: ['vehiculo', 'serialCarroceria'],
  },
  { campo: 'plan', path: ['plan'] },
  { campo: 'estadoPoliza', path: ['estadoPoliza'] },
];

/** Solo compara campos presentes en ambos lados (un null no es un cambio). */
export function compararSnapshot(
  snapshot: unknown,
  actual: PolicyCurrentData,
): CambioDetectado[] {
  const out: CambioDetectado[] = [];
  for (const { campo, path } of CAMPOS) {
    const a = val(snapshot, path);
    const b = val(actual, path);
    if (a && b && norm(a) !== norm(b))
      out.push({ campo, anterior: a, nuevo: b });
  }
  return out;
}

/**
 * Compara cada expediente en alcance contra los datos actuales. Si cambió:
 * evento `cambio_detectado` y `cambiosDetectados=true` (vuelve a revisión).
 */
export async function revisarCambios(
  proveedor: PolicyCurrentDataProvider = proveedorNoImplementado,
): Promise<{ revisados: number; conCambios: number; sinDatos: number }> {
  const config = await svc.getConfig();
  const exps = await prisma.mktExpediente.findMany({
    where: { area: { in: areasEnAlcance(config.alcance) } },
  });
  let conCambios = 0;
  let sinDatos = 0;
  for (const e of exps) {
    const actual = await proveedor.fetchPolicyCurrentData(e.cnpoliza);
    if (!actual) {
      sinDatos++;
      continue;
    }
    const cambios = compararSnapshot(e.snapshot, actual);
    if (!cambios.length) continue;
    conCambios++;
    await prisma.mktExpediente.update({
      where: { id: e.id },
      data: { cambiosDetectados: true },
    });
    await svc.evento(e.id, 'cambio_detectado', 'sistema', {
      cambios: cambios.map((c) => ({ ...c, origen: 'sis2000' })),
    } as unknown as Record<string, unknown> & Prisma.InputJsonObject);
  }
  return { revisados: exps.length, conCambios, sinDatos };
}
