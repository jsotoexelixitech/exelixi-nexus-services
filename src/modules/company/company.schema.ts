import { z } from 'zod';

export const createCompanySchema = z.object({
  body: z.object({
    nombre: z.string().min(3, 'El nombre debe tener al menos 3 caracteres'),
    rif: z
      .string()
      .min(5, 'El RIF debe tener al menos 5 caracteres')
      .optional(),
    tipo: z.string().optional(),
  }),
});

export const updateCompanySchema = z.object({
  body: z.object({
    nombre: z
      .string()
      .min(3, 'El nombre debe tener al menos 3 caracteres')
      .optional(),
    rif: z
      .string()
      .min(5, 'El RIF debe tener al menos 5 caracteres')
      .optional(),
    tipo: z.string().optional(),
    activo: z.boolean().optional(),
  }),
});

export const toggleModuleSchema = z.object({
  body: z.object({
    empresaId: z.number({ required_error: 'ID de empresa es requerido' }),
    moduloId: z.number({ required_error: 'ID de módulo es requerido' }),
    active: z.boolean(),
  }),
});

export const toggleSubmoduleSchema = z.object({
  body: z.object({
    empresaId: z.number({ required_error: 'ID de empresa es requerido' }),
    submoduloId: z.number({ required_error: 'ID de submódulo es requerido' }),
    active: z.boolean(),
  }),
});
