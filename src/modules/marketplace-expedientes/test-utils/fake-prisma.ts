/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Prisma en memoria SOLO para pruebas del monitor de expedientes (sin BD real).
 * Soporta lo que usa el módulo: findUnique/findFirst/findMany/count/create/
 * update/updateMany, filtros in/not/gt/gte/lt/lte/contains, AND/OR, claves
 * compuestas y P2002 en índices únicos.
 */

type Row = Record<string, any>;

const UNIQUES: Record<string, string[][]> = {
  mktExpediente: [['empresaId', 'cnpoliza']],
  mktExpedienteRequisito: [['expedienteId', 'tipo']],
  mktExpedienteEnlace: [['tokenHash']],
  mktExpedienteJobRun: [['job', 'fecha']],
  mktExpedienteConfig: [['clave']],
};

const PK: Record<string, string> = { mktExpedienteConfig: 'clave' };

const DEFAULTS: Record<string, () => Row> = {
  mktExpediente: () => ({
    area: 'desconocida',
    estadoPago: 'pagada',
    estadoDocumental: 'incompleto',
    origen: 'emision',
    etapaEnviada: -1,
    intentos: 0,
    ultimoEnvio: null,
    cadenciaAgotada: false,
    cambiosDetectados: false,
    completadoEn: null,
    emisionId: null,
    cnrecibo: null,
    aseguradoKey: null,
    aseguradoEmail: null,
    createdAt: new Date(),
  }),
  mktExpedienteRequisito: () => ({
    estado: 'faltante',
    motivo: null,
    ref: null,
    origen: null,
    ocrDatos: null,
    ocrConfianza: null,
    recibidoEn: null,
    validadoEn: null,
    validadoPor: null,
    diagnostico: null,
    archivoHash: null,
    huellaPoliza: null,
    analisisRef: null,
    analisisIntentos: 0,
    proximoAnalisis: null,
    decision: null,
  }),
  mktExpedienteEvento: () => ({ createdAt: new Date() }),
  mktExpedienteExclusion: () => ({
    activo: true,
    expedienteId: null,
    empresaId: null,
    cnpoliza: null,
    aseguradoKey: null,
    createdAt: new Date(),
  }),
  mktExpedienteNotificacion: () => ({ createdAt: new Date() }),
  mktExpedienteEnlace: () => ({
    proposito: 'carga_documental',
    usadoEn: null,
    revocadoEn: null,
    accesos: 0,
    createdAt: new Date(),
  }),
  mktExpedienteJobRun: () => ({
    origen: 'auto',
    estado: 'en_curso',
    inicio: new Date(),
  }),
  emision: () => ({ createdAt: new Date(), estado: 'emitida' }),
};

const OPS = new Set([
  'in',
  'notIn',
  'not',
  'equals',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'mode',
  'startsWith',
]);

function isOpObject(v: any): boolean {
  return (
    v &&
    typeof v === 'object' &&
    !(v instanceof Date) &&
    !Array.isArray(v) &&
    Object.keys(v).some((k) => OPS.has(k))
  );
}

function cmpVal(v: any): number | string {
  if (v instanceof Date) return v.getTime();
  return v;
}

function matchValue(v: any, cond: any): boolean {
  if (cond === null) return v == null;
  if (cond instanceof Date)
    return v instanceof Date && v.getTime() === cond.getTime();
  if (isOpObject(cond)) {
    const insensitive = cond.mode === 'insensitive';
    for (const [op, val] of Object.entries(cond)) {
      if (op === 'mode') continue;
      if (op === 'in' && !(val as any[]).includes(v)) return false;
      if (op === 'notIn' && (val as any[]).includes(v)) return false;
      if (op === 'not' && matchValue(v, val)) return false;
      if (op === 'equals' && !matchValue(v, val)) return false;
      if (op === 'gt' && !(v != null && cmpVal(v) > cmpVal(val))) return false;
      if (op === 'gte' && !(v != null && cmpVal(v) >= cmpVal(val)))
        return false;
      if (op === 'lt' && !(v != null && cmpVal(v) < cmpVal(val))) return false;
      if (op === 'lte' && !(v != null && cmpVal(v) <= cmpVal(val)))
        return false;
      if (op === 'contains' || op === 'startsWith') {
        if (v == null) return false;
        const a = insensitive ? String(v).toLowerCase() : String(v);
        const b = insensitive ? String(val).toLowerCase() : String(val);
        if (op === 'contains' ? !a.includes(b) : !a.startsWith(b)) return false;
      }
    }
    return true;
  }
  return v === cond;
}

