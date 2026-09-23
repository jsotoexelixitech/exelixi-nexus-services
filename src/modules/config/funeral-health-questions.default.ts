/**
 * Preguntas de salud funerario — alineadas a Sis2000 producción cproducto 57 · matriz v4.
 */

export type FuneralHealthQuestionType =
  | 'boolean'
  | 'text'
  | 'select'
  | 'multi_select';

export interface FuneralHealthQuestion {
  id: string;
  type: FuneralHealthQuestionType;
  label: string;
  description?: string;
  required?: boolean;
  enabled?: boolean;
  plans: string[];
  showIf?: { field: string; equals: boolean | string };
  options?: { value: string; label: string }[];
  scoreIfTrue?: number;
  scoreIfFalse?: number;
  scoreIfFilled?: number;
  optionScores?: Record<string, number>;
  optionActions?: Record<string, 'reject' | 'refer' | 'score'>;
  blockIfTrue?: boolean;
  blockIfFalse?: boolean;
  blockReason?: string;
}

const TODOS = ['*'];

export const FUNERAL_HEALTH_QUESTIONS_DEFAULT: FuneralHealthQuestion[] = [
  {
    id: 'fuma',
    type: 'boolean',
    label: '¿Es usted fumador?',
    required: true,
    plans: [...TODOS],
    scoreIfTrue: 15,
    scoreIfFalse: 0,
  },
  {
    id: 'cigarrillosPorDia',
    type: 'select',
    label: '¿Cuantos cigarrillos se fuma al día?',
    required: true,
    plans: [...TODOS],
    showIf: { field: 'fuma', equals: true },
    options: [
      { value: 'Bajo', label: '1 a 5' },
      { value: 'Medio', label: '5 a 10' },
      { value: 'fumador violento', label: '10 a 15' },
      { value: 'Alto', label: 'Más de 20' },
    ],
    optionScores: {
      Bajo: 2,
      Medio: 5,
      'fumador violento': 15,
      Alto: 20,
    },
    optionActions: { Alto: 'reject' },
    blockReason:
      'Se han detectado varios factores de riesgo inhabilitantes, no es posible continuar con el proceso.',
  },
  {
    id: 'deportesExtremos',
    type: 'boolean',
    label: '¿Practica deportes extremos o de alto riesgo?',
    required: true,
    plans: [...TODOS],
    scoreIfTrue: 20,
    scoreIfFalse: 0,
  },
  {
    id: 'enfermedadCardiovascular',
    type: 'boolean',
    label: '¿Ha padecido enfermedades cardiovasculares?',
    required: true,
    plans: [...TODOS],
    scoreIfTrue: 0,
    scoreIfFalse: 0,
  },
  {
    id: 'indiqueEnfermedades',
    type: 'multi_select',
    label: 'Indique',
    description: 'Seleccione las condiciones que apliquen.',
    required: true,
    plans: [...TODOS],
    showIf: { field: 'enfermedadCardiovascular', equals: true },
    options: [
      { value: 'HIPCON', label: 'Hipertension controlada' },
      { value: 'SI', label: 'Diábetes' },
      { value: 'inf', label: 'Infarto antiguo' },
      { value: 'diabe01', label: 'diabetes controlada' },
    ],
    optionScores: {
      HIPCON: 8,
      SI: 12,
      inf: 10,
      diabe01: 15,
    },
  },
  {
    id: 'soyVidente',
    type: 'boolean',
    label: 'Soy vidente',
    required: true,
    plans: [...TODOS],
    scoreIfTrue: 5,
    scoreIfFalse: 0,
  },
  {
    id: 'aceptaTerminos',
    type: 'boolean',
    label: 'Acepto los términos y condiciones',
    description:
      'Declaro que la información suministrada es verídica y acepto las condiciones de la póliza.',
    required: true,
    plans: [...TODOS],
    scoreIfFalse: 0,
    blockIfFalse: true,
    blockReason: 'Debe aceptar los términos y condiciones.',
  },
];

export const FUNERAL_HEALTH_SCORING_RULES_DEFAULT = {
  rangesEnabled: true,
  ranges: {
    emit: {
      min: 0,
      max: 25,
      message: 'Puede Emitir Sin Inconvenientes',
    },
    referred: {
      min: 26,
      max: 39,
      message: 'Comunicarse con el corredor de seguro',
    },
    reject: {
      min: 40,
      max: 1000,
      message:
        'Se han detectado varios factores de riesgo inhabilitantes, no es posible continuar con el proceso.',
    },
  },
  concurrence: {
    enabled: false,
    minYesCount: 2,
    extraPoints: 10,
    questionIds: [] as string[],
  },
  reviewerEmails: [] as string[],
};
