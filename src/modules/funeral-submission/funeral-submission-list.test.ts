import { describe, expect, it } from 'vitest';
import { limiteLista, terminosBusqueda, whereBusqueda } from './funeral-submission-list';

describe('lista de mesa técnica: límite y búsqueda (17-nov-2026)', () => {
  it('respeta el límite pedido hasta 500; sin dato, 100', () => {
    expect(limiteLista('200')).toBe(200);
    expect(limiteLista(1000)).toBe(500);
    expect(limiteLista(undefined)).toBe(100);
    expect(limiteLista('abc')).toBe(100);
    expect(limiteLista(-3)).toBe(100);
  });

  it('separa términos, descarta los de 1 letra y comodines SQL', () => {
    expect(terminosBusqueda('  ana   vargas ')).toEqual(['ana', 'vargas']);
    expect(terminosBusqueda('a %_ gar%cia')).toEqual(['garcia']);
    expect(terminosBusqueda(undefined)).toEqual([]);
    expect(terminosBusqueda('uno dos tres cuatro cinco seis')).toHaveLength(5);
  });

  it('cada término busca en nombre, cédula, correo y póliza; la cédula también sin guiones', () => {
    const [nombre] = whereBusqueda(['vargas']);
    expect(nombre.OR).toHaveLength(4);
    const [cedula] = whereBusqueda(['V-12.345.678']);
    expect(cedula.OR).toContainEqual({ tomadorRif: { contains: '12345678' } });
  });
});
