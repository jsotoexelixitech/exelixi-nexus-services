/**
 * v13 (24-nov): falsa alarma de prod en la póliza RCV 18-1-0000139376. El expediente se creó por
 * conciliación con el nombre completo que registró Emisión («Masculino RODRIGUEZ PEÑA», sin apellido
 * aparte) y la cédula cargada (misma persona, mismo número) salía «Errado». Un nombre REGISTRADO que
 * es solo sexo o estado civil es sin dato; nunca valida una cédula ajena ni toca una razón social.
 */
import { describe, expect, it } from 'vitest';

import {
  contextoPoliza,
  diagnosticar,
  estadoPorDiagnostico,
  motivoAnalisis,
  motivoParaAsegurado,
  VERSION_COMPARADOR,
} from './expedientes.ia';

const lectura = (extraido: any, confianza = 1) => ({ extraido, confianza });
const campoDe = (d: any, c: string) => d.campos.find((x: any) => x.campo === c);

/** Forma mínima del snapshot creado por conciliación (tabla `emision`). */
const SNAP_139376 = {
  tomador: {
    nombre: 'Masculino RODRIGUEZ PEÑA',
    identificacion: 'V-13307292',
  },
  plan: 'RCV',
};
const ctx139376 = () =>
  contextoPoliza({
    producto: 'rcv',
    snapshot: SNAP_139376,
    aseguradoTipoDoc: 'V',
    aseguradoDocumento: '13307292',
    aseguradoNombre: 'Masculino RODRIGUEZ PEÑA',
    aseguradoApellido: null,
  });
const CEDULA = {
  identificacion: '13307292',
  tipoDoc: 'V',
  nombre: 'DANRY FERNANDO',
  apellido: 'RODRIGUEZ PEÑA',
};

