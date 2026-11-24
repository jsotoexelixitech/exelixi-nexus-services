/**
 * Revisión de punta a punta del monitor (24-nov-2026). Matriz con las dos direcciones:
 *   A) un documento correcto NUNCA sale «Errado» (no_coincide) por un dato malo del registro;
 *   B) una cédula ajena (otro número) NUNCA sale validada.
 * Reglas puras (sin BD ni OCR): tomador V/E/J/G/P, titular igual o distinto, RCV con sus 3
 * documentos, personas, viajero, PDF con varios documentos, foto girada, lectura vacía o con rótulos.
 */
import { describe, expect, it } from 'vitest';

import {
  contextoPoliza,
  diagnosticar,
  estadoPorDiagnostico,
} from './expedientes.ia';

const lectura = (extraido: any, confianza = 1) => ({ extraido, confianza });
const campoDe = (d: any, c: string) => d.campos.find((x: any) => x.campo === c);

const ANA = {
  tipoDoc: 'V',
  documento: '14111222',
  nombre: 'Ana María',
  apellido: 'Pérez Gómez',
};
const LUIS = {
  tipoDoc: 'V',
  documento: '9333444',
  nombre: 'Luis',
  apellido: 'Díaz Ñáñez',
};
const EXTRANJERO = {
  tipoDoc: 'E',
  documento: '84555666',
  nombre: 'João',
  apellido: 'Da Silva',
};
const PASAPORTE = {
  tipoDoc: 'P',
  documento: 'EM2849387',
  nombre: 'ZHIZHONG',
  apellido: 'HUANG',
};
const EMPRESA = {
  tipoDoc: 'J',
  documento: '500585039',
  nombre: 'Supermercado Río Vida, C.A.',
};
const GOBIERNO = {
  tipoDoc: 'G',
  documento: '200001234',
  nombre: 'Alcaldía del Municipio Ejemplo',
};
const VEHICULO = {
  placa: 'AB123CD',
  marca: 'Toyota',
  modelo: 'Corolla',
  anio: 2020,
  serial: '8XA53ZEC2L9012345',
  serialMotor: '2ZR1234567',
};

const cedulaDe = (p: any, extra: any = {}) => ({
  documentoTipo: 'cedula',
  tipoDoc: p.tipoDoc,
  identificacion: p.documento,
  nombre: String(p.nombre).toUpperCase(),
  apellido: String(p.apellido ?? '').toUpperCase(),
  ...extra,
});
/** Cédula de una persona que no está en ninguna póliza de la matriz. */
const AJENA = {
  documentoTipo: 'cedula',
  tipoDoc: 'V',
  identificacion: '27999888',
  nombre: 'CARLOS',
  apellido: 'RAMIREZ',
};

const rcv = (tomador: any, asegurado: any = tomador) =>
  contextoPoliza({
    producto: 'rcv',
    snapshot: { tomador, asegurado, vehiculo: VEHICULO },
  });
const personas = (tomador: any, titular: any = tomador, extra: any = {}) =>
  contextoPoliza({
    producto: 'personas',
    snapshot: { tomador, asegurado: titular, ...extra },
    aseguradoTipoDoc: titular.tipoDoc,
    aseguradoDocumento: titular.documento,
    aseguradoNombre: titular.nombre,
    aseguradoApellido: titular.apellido ?? null,
  });

interface Caso {
  nombre: string;
  tipo: string;
  ctx: () => ReturnType<typeof contextoPoliza>;
  /** Lectura del documento correcto. */
  correcto: any;
  /** Resultado esperado del documento correcto (por defecto «coincide»). */
  esperado?: string;
  /** Lectura de un documento ajeno (por defecto la cédula AJENA). */
  ajeno?: any;
}

