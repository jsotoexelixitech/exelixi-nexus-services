/**
 * Preguntas de salud funerario — default del parametrizador (emisión).
 * Misma forma que modulo-emision/server/src/config/funeralHealthQuestions.js
 */

export type FuneralHealthQuestionType = 'boolean' | 'text' | 'select';

export interface FuneralHealthQuestion {
  id: string;
  type: FuneralHealthQuestionType;
  label: string;
  description?: string;
  required?: boolean;
  /** cplan Sis2000 ("2"…"9") o "*" para todos */
  plans: string[];
  showIf?: { field: string; equals: boolean | string };
  options?: { value: string; label: string }[];
  /** Puntos si responde Sí (boolean) */
  scoreIfTrue?: number;
  /** Puntos si responde No (boolean) */
  scoreIfFalse?: number;
  /** Puntos si el texto tiene contenido */
  scoreIfFilled?: number;
  /** Puntos por valor en select: { "valor": puntos } */
  optionScores?: Record<string, number>;
  /** Bloqueo automático (sigue a revisión técnica) */
  blockIfTrue?: boolean;
  blockIfFalse?: boolean;
  blockReason?: string;
}

const TODOS = ['2', '3', '4', '5', '6', '7', '8', '9'];
const INTERMEDIO_ALTO = ['5', '6', '7', '8', '9'];
const ALTO = ['7', '8', '9'];

export const FUNERAL_HEALTH_QUESTIONS_DEFAULT: FuneralHealthQuestion[] = [
  {
    id: 'fuma',
    type: 'boolean',
    label: '¿Fuma o ha fumado en los últimos 12 meses?',
    description: 'Incluye cigarrillos, tabaco, puros o vapeo.',
    required: true,
    plans: [...TODOS],
    scoreIfTrue: 15,
  },
  {
    id: 'diagnosticoEnfermedad',
    type: 'boolean',
    label: '¿Ha sido diagnosticado con alguna enfermedad grave?',
    description: 'Cáncer, diabetes, hipertensión, cardiopatías, VIH, etc.',
    required: true,
    plans: [...TODOS],
    scoreIfTrue: 40,
  },
  {
    id: 'descripcionEnfermedad',
    type: 'text',
    label: 'Describa la enfermedad diagnosticada',
    description:
      'Indique enfermedad, tratamiento y fecha aproximada del diagnóstico.',
    required: true,
    plans: [...TODOS],
    showIf: { field: 'diagnosticoEnfermedad', equals: true },
    scoreIfFilled: 5,
  },
  {
    id: 'aceptaTerminos',
    type: 'boolean',
    label: 'Acepto los términos y condiciones',
    description:
      'Declaro que la información suministrada es verídica y acepto las condiciones de la póliza.',
    required: true,
    plans: [...TODOS],
    scoreIfFalse: 100,
    blockIfFalse: true,
    blockReason: 'Debe aceptar los términos y condiciones.',
  },
  {
    id: 'consumeAlcohol',
    type: 'boolean',
    label: '¿Consume alcohol de forma habitual?',
    description: 'Más de 2 copas por semana de forma regular.',
    required: true,
    plans: [...INTERMEDIO_ALTO],
    scoreIfTrue: 10,
  },
  {
    id: 'hospitalizacionReciente',
    type: 'boolean',
    label: '¿Ha sido hospitalizado en los últimos 24 meses?',
    required: true,
    plans: [...INTERMEDIO_ALTO],
    scoreIfTrue: 25,
  },
  {
    id: 'motivoHospitalizacion',
    type: 'text',
    label: 'Motivo de la hospitalización',
    required: true,
    plans: [...INTERMEDIO_ALTO],
    showIf: { field: 'hospitalizacionReciente', equals: true },
    scoreIfFilled: 5,
  },
  {
    id: 'medicacionCronica',
    type: 'boolean',
    label: '¿Toma medicación de forma crónica?',
    description: 'Medicamentos prescritos de forma continua.',
    required: true,
    plans: [...ALTO],
    scoreIfTrue: 20,
  },
  {
    id: 'detalleMedicacion',
    type: 'text',
    label: 'Indique los medicamentos',
    required: true,
    plans: [...ALTO],
    showIf: { field: 'medicacionCronica', equals: true },
    scoreIfFilled: 5,
  },
  {
    id: 'deporteRiesgo',
    type: 'boolean',
    label: '¿Practica deportes de alto riesgo?',
    description: 'Paracaidismo, montañismo, buceo, carreras, etc.',
    required: true,
    plans: ['9'],
    scoreIfTrue: 30,
  },
];
