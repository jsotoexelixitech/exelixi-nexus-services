import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.string().default('3000'),
  DATABASE_URL: z.string().url('DATABASE_URL debe ser una URL válida'),
  JWT_SECRET: z
    .string()
    .min(10, 'JWT_SECRET debe tener al menos 10 caracteres'),
  API_KEY: z
    .string()
    .min(20, 'API_KEY debe tener al menos 20 caracteres por seguridad'),
  ENCRYPTION_KEY: z
    .string()
    .length(
      32,
      'ENCRYPTION_KEY debe tener exactamente 32 caracteres (AES-256)',
    ),
  ALLOWED_ORIGINS: z.string().default('*'),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error(
    '❌ Error en variables de entorno:',
    JSON.stringify(_env.error.format(), null, 2),
  );
  process.exit(1);
}

export const env = _env.data;