export function matches(row: Row, where: any): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === 'AND') {
      if (!(cond as any[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (k === 'OR') {
      if (!(cond as any[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === 'NOT') {
      if (matches(row, cond)) return false;
      continue;
    }
    if (
      !(k in row) &&
      k.includes('_') &&
      cond &&
      typeof cond === 'object' &&
      !isOpObject(cond)
    ) {
      if (!matches(row, cond)) return false;
      continue;
    }
    if (!matchValue(row[k], cond)) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: any): Row[] {
  if (!orderBy) return rows;
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const o of list) {
      const [k, dir] = Object.entries(o)[0] as [string, string];
      const av = cmpVal(a[k]);
      const bv = cmpVal(b[k]);
      if (av === bv) continue;
      const r = av > bv ? 1 : -1;
      return dir === 'desc' ? -r : r;
    }
    return 0;
  });
}

function p2002(): Error {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
  });
}

function makeModel(
  name: string,
  store: Map<string, Row[]>,
  seq: Map<string, number>,
) {
  const rows = () => {
    if (!store.has(name)) store.set(name, []);
    return store.get(name)!;
  };
  const pk = PK[name] ?? 'id';
  const checkUnique = (data: Row, exceptPk?: any) => {
    for (const cols of UNIQUES[name] ?? []) {
      if (
        rows().some(
          (r) =>
            r[pk] !== exceptPk &&
            cols.every((c) => r[c] === data[c] && data[c] != null),
        )
      )
        throw p2002();
    }
  };
  const applyData = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (v && typeof v === 'object' && 'increment' in (v as any)) {
        row[k] = (row[k] ?? 0) + (v as any).increment;
      } else {
        row[k] = v;
      }
    }
    row.updatedAt = new Date();
  };
  return {
    findUnique: async ({ where }: any) => {
      const r = rows().find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    findFirst: async ({ where, orderBy }: any = {}) => {
      const r = sortRows(
        rows().filter((x) => matches(x, where)),
        orderBy,
      )[0];
      return r ? { ...r } : null;
    },
    findMany: async ({ where, orderBy, skip, take }: any = {}) => {
      let list = sortRows(
        rows().filter((x) => matches(x, where)),
        orderBy,
      );
      if (skip) list = list.slice(skip);
      if (take != null) list = list.slice(0, take);
      return list.map((r) => ({ ...r }));
    },
    count: async ({ where }: any = {}) =>
      rows().filter((x) => matches(x, where)).length,
    create: async ({ data }: any) => {
      const row: Row = { ...(DEFAULTS[name]?.() ?? {}), ...data };
      if (pk === 'id' && row.id == null) {
        const next = (seq.get(name) ?? 0) + 1;
        seq.set(name, next);
        row.id = next;
      }
      checkUnique(row);
      row.updatedAt = new Date();
      rows().push(row);
      return { ...row };
    },
    update: async ({ where, data }: any) => {
      const r = rows().find((x) => matches(x, where));
      if (!r)
        throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      applyData(r, data);
      return { ...r };
    },
    updateMany: async ({ where, data }: any) => {
      const list = rows().filter((x) => matches(x, where));
      list.forEach((r) => applyData(r, data));
      return { count: list.length };
    },
    deleteMany: async ({ where }: any = {}) => {
      const keep = rows().filter((x) => !matches(x, where));
      const count = rows().length - keep.length;
      store.set(name, keep);
      return { count };
    },
    _rows: rows,
  };
}

export function createFakePrisma() {
  const store = new Map<string, Row[]>();
  const seq = new Map<string, number>();
  const models = [
    'mktExpediente',
    'mktExpedienteRequisito',
    'mktExpedienteEvento',
    'mktExpedienteConfig',
    'mktExpedienteExclusion',
    'mktExpedienteNotificacion',
    'mktExpedienteEnlace',
    'mktExpedienteJobRun',
    'emision',
    'usuarioPortalPerfil',
    'usuario',
    'funeralSubmission',
    'empresa',
  ];
  const client: Record<string, any> = {};
  for (const m of models) client[m] = makeModel(m, store, seq);
  client.$reset = () => {
    store.clear();
    seq.clear();
  };
  return client;
}
