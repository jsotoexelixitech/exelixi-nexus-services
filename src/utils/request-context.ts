import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

/**
 * Almacén de contexto por petición usando AsyncLocalStorage.
 * Permite acceder al requestId desde cualquier parte del código
 * sin necesidad de pasar el objeto Request.
 */

export interface RequestContext {
  requestId: string;
  userId?: number;
  empresaId?: number;
  method?: string;
  url?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Genera un ID de correlación único para cada petición.
 * Formato: 8 caracteres hex (rápido, suficiente para correlación).
 */
export const generateRequestId = (): string => {
  return crypto.randomBytes(8).toString('hex');
};

/**
 * Obtiene el contexto de la petición actual.
 * Seguro para llamar desde cualquier parte — retorna undefined si no hay contexto.
 */
export const getRequestContext = (): RequestContext | undefined => {
  return requestContext.getStore();
};
