/**
 * product-config.service.ts
 *
 * Gestiona la configuración paramétrica de flujos por producto y empresa.
 * Si no existe config guardada en BD, retorna el default (fallback seguro).
 */

import prisma from '../../config/prisma';
import {
  DEFAULT_CONFIGS,
  type Producto,
  type Modulo,
} from './product-config.defaults';
import logger from '../../utils/logger';

/**
 * Obtiene la config activa para un producto+módulo de una empresa.
 * Si no existe en BD, retorna el default hardcoded.
 */
export async function getConfig(
  empresaId: number,
  producto: Producto,
  modulo: Modulo,
): Promise<object> {
  try {
    const record = await prisma.productConfig.findUnique({
      where: { empresaId_producto_modulo: { empresaId, producto, modulo } },
    });
    if (record) return record.configJson as object;
  } catch (err) {
    logger.warn(
      `[product-config] Error leyendo BD, usando default: ${(err as Error).message}`,
    );
  }
  return DEFAULT_CONFIGS[producto]?.[modulo] ?? {};
}

/**
 * Guarda (upsert) la configuración de un producto+módulo para una empresa.
 */
export async function saveConfig(
  empresaId: number,
  producto: Producto,
  modulo: Modulo,
  configJson: object,
): Promise<object> {
  const record = await prisma.productConfig.upsert({
    where: { empresaId_producto_modulo: { empresaId, producto, modulo } },
    create: { empresaId, producto, modulo, configJson },
    update: { configJson },
  });
  logger.info(
    `[product-config] Config guardada: empresa=${empresaId} producto=${producto} modulo=${modulo}`,
  );
  return record.configJson as object;
}

/**
 * Resetea la config a los valores por defecto eliminando el registro personalizado.
 */
export async function resetConfig(
  empresaId: number,
  producto: Producto,
  modulo: Modulo,
): Promise<object> {
  await prisma.productConfig.deleteMany({
    where: { empresaId, producto, modulo },
  });
  logger.info(
    `[product-config] Config reseteada a default: empresa=${empresaId} producto=${producto} modulo=${modulo}`,
  );
  return DEFAULT_CONFIGS[producto]?.[modulo] ?? {};
}