const CASOS: Caso[] = [
  {
    nombre: 'RCV · tomador V · cédula',
    tipo: 'cedula',
    ctx: () => rcv(ANA),
    correcto: cedulaDe(ANA),
  },
  {
    nombre: 'RCV · tomador E · cédula',
    tipo: 'cedula',
    ctx: () => rcv(EXTRANJERO),
    correcto: cedulaDe(EXTRANJERO),
  },
  {
    nombre: 'RCV · tomador J · RIF en el espacio de la cédula',
    tipo: 'cedula',
    ctx: () => rcv(EMPRESA),
    correcto: {
      documentoTipo: 'rif',
      tipoDoc: 'J',
      rif: 'J-50058503-9',
      razonSocial: 'SUPERMERCADO RIO VIDA CA',
    },
    ajeno: {
      documentoTipo: 'rif',
      tipoDoc: 'J',
      rif: 'J-40999888-1',
      razonSocial: 'OTRA EMPRESA CA',
    },
  },
  {
    nombre: 'RCV · tomador G · RIF',
    tipo: 'cedula',
    ctx: () => rcv(GOBIERNO),
    correcto: {
      documentoTipo: 'rif',
      tipoDoc: 'G',
      rif: 'G-20000123-4',
      razonSocial: 'ALCALDIA DEL MUNICIPIO EJEMPLO',
    },
    ajeno: {
      documentoTipo: 'rif',
      tipoDoc: 'G',
      rif: 'G-20000999-0',
      razonSocial: 'GOBERNACION DE OTRO ESTADO',
    },
  },
  {
    nombre: 'RCV · licencia del tomador',
    tipo: 'licencia',
    ctx: () => rcv(ANA),
    correcto: {
      identificacion: ANA.documento,
      nombre: 'ANA MARIA',
      apellido: 'PEREZ GOMEZ',
      vencimiento: '2031-01-01',
    },
    ajeno: {
      identificacion: '27999888',
      nombre: 'CARLOS',
      apellido: 'RAMIREZ',
      vencimiento: '2031-01-01',
    },
  },
  {
    nombre: 'RCV · certificado del vehículo',
    tipo: 'certificado',
    ctx: () => rcv(ANA),
    correcto: {
      placa: 'AB123CD',
      serial: '8XA53ZEC2L9012345',
      marca: 'TOYOTA',
      modelo: 'COROLLA',
      anio: '2020',
    },
    ajeno: {
      placa: 'ZZ999ZZ',
      serial: '9BWZZZ377VT004251',
      marca: 'FORD',
      modelo: 'FIESTA',
      anio: '2011',
    },
  },
  {
    nombre: 'personas · tomador V = titular · cédula del tomador',
    tipo: 'cedula',
    ctx: () => personas(ANA),
    correcto: cedulaDe(ANA),
  },
  {
    nombre: 'personas · tomador P (pasaporte)',
    tipo: 'cedula',
    ctx: () => personas(PASAPORTE),
    correcto: {
      documentoTipo: 'pasaporte',
      tipoDoc: 'P',
      identificacion: 'EM2849387',
      nombre: 'ZHIZHONG',
      apellido: 'HUANG',
    },
    ajeno: {
      documentoTipo: 'pasaporte',
      tipoDoc: 'P',
      identificacion: 'XX1234567',
      nombre: 'WEI',
      apellido: 'CHEN',
    },
  },
  {
    nombre: 'personas · tomador V distinto del titular · cédula del tomador',
    tipo: 'cedula',
    ctx: () => personas(ANA, LUIS),
    correcto: cedulaDe(ANA),
  },
  {
    nombre: 'personas · titular distinto · cédula del titular',
    tipo: 'cedula_titular',
    ctx: () => personas(ANA, LUIS),
    correcto: cedulaDe(LUIS),
  },
  {
    nombre: 'personas · tomador J · RIF del tomador',
    tipo: 'cedula',
    ctx: () => personas(EMPRESA, LUIS),
    correcto: {
      documentoTipo: 'rif',
      tipoDoc: 'J',
      rif: 'J500585039',
      identificacion: '500585039',
      razonSocial: 'SUPERMERCADO RIO VIDA, C.A.',
    },
    ajeno: {
      documentoTipo: 'rif',
      tipoDoc: 'J',
      rif: 'J409998881',
      identificacion: '409998881',
      razonSocial: 'OTRA EMPRESA CA',
    },
  },
  {
    nombre: 'personas · PDF con el RIF del tomador y la cédula del titular',
    tipo: 'cedula',
    ctx: () => personas(EMPRESA, LUIS),
    correcto: {
      documentoTipo: 'rif',
      tipoDoc: 'J',
      rif: 'J500585039',
      identificacion: '500585039',
      razonSocial: 'SUPERMERCADO RIO VIDA CA',
      documentosAdicionales: [cedulaDe(LUIS)],
    },
    ajeno: {
      documentoTipo: 'rif',
      tipoDoc: 'J',
      rif: 'J409998881',
      identificacion: '409998881',
      razonSocial: 'OTRA EMPRESA CA',
      documentosAdicionales: [AJENA],
    },
  },
  {
    nombre: 'viajero (personas, producto 25) · cédula del tomador',
    tipo: 'cedula',
    ctx: () => personas(ANA, ANA, { cproducto: '25' }),
    correcto: cedulaDe(ANA),
  },
  {
    nombre: 'tildes y ñ: el registro con acentos y la lectura sin ellos',
    tipo: 'cedula',
    ctx: () => rcv(LUIS),
    correcto: {
      documentoTipo: 'cedula',
      tipoDoc: 'V',
      identificacion: '9.333.444',
      nombre: 'LUIS',
      apellido: 'DIAZ NANEZ',
    },
  },
  {
    nombre: 'nombre y apellido en un solo campo del registro (conciliación)',
    tipo: 'cedula',
    ctx: () =>
      rcv({ nombre: 'Ana María Pérez Gómez', identificacion: 'V-14111222' }),
    correcto: cedulaDe(ANA),
  },
  {
    nombre: 'orden invertido: apellidos primero en el registro',
    tipo: 'cedula',
    ctx: () =>
      rcv({ nombre: 'PEREZ GOMEZ ANA MARIA', identificacion: 'V-14111222' }),
    correcto: cedulaDe(ANA),
  },
  {
    nombre: 'segundo nombre y segundo apellido ausentes en la lectura',
    tipo: 'cedula',
    ctx: () => rcv(ANA),
    correcto: cedulaDe(ANA, { nombre: 'ANA', apellido: 'PEREZ' }),
  },
  {
    nombre:
      'nombre de pila distinto con el mismo número y apellido (7-7-7000003208)',
    tipo: 'cedula_titular',
    ctx: () =>
      personas(EMPRESA, {
        tipoDoc: 'V',
        documento: '17671805',
        nombre: 'RAMON',
        apellido: 'PEREZ GARCIA',
      }),
    correcto: {
      documentoTipo: 'cedula',
      tipoDoc: 'V',
      identificacion: '17671805',
      nombre: 'JHON',
      apellido: 'PEREZ GARCIA',
    },
  },
  {
    nombre: 'registro con el nombre «Masculino» (18-1-0000139376)',
    tipo: 'cedula',
    ctx: () =>
      rcv({ nombre: 'Masculino RODRIGUEZ PEÑA', identificacion: 'V-13307292' }),
    correcto: {
      documentoTipo: 'cedula',
      tipoDoc: 'V',
      identificacion: '13307292',
      nombre: 'DANRY FERNANDO',
      apellido: 'RODRIGUEZ PEÑA',
    },
  },
  {
    nombre: 'foto girada: la lectura trae «MASCULINO» como nombre',
    tipo: 'cedula',
    ctx: () => rcv(ANA),
    correcto: cedulaDe(ANA, { nombre: 'FEMENINO' }),
  },
  {
    nombre: 'lectura con rótulos en vez del nombre → revisar',
    tipo: 'cedula',
    ctx: () => rcv(ANA),
    correcto: cedulaDe(ANA, { nombre: 'NOMBRES', apellido: 'APELLIDOS' }),
    esperado: 'sin_certeza',
  },
  {
    nombre:
      'lectura parcial (confianza media) del documento correcto → revisar',
    tipo: 'cedula',
    ctx: () => rcv(ANA),
    correcto: { ...cedulaDe(ANA), __confianza: 0.5 },
    esperado: 'sin_certeza',
  },
];

