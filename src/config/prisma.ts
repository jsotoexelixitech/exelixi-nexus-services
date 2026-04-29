import { PrismaClient } from '@prisma/client';
import * as Sentry from '@sentry/node';

/**
 * Singleton de Prisma para evitar múltiples conexiones innecesarias a la base de datos.
 */
const prisma = new PrismaClient({
  log:
    process.env.NODE_ENV === 'development'
      ? ['query', 'info', 'warn', 'error']
      : ['error'],
});

// Extensión para registrar breadcrumbs en Sentry para cada query
prisma.$extends({
  query: {
    async $allOperations({ operation, model, args, query }) {
      const start = Date.now();
      try {
        const result = await query(args);
        const duration = Date.now() - start;

        Sentry.addBreadcrumb({
          category: 'db',
          message: `${model}.${operation}`,
          level: 'info',
          data: {
            duration,
            // No registramos los args para evitar fuga de datos sensibles
            // (podrían contener passwords o emails)
          },
        });

        return result;
      } catch (error) {
        const duration = Date.now() - start;
        Sentry.addBreadcrumb({
          category: 'db',
          message: `${model}.${operation} FAILED`,
          level: 'error',
          data: { duration },
        });
        throw error;
      }
    },
  },
});

export default prisma;
