/**
 * Utilidad para manejar la lógica de paginación de Prisma.
 */
export const getPagination = (query: Record<string, unknown>) => {
  const page = parseInt(query.page as string) || 1;
  const limit = parseInt(query.limit as string) || 10;
  const skip = (page - 1) * limit;

  return {
    skip,
    take: limit,
    page,
    limit,
  };
};

/**
 * Formatea la respuesta paginada estandarizada.
 */
export const formatPaginatedResponse = <T>(data: T[], total: number, page: number, limit: number) => {
  return {
    data,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    }
  };
};
