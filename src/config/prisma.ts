import { PrismaClient } from '@prisma/client';

/**
 * Singleton de Prisma para evitar múltiples conexiones innecesarias a la base de datos.
 */
const prisma = new PrismaClient({
  log:
    process.env.NODE_ENV === 'development'
      ? ['query', 'info', 'warn', 'error']
      : ['error'],
});

export default prisma;
