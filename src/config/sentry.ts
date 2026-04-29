import * as Sentry from '@sentry/node';
import { env } from './env';
import logger from '../utils/logger';

/**
 * Inicializa Sentry para captura de errores y trazabilidad.
 * Solo se activa si SENTRY_DSN está configurado.
 */
export const initSentry = () => {
  if (!env.SENTRY_DSN) {
    logger.info(
      '⚠️  SENTRY_DSN no configurado — Sentry deshabilitado. Los errores solo se registrarán en logs locales.',
    );
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.2 : 1.0,
    profilesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,

    // No enviar datos sensibles
    beforeSend(event) {
      // Limpiar headers sensibles
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['x-api-key'];
        delete event.request.headers['cookie'];
      }

      // Limpiar body con posibles passwords
      if (event.request?.data) {
        const data =
          typeof event.request.data === 'string'
            ? JSON.parse(event.request.data)
            : event.request.data;
        if (data.password) data.password = '[REDACTED]';
        if (data.token) data.token = '[REDACTED]';
        event.request.data = data;
      }

      return event;
    },

    // Breadcrumbs automáticos para queries de Prisma
    beforeBreadcrumb(breadcrumb) {
      // No registrar breadcrumbs de consultas que contengan datos sensibles
      if (breadcrumb.category === 'http' && breadcrumb.data?.url) {
        const url = breadcrumb.data.url as string;
        if (url.includes('/auth/login')) {
          breadcrumb.data.body = '[REDACTED]';
        }
      }
      return breadcrumb;
    },
  });

  logger.info('🛡️  Sentry inicializado correctamente.');
};

/**
 * Captura un error en Sentry con contexto del usuario.
 * NO envía datos sensibles (password, tokens).
 */
export const captureError = (
  error: Error,
  context?: {
    userId?: number;
    empresaId?: number;
    requestId?: string;
    extra?: Record<string, unknown>;
  },
) => {
  if (!env.SENTRY_DSN) return;

  Sentry.withScope((scope) => {
    if (context?.userId) {
      scope.setUser({ id: String(context.userId) });
    }
    if (context?.empresaId) {
      scope.setTag('empresaId', String(context.empresaId));
    }
    if (context?.requestId) {
      scope.setTag('requestId', context.requestId);
    }
    if (context?.extra) {
      scope.setExtras(context.extra);
    }
    Sentry.captureException(error);
  });
};
