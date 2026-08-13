/**
 * product-config.service.ts
 *
 * Gestiona la configuración paramétrica de flujos por producto y empresa.
 * Si no existe config guardada en BD, retorna el default (fallback seguro).
 */

import { Prisma } from '@prisma/client';
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
  const defaults = (DEFAULT_CONFIGS[producto]?.[modulo] ?? {}) as Record<string, unknown>;
  try {
    const record = await prisma.productConfig.findUnique({
      where: { empresaId_producto_modulo: { empresaId, producto, modulo } },
    });
    if (record) {
      const stored = record.configJson as Record<string, unknown>;
      const merged = { ...defaults, ...stored };
      // Configs antiguas sin healthQuestions: heredar default funerario
      if (
        producto === 'funerario' &&
        modulo === 'emision' &&
        !Object.prototype.hasOwnProperty.call(stored, 'healthQuestions')
      ) {
        merged.healthQuestions = defaults.healthQuestions;
      }
      // Migrar legacy → healthQuestionsByCanal.default
      if (producto === 'funerario' && modulo === 'emision') {
        const by = merged.healthQuestionsByCanal;
        const legacy = merged.healthQuestions;
        if (
          (!by || typeof by !== 'object' || Array.isArray(by)) &&
          Array.isArray(legacy) &&
          legacy.length > 0
        ) {
          merged.healthQuestionsByCanal = { default: legacy };
        } else if (
          by &&
          typeof by === 'object' &&
          !Array.isArray(by) &&
          !Array.isArray((by as Record<string, unknown>).default) &&
          Array.isArray(legacy) &&
          legacy.length > 0
        ) {
          merged.healthQuestionsByCanal = {
            ...(by as Record<string, unknown>),
            default: legacy,
          };
        }
      }
      return merged;
    }
  } catch (err) {
    logger.warn(
      `[product-config] Error leyendo BD, usando default: ${(err as Error).message}`,
    );
  }
  return defaults;
}

/**
 * Guarda (upsert) la configuración de un producto+módulo para una empresa.
 * Merge superficial con lo ya guardado para no borrar claves omitidas
 * (p. ej. healthQuestions al guardar solo la pestaña General).
 */
export async function saveConfig(
  empresaId: number,
  producto: Producto,
  modulo: Modulo,
  configJson: object,
): Promise<object> {
  const incoming = (configJson ?? {}) as Record<string, unknown>;
  let existing: Record<string, unknown> = {};
  try {
    const prev = await prisma.productConfig.findUnique({
      where: { empresaId_producto_modulo: { empresaId, producto, modulo } },
    });
    if (prev?.configJson && typeof prev.configJson === 'object') {
      existing = prev.configJson as Record<string, unknown>;
    }
  } catch (err) {
    logger.warn(
      `[product-config] No se pudo leer config previa: ${(err as Error).message}`,
    );
  }

  const merged: Record<string, unknown> = { ...existing, ...incoming };

  // Funerario: no pisar preguntas con array vacío (carrera / panel sin hidratar)
  if (producto === 'funerario' && modulo === 'emision') {
    const nextHq = incoming.healthQuestions;
    const prevHq = existing.healthQuestions;
    if (
      Array.isArray(nextHq) &&
      nextHq.length === 0 &&
      Array.isArray(prevHq) &&
      prevHq.length > 0
    ) {
      merged.healthQuestions = prevHq;
      logger.warn(
        `[product-config] healthQuestions vacío ignorado; se conservan ${prevHq.length} preguntas`,
      );
    }
    const nextBy = incoming.healthQuestionsByCanal;
    const prevBy = existing.healthQuestionsByCanal;
    const nextByEmpty =
      nextBy &&
      typeof nextBy === 'object' &&
      !Array.isArray(nextBy) &&
      Object.keys(nextBy as object).length === 0;
    if (
      nextByEmpty &&
      prevBy &&
      typeof prevBy === 'object' &&
      !Array.isArray(prevBy)
    ) {
      merged.healthQuestionsByCanal = prevBy;
      logger.warn('[product-config] healthQuestionsByCanal vacío ignorado');
    } else if (
      nextBy &&
      typeof nextBy === 'object' &&
      !Array.isArray(nextBy) &&
      prevBy &&
      typeof prevBy === 'object' &&
      !Array.isArray(prevBy)
    ) {
      // Merge por canal: el integrador puede enviar solo su clave sin borrar las demás
      merged.healthQuestionsByCanal = {
        ...(prevBy as Record<string, unknown>),
        ...(nextBy as Record<string, unknown>),
      };
    }
  }

  const configJsonValue = merged as Prisma.InputJsonValue;
  const record = await prisma.productConfig.upsert({
    where: { empresaId_producto_modulo: { empresaId, producto, modulo } },
    create: { empresaId, producto, modulo, configJson: configJsonValue },
    update: { configJson: configJsonValue },
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
