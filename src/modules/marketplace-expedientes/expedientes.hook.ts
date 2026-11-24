/**
 * Enganche desde `EmisionService.registrar`: crea o actualiza el expediente
 * DESPUÉS de registrar, sin esperar ni cambiar la respuesta. Nunca lanza.
 */
import logger from '../../utils/logger';
import { expedientesEnabled } from './expedientes.env';
import {
  EmisionFuente,
  expedientesService,
  RegistroEmisionExtra,
} from './expedientes.service';

export function onEmisionRegistrada(
  emision: EmisionFuente | null | undefined,
  extra: RegistroEmisionExtra = {},
): void {
  try {
    if (!expedientesEnabled() || !emision?.id) return;
    setImmediate(() => {
      expedientesService
        .registrarDesdeEmision(emision, extra, 'emision')
        .catch((err: unknown) => {
          logger.warn(
            `[expedientes] no se pudo crear/actualizar expediente de emision ${emision.id}: ${
              err instanceof Error ? err.message : 'error'
            }`,
          );
        });
    });
  } catch {
    // El registro de la emisión nunca depende del monitor.
  }
}
