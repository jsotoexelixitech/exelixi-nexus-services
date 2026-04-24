import { z } from 'zod';

export const createRoleSchema = z.object({
  body: z.object({
    nombre: z.string().min(3, 'El nombre debe tener al menos 3 caracteres'),
  }),
});

export const assignPermissionsSchema = z.object({
  body: z.object({
    roleId: z.string().uuid('ID de rol inválido'),
    permissions: z.array(z.object({
      moduloId: z.string().uuid('ID de módulo inválido'),
      canRead: z.boolean(),
      canWrite: z.boolean(),
      canDelete: z.boolean(),
    })).min(1, 'Debe proporcionar al menos un permiso'),
  }),
});
