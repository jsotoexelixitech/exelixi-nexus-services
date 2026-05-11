import { z } from 'zod';

const optionalSubmoduleUrl = z
  .union([z.string().url('URL inválida'), z.literal(''), z.null()])
  .optional();

/**
 * Esquema de validación para la creación de un submódulo.
 */
export const createSubmoduleSchema = z.object({
  body: z.object({
    moduloId: z.number({
      required_error: 'El ID del módulo es obligatorio',
      invalid_type_error: 'El ID del módulo debe ser un número',
    }),
    nombre: z
      .string({
        required_error: 'El nombre del submódulo es obligatorio',
      })
      .min(3, 'El nombre debe tener al menos 3 caracteres'),
    url: optionalSubmoduleUrl,
  }),
});

export const updateSubmoduleSchema = z.object({
  body: z
    .object({
      nombre: z
        .string()
        .min(3, 'El nombre debe tener al menos 3 caracteres')
        .optional(),
      activo: z.boolean().optional(),
      url: optionalSubmoduleUrl,
    })
    .refine(
      (b) =>
        b.nombre !== undefined || b.activo !== undefined || b.url !== undefined,
      { message: 'Debe enviar al menos nombre, activo o url' },
    ),
});
