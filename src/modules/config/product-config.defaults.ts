/**
 * product-config.defaults.ts
 *
 * Configuración por defecto de cada módulo para cada producto.
 * Refleja exactamente cómo funcionan los módulos hoy (hardcoded).
 * Si no hay config en BD para una empresa, se retorna este default.
 */

import { FUNERAL_HEALTH_QUESTIONS_DEFAULT } from './funeral-health-questions.default';

export type Producto = 'rcv' | 'funerario';
export type Modulo = 'ocr' | 'formulario' | 'pagos' | 'emision';

const RCV_DOCS_DDS = [
  { key: 'cedula', activo: true, obligatorio: true, label: 'Cédula de Identidad' },
  { key: 'pasaporte', activo: true, obligatorio: false, label: 'Pasaporte' },
  { key: 'licencia', activo: false, obligatorio: false, label: 'Licencia de Conducir' },
  { key: 'certificado', activo: false, obligatorio: false, label: 'Certificado de Circulación' },
  { key: 'rif', activo: false, obligatorio: false, label: 'RIF' },
];

const RCV_DOCS_DDC = [
  { key: 'cedula', activo: true, obligatorio: true, label: 'Cédula de Identidad' },
  { key: 'licencia', activo: true, obligatorio: true, label: 'Licencia de Conducir' },
  { key: 'certificado', activo: true, obligatorio: true, label: 'Certificado de Circulación' },
  { key: 'pasaporte', activo: false, obligatorio: false, label: 'Pasaporte' },
  { key: 'rif', activo: true, obligatorio: false, label: 'RIF' },
];

// ─── OCR Defaults ─────────────────────────────────────────────────────────────

const OCR_DEFAULT_RCV = {
  documentos: {
    cedula: { activo: true, obligatorio: true, label: 'Cédula de Identidad' },
    licencia: {
      activo: true,
      obligatorio: true,
      label: 'Licencia de Conducir',
    },
    certificado: {
      activo: true,
      obligatorio: true,
      label: 'Certificado de Circulación',
    },
    pasaporte: { activo: false, obligatorio: false, label: 'Pasaporte' },
    rif: { activo: false, obligatorio: false, label: 'RIF' },
  },
  /** Circular SAA-02-1079-2026 — documentos por tipo de diligencia. */
  documentosPorDiligencia: {
    S: RCV_DOCS_DDS,
    C: RCV_DOCS_DDC,
  },
  validarVigencia: true,
};

const OCR_DEFAULT_FUNERARIO = {
  documentos: {
    cedula: { activo: true, obligatorio: true, label: 'Cédula de Identidad' },
    licencia: {
      activo: false,
      obligatorio: false,
      label: 'Licencia de Conducir',
    },
    certificado: {
      activo: false,
      obligatorio: false,
      label: 'Certificado de Circulación',
    },
    rif: { activo: false, obligatorio: false, label: 'RIF' },
  },
};

// ─── Formulario Defaults ──────────────────────────────────────────────────────

const FORMULARIO_DEFAULT_RCV = {
  campos: {
    nombre: { activo: true, obligatorio: true, label: 'Nombre' },
    apellido: { activo: true, obligatorio: true, label: 'Apellido' },
    identificacion: {
      activo: true,
      obligatorio: true,
      label: 'Cédula / Pasaporte',
    },
    sexo: { activo: true, obligatorio: true, label: 'Sexo' },
    estadoCivil: { activo: true, obligatorio: true, label: 'Estado Civil' },
    telefono: { activo: true, obligatorio: true, label: 'Teléfono' },
    email: { activo: true, obligatorio: true, label: 'Correo electrónico' },
    email2: { activo: true, obligatorio: true, label: 'Confirmar correo' },
    fechaNac: { activo: true, obligatorio: true, label: 'Fecha de Nacimiento' },
    estado: { activo: true, obligatorio: true, label: 'Estado' },
    ciudad: { activo: true, obligatorio: true, label: 'Ciudad' },
    direccion: { activo: true, obligatorio: true, label: 'Dirección' },
    cprofesion: {
      activo: true,
      obligatorio: true,
      label: 'Profesión',
      tipo: 'select',
    },
    cactividad: {
      activo: true,
      obligatorio: false,
      label: 'Actividad económica',
      tipo: 'select',
    },
  },
  secciones: {
    asegurado: { activo: true, label: 'Asegurado diferente al tomador' },
    pagador: { activo: true, label: 'Pagador diferente al tomador' },
    beneficiario: { activo: false, label: 'Beneficiario' },
    conductor: { activo: true, label: 'Conductor habitual' },
  },
};