describe('v13: nombre registrado que es sexo o estado civil (18-1-0000139376)', () => {
  it('sube la versión del comparador', () => {
    expect(VERSION_COMPARADOR).toBeGreaterThanOrEqual(13);
  });

  it('«Masculino RODRIGUEZ PEÑA» + su cédula (mismo número y apellido) → validado, sin «Errado»', () => {
    const d = diagnosticar('cedula', lectura(CEDULA), ctx139376());
    expect(d.resultado).toBe('coincide');
    expect(estadoPorDiagnostico(d).estado).toBe('validado');
    expect(campoDe(d, 'documento').coincide).toBe(true);
    expect(campoDe(d, 'apellido')).toMatchObject({
      estado: 'coincide',
      enPoliza: 'RODRIGUEZ PEÑA',
    });
    expect(campoDe(d, 'nombre').estado).toBe('sin_dato_poliza');
    expect(d.resumen).toContain('«Masculino»');
    expect(d.resumen).not.toMatch(/no coincide|corregir/i);
  });

  it('nombre «Masculino» y apellido aparte (forma de Emisión) → validado', () => {
    const p = {
      tipoDoc: 'V',
      documento: '13307292',
      nombre: 'Masculino',
      apellido: 'Rodriguez Peña',
    };
    const d = diagnosticar(
      'cedula',
      lectura(CEDULA),
      contextoPoliza({
        producto: 'rcv',
        snapshot: { tomador: p, asegurado: p },
      }),
    );
    expect(d.resultado).toBe('coincide');
    expect(campoDe(d, 'nombre').estado).toBe('sin_dato_poliza');
  });

  it('solo «Masculino», sin apellido registrado → revisar (el número solo no valida), nunca errado', () => {
    const p = { tipoDoc: 'V', documento: '13307292', nombre: 'Masculino' };
    const d = diagnosticar(
      'cedula',
      lectura(CEDULA),
      contextoPoliza({ producto: 'rcv', snapshot: { tomador: p } }),
    );
    expect(d.resultado).toBe('sin_certeza');
    expect(d.resumen).toContain('Falta confirmar el nombre');
  });

  it('lectura parcial (confianza baja) → revisar, no validado', () => {
    const d = diagnosticar('cedula', lectura(CEDULA, 0.5), ctx139376());
    expect(d.resultado).toBe('sin_certeza');
  });

  describe('negativas: una cédula ajena siempre sale errada', () => {
    it('otro número con el mismo apellido → no_coincide', () => {
      const d = diagnosticar(
        'cedula',
        lectura({ ...CEDULA, identificacion: '20999888' }),
        ctx139376(),
      );
      expect(d.resultado).toBe('no_coincide');
      expect(estadoPorDiagnostico(d).estado).toBe('observado');
      expect(motivoParaAsegurado(d)).toContain('no coinciden');
    });

    it('mismo número y otro apellido → no_coincide (no se quita «Masculino»)', () => {
      const d = diagnosticar(
        'cedula',
        lectura({ ...CEDULA, nombre: 'PEDRO JOSE', apellido: 'GOMEZ SALAS' }),
        ctx139376(),
      );
      expect(d.resultado).toBe('no_coincide');
      expect(campoDe(d, 'nombre').enPoliza).toBe('Masculino RODRIGUEZ PEÑA');
    });

    it('otro número y otro nombre con «Masculino» y apellido aparte → no_coincide', () => {
      const p = {
        tipoDoc: 'V',
        documento: '13307292',
        nombre: 'Masculino',
        apellido: 'Rodriguez Peña',
      };
      const d = diagnosticar(
        'cedula',
        lectura({
          identificacion: '8111222',
          tipoDoc: 'V',
          nombre: 'ANA',
          apellido: 'LOPEZ',
        }),
        contextoPoliza({ producto: 'rcv', snapshot: { tomador: p } }),
      );
      expect(d.resultado).toBe('no_coincide');
    });
  });

  describe('negativas: nombres y razones sociales legítimos no se tocan', () => {
    it('empresa «Venezolana de Instrumentación…» (18-1-0000140091) con su RIF → coincide por razón social', () => {
      const emp = {
        nombre: 'Venezolana de Instrumentación Mecanica y Electricidad Venime',
        identificacion: 'J-30123456-7',
      };
      const ctx = contextoPoliza({
        producto: 'rcv',
        snapshot: { tomador: emp },
      });
      const d = diagnosticar(
        'cedula',
        lectura({
          rif: 'J-30123456-7',
          tipoDoc: 'J',
          razonSocial:
            'VENEZOLANA DE INSTRUMENTACION MECANICA Y ELECTRICIDAD VENIME, C.A.',
        }),
        ctx,
      );
      expect(d.resultado).toBe('coincide');
      expect(campoDe(d, 'nombre').enPoliza).toBe(emp.nombre);
      expect(d.resumen).not.toContain('no es un nombre');
    });

    it('empresa con otra razón social y el mismo RIF → sigue errada', () => {
      const emp = {
        nombre: 'Femenino Moda CA',
        identificacion: 'J-30123456-7',
      };
      const d = diagnosticar(
        'cedula',
        lectura({
          rif: 'J-30123456-7',
          tipoDoc: 'J',
          razonSocial: 'FERRETERIA EL TORNILLO CA',
        }),
        contextoPoliza({ producto: 'rcv', snapshot: { tomador: emp } }),
      );
      expect(d.resultado).toBe('no_coincide');
      expect(campoDe(d, 'nombre').enPoliza).toBe('Femenino Moda CA');
    });

    it('apellidos reales «Casado» y «Soltero» se comparan como siempre', () => {
      const p = {
        tipoDoc: 'V',
        documento: '9111222',
        nombre: 'Soltero Casado Luis',
      };
      const d = diagnosticar(
        'cedula',
        lectura({
          identificacion: '9111222',
          tipoDoc: 'V',
          nombre: 'LUIS',
          apellido: 'SOLTERO CASADO',
        }),
        contextoPoliza({ producto: 'rcv', snapshot: { tomador: p } }),
      );
      expect(d.resultado).toBe('coincide');
      expect(d.resumen).not.toContain('no es un nombre');
    });
  });

  it('el observado v12 se recompara con lo ya leído (cambio_comparador)', () => {
    const viejo = diagnosticar('cedula', lectura(CEDULA), ctx139376());
    const m = motivoAnalisis(
      {
        estado: 'observado',
        ref: 'a/cedula.jpg',
        decision: 'ia',
        diagnostico: { ...viejo, resultado: 'no_coincide', comparador: 12 },
        analisisRef: 'a/cedula.jpg',
        huellaPoliza: 'x',
        proximoAnalisis: null,
      },
      'x',
      new Date(),
    );
    expect(m).toBe('cambio_comparador');
  });
});
