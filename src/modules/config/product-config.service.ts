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

function cloneConfig(obj: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
}

function isCanalMap(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function asQuestionList(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

/**
 * Las preguntas guardadas ganan: no reinyectar el catálogo de fábrica
 * (eso hacía reaparecer una pregunta recién eliminada).
 */
function overlayFuneralHealthFromStored(
  merged: Record<string, unknown>,
  stored: Record<string, unknown>,
): void {
  const storedBy = isCanalMap(stored.healthQuestionsByCanal)
    ? { ...stored.healthQuestionsByCanal }
    : null;
  const hasHq = Object.prototype.hasOwnProperty.call(stored, 'healthQuestions');
  const storedHq = asQuestionList(stored.healthQuestions);

  if (storedBy && Object.keys(storedBy).length > 0) {
    merged.healthQuestionsByCanal = storedBy;
    const byDefault = asQuestionList(storedBy.default);
    if (byDefault) {
      merged.healthQuestions = byDefault;
    } else if (hasHq && storedHq) {
      merged.healthQuestions = storedHq;
    } else {
      merged.healthQuestions = [];
    }
    return;
  }

  if (hasHq && storedHq) {
    merged.healthQuestions = storedHq;
    merged.healthQuestionsByCanal = { default: storedHq };
  }
}

/**
 * Obtiene la config activa para un producto+módulo de una empresa.
 * Si no existe en BD, retorna el default hardcoded.
 */
export async function getConfig(
  empresaId: number,
  producto: Producto,
  modulo: Modulo,
): Promise<object> {
  const defaults = cloneConfig(DEFAULT_CONFIGS[producto]?.[modulo] ?? {});
  try {
    const record = await prisma.productConfig.findUnique({
      where: { empresaId_producto_modulo: { empresaId, producto, modulo } },
    });
    if (record) {
      const stored = record.configJson as Record<string, unknown>;
      const merged = { ...defaults, ...stored };
      if (producto === 'funerario' && modulo === 'emision') {
        overlayFuneralHealthFromStored(merged, stored);
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

  // Funerario: el array enviado por canal es la fuente de verdad (incluye bajas).
  // No reinyectar healthQuestions viejo del spread del front ({...config, ...patch}).
  if (producto === 'funerario' && modulo === 'emision') {
    const nextBy = incoming.healthQuestionsByCanal;
    const prevBy = existing.healthQuestionsByCanal;
    const nextByEmpty = isCanalMap(nextBy) && Object.keys(nextBy).length === 0;
    if (nextByEmpty && isCanalMap(prevBy)) {
      merged.healthQuestionsByCanal = prevBy;
      logger.warn('[product-config] healthQuestionsByCanal vacío ignorado');
    } else if (isCanalMap(nextBy)) {
      merged.healthQuestionsByCanal = {
        ...(isCanalMap(prevBy) ? prevBy : {}),
        ...nextBy,
      };
    }

    const byMerged = isCanalMap(merged.healthQuestionsByCanal)
      ? merged.healthQuestionsByCanal
      : null;
    const byDefault = byMerged ? asQuestionList(byMerged.default) : null;
    const nextHq = asQuestionList(incoming.healthQuestions);
    const prevHq = asQuestionList(existing.healthQuestions);
    const updatedDefault =
      isCanalMap(nextBy) &&
      Object.prototype.hasOwnProperty.call(nextBy, 'default');

    if (updatedDefault && byDefault) {
      merged.healthQuestions = byDefault;
    } else if (nextHq && nextHq.length === 0 && prevHq && prevHq.length > 0) {
      merged.healthQuestions = prevHq;
      logger.warn(
        `[product-config] healthQuestions vacío ignorado; se conservan ${prevHq.length} preguntas`,
      );
    } else if (updatedDefault && nextHq) {
      merged.healthQuestions = nextHq;
    } else if (prevHq) {
      merged.healthQuestions = prevHq;
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
