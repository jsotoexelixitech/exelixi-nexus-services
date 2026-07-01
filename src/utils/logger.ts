import winston from 'winston';
import { getRequestContext } from './request-context';

/**
 * Formato personalizado que inyecta el requestId del contexto actual
 * en cada línea de log automáticamente.
 */
const injectRequestContext = winston.format((info) => {
  const ctx = getRequestContext();
  if (ctx) {
    info.requestId = ctx.requestId;
    if (ctx.userId) info.userId = ctx.userId;
    if (ctx.empresaId) info.empresaId = ctx.empresaId;
  }
  return info;
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    injectRequestContext(),
    winston.format.timestamp(),
    winston.format.json(),
  ),
  defaultMeta: { service: 'exelixi-nexus' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

// Consola activa en desarrollo, o forzada con LOG_CONSOLE=true (útil en
// servidores prod-like donde se quiere ver logs en stdout/pm2 sin relajar
// el resto del comportamiento de producción).
const enableConsole =
  process.env.NODE_ENV !== 'production' || process.env.LOG_CONSOLE === 'true';

if (enableConsole) {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        injectRequestContext(),
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, requestId }) => {
          const rid = requestId ? `[${requestId}]` : '';
          return `${level}: ${rid} ${message} ${timestamp ? `{${timestamp}}` : ''}`;
        }),
      ),
    }),
  );
}

export default logger;
