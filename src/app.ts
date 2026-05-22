import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';

import { env } from './config/env';
import { specs } from './config/swagger';

import { errorHandler } from './middlewares/error.middleware';

// Routes
import companyRoutes from './modules/company/company.routes';
import roleRoutes from './modules/role/role.routes';
import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/user/user.routes';
import moduleRoutes from './modules/module/module.routes';
import accessRoutes from './modules/access/access.routes';
import flowRoutes from './modules/flow/flow.routes';

import { apiKeyGuard } from './middlewares/apikey.middleware';
import { requestIdMiddleware } from './middlewares/request-id.middleware';
import { requestLogger } from './middlewares/logger.middleware';

const app = express();

// Evitar respuestas 304 (ETag) en endpoints JSON.
// Swagger UI y algunos clientes no siempre reutilizan correctamente el body cacheado.
app.set('etag', false);

// --- Request Context & Correlation ---
app.set('trust proxy', 1); // Confiar en el proxy inverso (Nginx, PM2, etc.)
app.use(requestIdMiddleware);
app.use(requestLogger);

// --- API Documentation (Public) ---
// Colocamos esto antes que cualquier middleware de seguridad o compresión para evitar conflictos con los assets
app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(specs, {
    swaggerOptions: {
      persistAuthorization: true,
    },
    customSiteTitle: 'Exelixi Nexus API Docs',
  }),
);

// Redirección para evitar duplicidad y problemas de assets
app.use('/api/api-docs', (req, res) => res.redirect('/api-docs'));

// --- Security & Performance Middlewares ---
app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);
app.use(
  cors({
    origin: env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true,
  }),
);
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '10kb' }));
app.use(morgan('dev'));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: env.NODE_ENV === 'production' ? 100 : 1000, // Más permisivo en desarrollo
  message: {
    success: false,
    message: 'Demasiadas peticiones, intente más tarde.',
  },
  standardHeaders: true, // Retorna info del límite en los headers `RateLimit-*`
  legacyHeaders: false, // Desactiva los headers `X-RateLimit-*`
});

// --- Public Endpoints ---
app.use('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date(), env: env.NODE_ENV });
});

// --- Public API: verificación de acceso para submódulos externos ---
// No requiere x-api-key. Protegido por firma JWT (TENANT_TOKEN_SECRET) + rate limit propio.
app.use('/api/access', accessRoutes);

// --- Public API: bridge inter-módulo (session/save/done sin API key; start requiere API key) ---
app.use('/api/flow', flowRoutes);

// --- Protected API Routes ---
app.use('/api', apiKeyGuard, limiter);
app.use('/api', (_req, res, next) => {
  // Evitar cache en clientes/proxies y prevenir 304 sin body.
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  // Si algún middleware llegara a setear ETag, lo anulamos para evitar If-None-Match → 304.
  res.removeHeader('ETag');
  next();
});

// --- Routes Registration ---
app.use('/api/auth', authRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/users', userRoutes);
app.use('/api/modules', moduleRoutes);

// --- 404 Handler ---
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Ruta no encontrada: ${req.originalUrl}`,
  });
});

// --- Global Error Handler ---
app.use(errorHandler);

export default app;