const FORMULARIO_DEFAULT_FUNERARIO = {
  campos: {
    nombre: { activo: true, obligatorio: true, label: 'Nombre' },
    apellido: { activo: true, obligatorio: true, label: 'Apellido' },
    identificacion: {
      activo: true,
      obligatorio: true,
      label: 'Cédula / Pasaporte',
    },
    sexo: { activo: true, obligatorio: true, label: 'Sexo' },
    estadoCivil: { activo: true, obligatorio: true, label: 'Estado Civil' },
    telefono: { activo: true, obligatorio: true, label: 'Teléfono' },
    email: { activo: true, obligatorio: true, label: 'Correo electrónico' },
    email2: { activo: true, obligatorio: true, label: 'Confirmar correo' },
    fechaNac: { activo: true, obligatorio: true, label: 'Fecha de Nacimiento' },
    estado: { activo: true, obligatorio: true, label: 'Estado' },
    ciudad: { activo: true, obligatorio: true, label: 'Ciudad' },
    direccion: { activo: true, obligatorio: false, label: 'Dirección' },
  },
  secciones: {
    asegurados: { activo: true, label: 'Personas aseguradas', maxPersonas: 6 },
    beneficiario: { activo: true, label: 'Beneficiario' },
    frecuencia: {
      activo: true,
      label: 'Frecuencia de pago',
      valores: ['M', 'T', 'S', 'A', 'C'],
    },
  },
};

// ─── Pagos Defaults ───────────────────────────────────────────────────────────

const PAGOS_DEFAULT_RCV = {
  metodos: {
    mobile: { activo: true, label: 'Pago Móvil (Banco Activo)' },
    otp: { activo: true, label: 'Débito OTP (SyPago)' },
    transfer: { activo: false, label: 'Transferencia bancaria' },
  },
};

const PAGOS_DEFAULT_FUNERARIO = {
  metodos: {
    mobile: { activo: true, label: 'Pago Móvil (Banco Activo)' },
    otp: { activo: true, label: 'Débito OTP (SyPago)' },
    transfer: { activo: false, label: 'Transferencia bancaria' },
  },
};

// ─── Emisión Defaults ───────────────────────────────────────────────────────────

const EMISION_DEFAULT_RCV = {
  permitirEstimado: true,
  inspeccionObligatoria: false,
  /** Circular SAA-02-1079-2026 — reglas DDS/DDC post-quote. */
  diligencia: {
    umbralMultiplicador: 300,
    fuenteTc: 'bcv',
    pjSiempreDdc: true,
    planesMasivos: ['2', '3', '4', '5', '6', '7', '8', '9'],
  },
  apiMap: [
    { internalKey: 'plan_code', externalKey: 'plan', transform: 'none' },
    { internalKey: 'frecuencia', externalKey: 'frecuencia', transform: 'none' },
  ],
};

const EMISION_DEFAULT_FUNERARIO = {
  diasCarencia: 30,
  edadMaxima: 70,
  /** Cuestionario de salud editable en el parametrizador de Emisión */
  healthQuestions: FUNERAL_HEALTH_QUESTIONS_DEFAULT,
  /** Preguntas por canal (metadata.canal / cproductor del JWT SSO). */
  healthQuestionsByCanal: {
    default: FUNERAL_HEALTH_QUESTIONS_DEFAULT,
  },
  apiMap: [
    { internalKey: 'plan_code', externalKey: 'plan', transform: 'none' },
    { internalKey: 'frecuencia', externalKey: 'frecuencia', transform: 'none' },
  ],
};

// ─── Mapa de defaults ─────────────────────────────────────────────────────────

export const DEFAULT_CONFIGS: Record<Producto, Record<Modulo, object>> = {
  rcv: {
    ocr: OCR_DEFAULT_RCV,
    formulario: FORMULARIO_DEFAULT_RCV,
    pagos: PAGOS_DEFAULT_RCV,
    emision: EMISION_DEFAULT_RCV,
  },
  funerario: {
    ocr: OCR_DEFAULT_FUNERARIO,
    formulario: FORMULARIO_DEFAULT_FUNERARIO,
    pagos: PAGOS_DEFAULT_FUNERARIO,
    emision: EMISION_DEFAULT_FUNERARIO,
  },
};
