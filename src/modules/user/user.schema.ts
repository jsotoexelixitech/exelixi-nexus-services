import { z } from 'zod';

export const createUserSchema = z.object({
  body: z.object({
    nombre: z.string().min(3, 'El nombre debe tener al menos 3 caracteres'),
    email: z.string().email('Email inválido'),
    password: z
      .string()
      .min(6, 'La contraseña debe tener al menos 6 caracteres'),
    roleId: z.number({ required_error: 'ID de rol es obligatorio' }),
  }),
});

export const updateUserSchema = z.object({
  body: z.object({
    nombre: z.string().min(3).optional(),
    email: z.string().email().optional(),
    password: z.string().min(6).optional(),
    roleId: z.number().optional(),
    activo: z.boolean().optional(),
  }),
});

export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1, 'La contraseña actual es requerida'),
    newPassword: z
      .string()
      .min(6, 'La nueva contraseña debe tener al menos 6 caracteres'),
  }),
});
