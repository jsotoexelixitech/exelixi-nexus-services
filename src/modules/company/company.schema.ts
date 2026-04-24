import { z } from 'zod';

export const createCompanySchema = z.object({
  body: z.object({
    nombre: z.string().min(3, 'El nombre debe tener al menos 3 caracteres'),
    slug: z.string().min(3, 'El slug debe tener al menos 3 caracteres').regex(/^[a-z0-9-]+$/, 'El slug solo puede contener letras minúsculas, números y guiones'),
  }),
});

export const toggleModuleSchema = z.object({
  body: z.object({
    empresaId: z.string().uuid('ID de empresa inválido'),
    moduloId: z.string().uuid('ID de módulo inválido'),
    active: z.boolean(),
  }),
});

export const createModuleSchema = z.object({
  body: z.object({
    nombre: z.string().min(3, 'El nombre debe tener al menos 3 caracteres'),
    key: z.string().min(3, 'La key debe tener al menos 3 caracteres').toUpperCase(),
    descripcion: z.string().optional(),
  }),
});
