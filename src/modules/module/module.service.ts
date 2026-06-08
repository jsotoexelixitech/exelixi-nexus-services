import { networkInterfaces } from 'os';
import prisma from '../../config/prisma';

export interface FlowStatusResult {
  moduloGroupId: number;
  allModulesActive: boolean;
  fullFlowUrl: string;
  modules: {
    id: number;
    nombre: string;
    orden: number;
    url: string;
    activo: boolean;
  }[];
}

export class ModuleService {
  /**
   * Retorna los módulos que la empresa del usuario tiene actualmente activos.
   * Útil para que el frontend sepa qué mostrar en el menú.
   */
  async getActiveModules(empresaId: string) {
    const active = await prisma.empresaModulo.findMany({
      where: {
        empresaId: Number(empresaId),
        activo: true,
      },
      include: {
        modulo: true,
      },
    });

    return active.map((a) => a.modulo);
  }

  /**
   * Retorna todos los módulos y sus submódulos (para administración).
   */
  async getAllModules() {
    return await prisma.modulo.findMany({
      include: {
        submodulos: true,
      },
    });
  }

  /**
   * Crea un nuevo módulo global.
   */
  async createModule(nombre: string) {
    return await prisma.modulo.create({
      data: { nombre, activo: true },
    });
  }

  /**
   * Actualiza un módulo global.
   */
  async updateModule(id: number, data: { nombre?: string; activo?: boolean }) {
    return await prisma.modulo.update({
      where: { id },
      data,
    });
  }

  /**
   * Elimina (desactiva) un módulo global.
   */
  async deleteModule(id: number) {
    return await prisma.modulo.update({
      where: { id },
      data: { activo: false },
    });
  }

  /**
   * Crea un nuevo submódulo vinculado a un módulo.
   */
  async createSubmodule(moduloId: number, nombre: string, url?: string | null) {
    const urlValue =
      url !== undefined && url !== null && url !== '' ? url : undefined;
    return await prisma.submodulo.create({
      data: {
        nombre,
        moduloId,
        activo: true,
        ...(urlValue !== undefined ? { url: urlValue } : {}),
      },
    });
  }

  /**
   * Actualiza un submódulo.
   */
  async updateSubmodule(
    id: number,
    data: { nombre?: string; activo?: boolean; url?: string | null },
  ) {
    const patch: { nombre?: string; activo?: boolean; url?: string | null } =
      {};
    if (data.nombre !== undefined) patch.nombre = data.nombre;
    if (data.activo !== undefined) patch.activo = data.activo;
    if (data.url !== undefined) {
      patch.url = data.url === '' || data.url === null ? null : data.url;
    }
    return await prisma.submodulo.update({
      where: { id },
      data: patch,
    });
  }

  /**
   * Elimina un submódulo.
   */
  async deleteSubmodule(id: number) {
    return await prisma.submodulo.update({
      where: { id },
      data: { activo: false },
    });
  }

  /**
   * IP IPv4 no interna del host (para enlaces "Red" en el panel).
   */
  getNetworkInfo(): { networkIp: string } {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === 'IPv4' && !net.internal) {
          return { networkIp: net.address };
        }
      }
    }
    return { networkIp: '' };
  }

  /**
   * Estado del flujo RCV modular (4 submódulos con URL bajo un módulo padre).
   */
  async getFlowStatus(empresaId: number): Promise<FlowStatusResult | null> {
    const candidatos = await prisma.modulo.findMany({
      where: {
        activo: true,
        submodulos: {
          some: {
            activo: true,
            url: { not: null },
          },
        },
      },
      include: {
        submodulos: {
          where: { activo: true, url: { not: null } },
          orderBy: { id: 'asc' },
        },
      },
    });

    const scored = candidatos
      .map((m) => {
        const nombre = m.nombre.toLowerCase();
        const rcvBonus =
          nombre.includes('rcv') || nombre.includes('suscripci') ? 10 : 0;
        return { modulo: m, score: m.submodulos.length + rcvBonus };
      })
      .filter((x) => x.modulo.submodulos.length > 0)
      .sort((a, b) => b.score - a.score);

    const grupo = scored[0]?.modulo;
    if (!grupo || grupo.submodulos.length === 0) {
      return null;
    }

    const subIds = grupo.submodulos.map((s) => s.id);
    const empresaSubs = await prisma.empresaSubmodulo.findMany({
      where: { empresaId, submoduloId: { in: subIds } },
    });
    const activoBySub = new Map(
      empresaSubs.map((es) => [es.submoduloId, es.activo]),
    );

    const modules = grupo.submodulos.map((s, idx) => ({
      id: s.id,
      nombre: s.nombre,
      orden: idx + 1,
      url: s.url!,
      activo: activoBySub.get(s.id) === true,
    }));

    const pagos =
      modules.find((m) => /pago/i.test(m.nombre)) ??
      modules[modules.length - 1];
    const fullFlowUrl = process.env.FULL_FLOW_URL?.trim() || pagos?.url || '';

    const expected = Math.min(4, modules.length);
    const activeCount = modules.filter((m) => m.activo).length;

    return {
      moduloGroupId: grupo.id,
      allModulesActive: activeCount >= expected && modules.length >= expected,
      fullFlowUrl,
      modules,
    };
  }
}