const leer = (ex: any) => {
  const { __confianza, ...extraido } = ex;
  return lectura(extraido, __confianza ?? 1);
};

describe('matriz A: un documento correcto nunca sale «Errado»', () => {
  it.each(CASOS.map((c) => [c.nombre, c] as const))('%s', (_n, c) => {
    const d = diagnosticar(c.tipo, leer(c.correcto), c.ctx());
    expect(d.resultado).not.toBe('no_coincide');
    expect(d.resultado).not.toBe('datos_modificados');
    expect(d.resultado).toBe(c.esperado ?? 'coincide');
    if ((c.esperado ?? 'coincide') === 'coincide')
      expect(estadoPorDiagnostico(d).estado).toBe('validado');
  });
});

describe('matriz B: un documento ajeno nunca queda validado', () => {
  it.each(CASOS.map((c) => [c.nombre, c] as const))('%s', (_n, c) => {
    const d = diagnosticar(c.tipo, leer(c.ajeno ?? AJENA), c.ctx());
    expect(d.resultado).not.toBe('coincide');
    expect(estadoPorDiagnostico(d).estado).not.toBe('validado');
  });

  it.each(CASOS.map((c) => [c.nombre, c] as const))(
    'mismo nombre y otro número · %s',
    (_n, c) => {
      // El nombre del documento correcto con el número de otra persona.
      const base = { ...c.correcto };
      delete base.documentosAdicionales;
      if (c.tipo === 'certificado') {
        base.placa = 'ZZ999ZZ';
        base.serial = '9BWZZZ377VT004251';
      } else if (base.rif) {
        base.rif = base.rif.startsWith('G') ? 'G-20000999-0' : 'J409998881';
        if (base.identificacion) base.identificacion = '409998881';
      } else if (base.tipoDoc === 'P') base.identificacion = 'XX1234567';
      else base.identificacion = '27999888';
      const d = diagnosticar(c.tipo, leer(base), c.ctx());
      expect(d.resultado).not.toBe('coincide');
    },
  );
});

