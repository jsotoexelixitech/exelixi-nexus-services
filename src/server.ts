import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";

import { env } from "./config/env";
import { specs } from "./config/swagger";
import prisma from "./config/prisma";
import logger from "./utils/logger";
import { errorHandler } from "./middlewares/error.middleware";

// Routes
import companyRoutes from "./modules/company/company.routes";
import roleRoutes from "./modules/role/role.routes";
import authRoutes from "./modules/auth/auth.routes";
import userRoutes from "./modules/user/user.routes";
import moduleRoutes from "./modules/module/module.routes";

import { apiKeyGuard } from "./middlewares/apikey.middleware";

const app = express();

// --- Security & Performance Middlewares ---
app.use(helmet());
app.use(
  cors({
    origin: env.ALLOWED_ORIGINS?.split(",") || "*",
    credentials: true,
  }),
);
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "10kb" }));
app.use(morgan("dev"));

// Protección Global con API Key
app.use(apiKeyGuard);

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    message: "Demasiadas peticiones, intente más tarde.",
  },
});
app.use("/api/", limiter);

// --- API Documentation ---
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));

// --- Routes Registration ---
app.use("/api/auth", authRoutes);
app.use("/api/companies", companyRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/users", userRoutes);
app.use("/api/modules", moduleRoutes);

// --- Health Check ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date(), env: env.NODE_ENV });
});

// --- 404 Handler ---
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Ruta no encontrada: ${req.originalUrl}`,
  });
});

// --- Global Error Handler ---
app.use(errorHandler);

const PORT = env.PORT || 3000;

const server = app.listen(PORT, () => {
  logger.info(`🚀 Servidor corriendo en puerto ${PORT}`);
  logger.info(
    `📝 Documentación Swagger disponible en http://localhost:${PORT}/api-docs`,
  );
});

// --- Graceful Shutdown ---
const shutdown = async () => {
  logger.info("Iniciando apagado gradual del servidor...");
  server.close(async () => {
    logger.info("Servidor HTTP cerrado.");
    await prisma.$disconnect();
    logger.info("Conexión a Base de Datos cerrada.");
    process.exit(0);
  });

  // Si no se cierra en 10s, forzar salida
  setTimeout(() => {
    logger.error("No se pudo cerrar gradualmente, forzando salida.");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export default app;
