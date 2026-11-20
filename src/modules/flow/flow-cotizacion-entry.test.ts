import { describe, expect, it } from 'vitest';
import {
  isEmisionSubmodulo,
  readCotizacionIdFromMetadata,
  resolveCotizacionEntrySlot,
} from './flow-cotizacion-entry';

const base = 'https://nexusqa.exelixitech.com';
const slots = [
  {
    order: 1,
    submoduloId: 37,
    nombre: 'OCR Documentos',
    accessUrl: `${base}/ocr/`,
  },
  {
    order: 2,
    submoduloId: 38,
    nombre: 'Formulario',
    accessUrl: `${base}/formulario/`,
  },
  {
    order: 3,
    submoduloId: 39,
    nombre: 'Emisión Plan',
    accessUrl: `${base}/emision/`,
  },
  { order: 4, submoduloId: 40, nombre: 'Pagos', accessUrl: `${base}/pagos/` },
];
const emision = { id: 39, nombre: 'Emisión Plan', url: `${base}/emision/` };

describe('readCotizacionIdFromMetadata', () => {
  it('acepta cotizacionID y cotizacionId numéricos', () => {
    expect(
      readCotizacionIdFromMetadata({ cotizacionID: '2026000272892' }),
    ).toBe('2026000272892');
    expect(readCotizacionIdFromMetadata({ cotizacionId: 123 })).toBe('123');
  });

  it('rechaza vacío, cero, texto o más de 13 dígitos', () => {
    expect(readCotizacionIdFromMetadata(undefined)).toBeNull();
    expect(readCotizacionIdFromMetadata({})).toBeNull();
    expect(readCotizacionIdFromMetadata({ cotizacionID: '0' })).toBeNull();
    expect(readCotizacionIdFromMetadata({ cotizacionID: '12a' })).toBeNull();
    expect(
      readCotizacionIdFromMetadata({ cotizacionID: '12345678901234' }),
    ).toBeNull();
  });
});

describe('isEmisionSubmodulo', () => {
  it('reconoce Emisión por nombre o por path', () => {
    expect(isEmisionSubmodulo('Emisión Plan', null)).toBe(true);
    expect(isEmisionSubmodulo('Emision RCV', null)).toBe(true);
    expect(isEmisionSubmodulo('Módulo 3', `${base}/emision/?x=1`)).toBe(true);
  });

  it('no confunde OCR, Formulario ni Pagos', () => {
    expect(isEmisionSubmodulo('OCR Documentos', `${base}/ocr/`)).toBe(false);
    expect(isEmisionSubmodulo('Pagos', `${base}/pagos/`)).toBe(false);
  });
});

describe('resolveCotizacionEntrySlot', () => {
  it('Emisión con cotización arranca en su propio slot', () => {
    const slot = resolveCotizacionEntrySlot(
      { cotizacionID: '2026000272892' },
      emision,
      slots,
    );
    expect(slot?.order).toBe(3);
  });

  it('sin cotización mantiene la regla de siempre (null → 409)', () => {
    expect(
      resolveCotizacionEntrySlot({ cproductor: '80080' }, emision, slots),
    ).toBeNull();
  });

  it('cotización con otro submódulo (Formulario, Pagos) no cambia nada', () => {
    const form = { id: 38, nombre: 'Formulario', url: `${base}/formulario/` };
    const pagos = { id: 40, nombre: 'Pagos', url: `${base}/pagos/` };
    expect(
      resolveCotizacionEntrySlot({ cotizacionID: '1' }, form, slots),
    ).toBeNull();
    expect(
      resolveCotizacionEntrySlot({ cotizacionID: '1' }, pagos, slots),
    ).toBeNull();
  });

  it('Emisión fuera de la cadena o sin Pagos después no arranca', () => {
    const otra = { id: 99, nombre: 'Emisión Plan', url: `${base}/emision/` };
    expect(
      resolveCotizacionEntrySlot({ cotizacionID: '1' }, otra, slots),
    ).toBeNull();
    expect(
      resolveCotizacionEntrySlot(
        { cotizacionID: '1' },
        emision,
        slots.slice(0, 3),
      ),
    ).toBeNull();
  });
});
