import { z } from 'zod';

/**
 * Esquema de validación para la creación de un submódulo.
 */
export const createSubmoduleSchema = z.object({
  body: z.object({
    moduloId: z.number({
      required_error: 'El ID del módulo es obligatorio',
      invalid_type_error: 'El ID del módulo debe ser un número'
    }),
    nombre: z.string({
      required_error: 'El nombre del submódulo es obligatorio'
    }).min(3, 'El nombre debe tener al menos 3 caracteres')
  })
});
