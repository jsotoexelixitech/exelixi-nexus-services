/**
 * Obtiene un mensaje de error seguro de un objeto desconocido.
 */
export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};
