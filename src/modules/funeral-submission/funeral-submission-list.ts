/**
 * Filtros de la lista de mesa técnica (GET /api/funeral-submissions). Solo lectura.
 * 17-nov-2026: el panel pedía limit=200 pero la ruta lo ignoraba (tope fijo de 100): con 460 solicitudes en
 * producción las anteriores a los últimos días no se podían ver. Ahora respeta el límite (hasta 500) y acepta
 * búsqueda por nombre, cédula/RIF, correo o póliza, hecha en el servidor para llegar a cualquier solicitud.
 */
import type { Prisma } from '@prisma/client';

export const LISTA_LIMITE_DEFECTO = 100;
export const LISTA_LIMITE_MAX = 500;
const BUSQUEDA_MAX = 80;
const MAX_TERMINOS = 5;

/** Límite pedido (1..500); sin dato o inválido, 100. */
export function limiteLista(raw: unknown): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return LISTA_LIMITE_DEFECTO;
  return Math.min(n, LISTA_LIMITE_MAX);
}

/** Términos de búsqueda: sin espacios extra, mínimo 2 caracteres, hasta 5. Vacío → sin búsqueda. */
export function terminosBusqueda(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .slice(0, BUSQUEDA_MAX)
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[%_]/g, '').trim())
    .filter((t) => t.length >= 2)
    .slice(0, MAX_TERMINOS);
}

/**
 * Cada término debe aparecer en el nombre, la cédula/RIF (también sin guiones ni puntos), el correo o la póliza
 * del tomador. «ana vargas» encuentra «ANA LUCIA VARGAS GARCIA»; «12345678» encuentra «V-12.345.678».
 */
export function whereBusqueda(terminos: string[]): Prisma.FuneralSubmissionWhereInput[] {
  return terminos.map((t) => {
    const digitos = t.replace(/\D/g, '');
    const or: Prisma.FuneralSubmissionWhereInput[] = [
      { tomadorNombre: { contains: t, mode: 'insensitive' } },
      { tomadorRif: { contains: t, mode: 'insensitive' } },
      { tomadorEmail: { contains: t, mode: 'insensitive' } },
      { cnpoliza: { contains: t, mode: 'insensitive' } },
    ];
    if (digitos.length >= 4 && digitos !== t) or.push({ tomadorRif: { contains: digitos } });
    return { OR: or };
  });
}
