import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/prisma', () => ({ default: {} }));

import { coloresValidos, contraste, normalizarHex } from './marca.colores';
import { rutaLogo, tipoDeImagen } from './marca.service';

describe('marca: colores', () => {
  it('normaliza #RGB y #RRGGBB y rechaza lo demás', () => {
    expect(normalizarHex('#0f1a5a')).toBe('#0F1A5A');
    expect(normalizarHex('abc')).toBe('#AABBCC');
    expect(normalizarHex('#12345')).toBeNull();
    expect(normalizarHex(null)).toBeNull();
  });

  it('vacío = sin color propio; muy claro o inválido se rechaza', () => {
    expect(
      coloresValidos({ colorPrincipal: '#0f1a5a', colorSecundario: '' }),
    ).toEqual({
      colorPrincipal: '#0F1A5A',
      colorSecundario: null,
      colorTerciario: null,
    });
    expect(() => coloresValidos({ colorPrincipal: '#FFEB3B' })).toThrow(
      /muy claro/,
    );
    expect(() => coloresValidos({ colorTerciario: 'rojo' })).toThrow(
      /no es válido/,
    );
  });

  it('contraste WCAG', () => {
    expect(contraste('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    expect(contraste('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });
});

describe('marca: logo', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8),
  ]);

  it('reconoce PNG, JPG y WEBP por su firma; SVG no', () => {
    expect(tipoDeImagen(png)).toBe('image/png');
    expect(
      tipoDeImagen(Buffer.from([0xff, 0xd8, 0xff, ...Buffer.alloc(12)])),
    ).toBe('image/jpeg');
    expect(
      tipoDeImagen(
        Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'),
      ),
    ).toBe('image/webp');
    expect(
      tipoDeImagen(Buffer.from('<svg><script>alert(1)</script></svg>')),
    ).toBeNull();
  });

  it('la ruta del logo lleva la versión', () => {
    expect(
      rutaLogo({
        empresaId: 7,
        logoMime: 'image/png',
        updatedAt: new Date(1000),
      }),
    ).toBe('/api/access/marca/7/logo?v=1000');
    expect(
      rutaLogo({ empresaId: 7, logoMime: null, updatedAt: new Date() }),
    ).toBeNull();
  });
});
