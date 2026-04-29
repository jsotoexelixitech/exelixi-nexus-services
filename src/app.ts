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

import { apiKeyGuard } from './middlewares/apikey.middleware';
import { requestIdMiddleware } from './middlewares/request-id.middleware';
import { requestLogger } from './middlewares/logger.middleware';

const app = express();

// --- Request Context & Correlation ---
app.use(requestIdMiddleware);
app.use(requestLogger);

// --- Security & Performance Middlewares ---
app.use(helmet());
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

// Protección Global con API Key
app.use(apiKeyGuard);

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    message: 'Demasiadas peticiones, intente más tarde.',
  },
});
app.use('/api/', limiter);

// --- API Documentation ---
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));

// --- Routes Registration ---
app.use('/api/auth', authRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/users', userRoutes);
app.use('/api/modules', moduleRoutes);

// --- Health Check ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date(), env: env.NODE_ENV });
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

export default app;