describe('matriz: lectura vacía', () => {
  it('sin datos leídos → ilegible (ni errado ni validado)', () => {
    const d = diagnosticar('cedula', lectura({}), rcv(ANA));
    expect(d.resultado).toBe('ilegible');
  });

  it('solo el rótulo en el número → revisar', () => {
    const d = diagnosticar(
      'cedula',
      lectura({ identificacion: 'CEDULA', nombre: 'ANA', apellido: 'PEREZ' }),
      rcv(ANA),
    );
    expect(d.resultado).toBe('sin_certeza');
  });
});

describe('v13: nombre de pila distinto con el mismo número (7-7-7000003208)', () => {
  const RAMON = {
    tipoDoc: 'V',
    documento: '17671805',
    nombre: 'RAMON',
    apellido: 'PEREZ GARCIA',
  };
  const JHON = {
    documentoTipo: 'cedula',
    tipoDoc: 'V',
    identificacion: '17671805',
    nombre: 'JHON',
    apellido: 'PEREZ GARCIA',
  };

  it('mismo número y apellido: el nombre queda «difiere» (informativo) y valida', () => {
    const d = diagnosticar('cedula', lectura(JHON), rcv(RAMON));
    expect(d.resultado).toBe('coincide');
    expect(campoDe(d, 'nombre')).toMatchObject({
      estado: 'difiere',
      enPoliza: 'RAMON',
      enDocumento: 'JHON',
    });
    expect(d.resumen).toMatch(/Difiere \(informativo, no cuenta\): nombre/i);
  });

  it('mismo número y OTRO apellido → errado', () => {
    const d = diagnosticar(
      'cedula',
      lectura({ ...JHON, apellido: 'SALAZAR MORA' }),
      rcv(RAMON),
    );
    expect(d.resultado).toBe('no_coincide');
  });

  it('otro número, mismo apellido y otro nombre → errado', () => {
    const d = diagnosticar(
      'cedula',
      lectura({ ...JHON, identificacion: '17671999' + '0' }),
      rcv(RAMON),
    );
    expect(d.resultado).toBe('no_coincide');
  });

  it('el nombre cambiado a mano en el formulario se sigue avisando (datos cambiados)', () => {
    const ctx = contextoPoliza({
      producto: 'rcv',
      snapshot: {
        tomador: RAMON,
        asegurado: RAMON,
        ocrLeido: {
          cedula: {
            tipoDoc: 'V',
            documento: '17671805',
            nombre: 'JHON',
            apellido: 'PEREZ GARCIA',
          },
        },
      },
    });
    const d = diagnosticar('cedula', lectura(JHON), ctx);
    expect(d.resultado).toBe('datos_modificados');
  });
});
