import { z } from 'zod';

export const createRoleSchema = z.object({
  body: z.object({
    nombre: z.string().min(3, 'El nombre debe tener al menos 3 caracteres'),
  }),
});

export const assignPermissionsSchema = z.object({
  body: z.object({
    roleId: z.number({ required_error: 'ID de rol es obligatorio' }),
    permissions: z.array(z.object({
      moduloId: z.number({ required_error: 'ID de módulo es obligatorio' }),
      canCreate: z.boolean().optional(),
      canRead: z.boolean().optional(),
      canUpdate: z.boolean().optional(),
      canDelete: z.boolean().optional(),
      submodulos: z.array(z.object({
        submoduloId: z.number(),
        canCreate: z.boolean().optional(),
        canRead: z.boolean().optional(),
        canUpdate: z.boolean().optional(),
        canDelete: z.boolean().optional(),
      })).optional()
    })).min(1, 'Debe proporcionar al menos un permiso'),
  }),
});
