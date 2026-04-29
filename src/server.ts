import app from './app';
import { env } from './config/env';
import logger from './utils/logger';
import prisma from './config/prisma';
import { initSentry } from './config/sentry';

// Inicializar Sentry antes de cualquier otra cosa
initSentry();

const PORT = env.PORT || 3000;

const server = app.listen(PORT, () => {
  logger.info(`🚀 Servidor corriendo en puerto ${PORT}`);
  logger.info(
    `📝 Documentación Swagger disponible en http://localhost:${PORT}/api-docs`,
  );
});

// --- Graceful Shutdown ---
const shutdown = async () => {
  logger.info('Iniciando apagado gradual del servidor...');
  server.close(async () => {
    logger.info('Servidor HTTP cerrado.');
    await prisma.$disconnect();
    logger.info('Conexión a Base de Datos cerrada.');
    process.exit(0);
  });

  // Si no se cierra en 10s, forzar salida
  setTimeout(() => {
    logger.error('No se pudo cerrar gradualmente, forzando salida.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
