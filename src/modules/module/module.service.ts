import prisma from '../../config/prisma';

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
}
