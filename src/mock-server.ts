/**
 * mock-server.ts
 *
 * Servidor Express sin base de datos — útil para probar el Panel de Control
 * (activación / desactivación de módulos) sin necesitar PostgreSQL.
 *
 * Arrancar con:   npx tsx src/mock-server.ts
 *
 * Todo el estado vive en memoria (se reinicia al parar el proceso).
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';

const app  = express();
const PORT = parseInt(process.env.PORT ?? '3091', 10);
const API_KEY = process.env.API_KEY ?? 'bd7c4671ebcc7e9c23cd51fa75df9f57';

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '5mb' }));

// ── API Key guard (sólo para /api/admin/*; el flow es público para módulos) ──
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  // Endpoints públicos del bridge entre módulos (no requieren API key)
  if (req.path.startsWith('/flow/')) return next();
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    res.status(401).json({ success: false, message: 'API Key inválida.' });
    return;
  }
  next();
});

// ── Datos mock ────────────────────────────────────────────────────────────────

const MODULOS = [
  {
    id: 1, nombre: 'OCR — Lectura de Documentos', activo: true,
    url: 'http://localhost:5181',
    orden: 1,
    submodulos: [
      { id: 11, nombre: 'Carga de Cédula',      activo: true, moduloId: 1 },
      { id: 12, nombre: 'Carga de Certificado', activo: true, moduloId: 1 },
    ],
  },
  {
    id: 2, nombre: 'Formulario — Datos del Tomador', activo: true,
    url: 'http://localhost:5182',
    orden: 2,
    submodulos: [
      { id: 21, nombre: 'Datos Personales',   activo: true, moduloId: 2 },
      { id: 22, nombre: 'Datos del Vehículo', activo: true, moduloId: 2 },
    ],
  },
  {
    id: 3, nombre: 'Emisión — Selección de Plan', activo: true,
    url: 'http://localhost:5183',
    orden: 3,
    submodulos: [
      { id: 31, nombre: 'Cotización',         activo: true, moduloId: 3 },
      { id: 32, nombre: 'Selección de Plan',  activo: true, moduloId: 3 },
    ],
  },
  {
    id: 4, nombre: 'Pagos — Procesamiento de Pago', activo: true,
    url: 'http://localhost:5184',
    orden: 4,
    submodulos: [
      { id: 41, nombre: 'Pago Móvil (Meritop)', activo: true, moduloId: 4 },
      { id: 42, nombre: 'Débito OTP (SyPago)',  activo: true, moduloId: 4 },
    ],
  },
];

// URL del flujo completo (todos los módulos juntos)
const FULL_FLOW_URL = 'http://localhost:5180';

interface EmpresaModuloState {
  activo: boolean;
  submodulos: Record<number, boolean>; // submoduloId → activo
}

// Estado en memoria: empresa 1 tiene todos los módulos activos al inicio
const empresaModulosState: Record<number, EmpresaModuloState> = {};

function initState() {
  for (const m of MODULOS) {
    empresaModulosState[m.id] = {
      activo: true,
      submodulos: Object.fromEntries(m.submodulos.map(s => [s.id, true])),
    };
  }
}
initState();

const EMPRESA = { id: 1, nombre: 'Exelixi Technologies', rif: 'J-12345678-9', activo: true, tipo: 'SaaS Provider' };

const MOCK_TOKEN = 'mock-dev-token-no-expira';
const MOCK_USER  = {
  id: 1, nombre: 'Admin', email: 'admin@exelixi.com',
  role: 'SUPERADMIN', empresaId: 1,
  empresa: { id: 1, nombre: 'Exelixi Technologies', rif: 'J-12345678-9' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildCompanyDetail() {
  const modulos = MODULOS.map(m => {
    const state = empresaModulosState[m.id];
    return {
      id: m.id,
      empresaId: EMPRESA.id,
      moduloId: m.id,
      token: `mock-token-${m.id}`,
      activo: state.activo,
      createdAt: new Date().toISOString(),
      modulo: {
        ...m,
        submodulos: m.submodulos.map(s => ({
          ...s,
          activoEmpresa: state.submodulos[s.id] ?? false,
        })),
      },
    };
  });
  return { ...EMPRESA, modulos };
}

// ── Rutas ─────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), env: 'mock' });
});

// Auth
app.post('/api/auth/login', (_req, res) => {
  res.json({ success: true, data: { token: MOCK_TOKEN, user: MOCK_USER } });
});

app.get('/api/auth/me', (_req, res) => {
  res.json({ success: true, data: { user: MOCK_USER, empresa: MOCK_USER.empresa, permissions: [] } });
});

// Empresas
app.get('/api/companies', (_req, res) => {
  res.json({ success: true, data: [{ ...EMPRESA, modulos: [] }] });
});

app.get('/api/companies/:id', (_req, res) => {
  res.json({ success: true, data: buildCompanyDetail() });
});

app.put('/api/companies/:id', (req, res) => {
  Object.assign(EMPRESA, req.body);
  res.json({ success: true, data: EMPRESA });
});

// Toggle módulo (cascada a submódulos)
app.post('/api/companies/toggle-module', (req: Request, res: Response) => {
  const { moduloId, active } = req.body as { empresaId: number; moduloId: number; active: boolean };
  const state = empresaModulosState[moduloId];
  if (!state) {
    res.status(404).json({ success: false, message: 'Módulo no encontrado.' });
    return;
  }

  state.activo = active;
  // Cascada: todos los submódulos siguen al módulo padre
  for (const subId of Object.keys(state.submodulos)) {
    state.submodulos[Number(subId)] = active;
  }

  const mod = MODULOS.find(m => m.id === moduloId);
  console.log(`[MOCK] Módulo "${mod?.nombre}" → ${active ? 'ACTIVADO ✅' : 'DESACTIVADO ❌'} (${Object.keys(state.submodulos).length} submódulos en cascada)`);

  res.json({
    success: true,
    message: `Módulo ${active ? 'activado' : 'desactivado'} exitosamente`,
    data: { moduloId, activo: active, submodulosAfectados: Object.keys(state.submodulos).length },
  });
});

// Toggle submódulo individual
app.post('/api/companies/toggle-submodule', (req: Request, res: Response) => {
  const { moduloId, submoduloId, active } = req.body as { empresaId: number; moduloId?: number; submoduloId: number; active: boolean };

  // Buscar en qué módulo está este submódulo
  let parentState: EmpresaModuloState | undefined;
  let subNombre = '';
  for (const m of MODULOS) {
    const sub = m.submodulos.find(s => s.id === submoduloId);
    if (sub) {
      parentState = empresaModulosState[m.id];
      subNombre = sub.nombre;
      break;
    }
  }

  if (!parentState) {
    res.status(404).json({ success: false, message: 'Submódulo no encontrado.' });
    return;
  }

  parentState.submodulos[submoduloId] = active;
  console.log(`[MOCK] Submódulo "${subNombre}" → ${active ? 'ACTIVADO ✅' : 'DESACTIVADO ❌'}`);

  res.json({
    success: true,
    message: `Submódulo ${active ? 'activado' : 'desactivado'} exitosamente`,
    data: { submoduloId, activo: active },
  });
});

// Módulos catálogo
app.get('/api/modules', (_req, res) => {
  const activos = MODULOS.filter(m => m.activo);
  res.json({ success: true, data: activos });
});

app.get('/api/modules/active', (_req, res) => {
  const activos = MODULOS.filter(m => empresaModulosState[m.id]?.activo);
  res.json({ success: true, data: activos });
});

app.get('/api/modules/all', (_req, res) => {
  res.json({ success: true, data: MODULOS });
});

// Info de red
app.get('/api/modules/network-info', (_req, res) => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let networkIp = '';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        networkIp = net.address;
        break;
      }
    }
    if (networkIp) break;
  }
  res.json({ success: true, data: { networkIp } });
});

// Estado del flujo completo
app.get('/api/modules/flow-status', (_req, res) => {
  const allActive = MODULOS.every(m => empresaModulosState[m.id]?.activo);
  res.json({
    success: true,
    data: {
      allModulesActive: allActive,
      fullFlowUrl: FULL_FLOW_URL,
      modules: MODULOS.map(m => ({
        id: m.id,
        nombre: m.nombre,
        orden: m.orden,
        url: m.url,
        activo: empresaModulosState[m.id]?.activo ?? false,
      })),
    },
  });
});

// ── Bridge entre módulos seccionados ─────────────────────────────────────────
// Permite encadenar OCR → Formulario → Emisión → Pagos compartiendo estado
// vía un sessionId común. Los frontends de cada módulo lo consumen al iniciar
// (rehidratación) y al terminar (persistencia + redirect al siguiente módulo).
//
// Estado: en memoria (proceso). Se reinicia al reiniciar el mock-server.

interface FlowSession {
  sid: string;
  createdAt: number;
  updatedAt: number;
  current: number;        // orden del módulo actual (1..4)
  history: number[];      // órdenes ya completados
  data: Record<string, unknown>;  // estado wizard compartido
}

const FLOW_SESSIONS = new Map<string, FlowSession>();
const FLOW_TTL_MS   = 60 * 60 * 1000;   // 1 hora

function newSid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Limpieza periódica de sesiones expiradas
setInterval(() => {
  const cutoff = Date.now() - FLOW_TTL_MS;
  for (const [sid, s] of FLOW_SESSIONS) {
    if (s.updatedAt < cutoff) FLOW_SESSIONS.delete(sid);
  }
}, 5 * 60 * 1000);

function activeModulesSorted() {
  return MODULOS
    .filter(m => empresaModulosState[m.id]?.activo)
    .sort((a, b) => a.orden - b.orden);
}

function nextModuleAfter(orden: number) {
  const list = activeModulesSorted();
  const idx  = list.findIndex(m => m.orden === orden);
  return idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
}

// Inicia un nuevo flujo y devuelve la URL del primer módulo activo
app.post('/api/flow/start', (_req, res) => {
  const list = activeModulesSorted();
  if (list.length === 0) {
    res.status(400).json({ success: false, message: 'No hay módulos activos.' });
    return;
  }
  const first = list[0];
  const sid   = newSid();
  FLOW_SESSIONS.set(sid, {
    sid,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    current:   first.orden,
    history:   [],
    data:      {},
  });
  res.json({
    success: true,
    data: {
      sid,
      firstUrl:    `${first.url}/?sid=${sid}`,
      firstModule: { id: first.id, nombre: first.nombre, orden: first.orden, url: first.url },
      totalActive: list.length,
    },
  });
});

// Lee el estado completo del flujo (rehidratación)
app.get('/api/flow/session/:sid', (req, res) => {
  const s = FLOW_SESSIONS.get(req.params.sid);
  if (!s) { res.status(404).json({ success: false, message: 'Sesión no encontrada o expirada.' }); return; }
  s.updatedAt = Date.now();
  const list = activeModulesSorted();
  const cur  = list.find(m => m.orden === s.current);
  res.json({
    success: true,
    data: {
      sid: s.sid,
      current: s.current,
      currentModule: cur ? { id: cur.id, nombre: cur.nombre, url: cur.url, orden: cur.orden } : null,
      history: s.history,
      data: s.data,
      totalActive: list.length,
    },
  });
});

// Guarda parcialmente datos del wizard (merge shallow + deep keys)
app.post('/api/flow/save/:sid', (req, res) => {
  const s = FLOW_SESSIONS.get(req.params.sid);
  if (!s) { res.status(404).json({ success: false, message: 'Sesión no encontrada.' }); return; }
  const patch = (req.body && typeof req.body === 'object') ? req.body : {};
  s.data       = { ...s.data, ...patch };
  s.updatedAt  = Date.now();
  res.json({ success: true, data: { sid: s.sid, savedKeys: Object.keys(patch) } });
});

// Marca el módulo actual como completado y devuelve la URL del siguiente
app.post('/api/flow/done/:sid', (req, res) => {
  const s = FLOW_SESSIONS.get(req.params.sid);
  if (!s) { res.status(404).json({ success: false, message: 'Sesión no encontrada.' }); return; }
  const fromOrden = Number(req.query.from ?? s.current);
  if (Number.isFinite(fromOrden) && !s.history.includes(fromOrden)) {
    s.history.push(fromOrden);
  }
  // Si vino payload extra, lo guardamos
  if (req.body && typeof req.body === 'object') {
    s.data = { ...s.data, ...req.body };
  }
  const next = nextModuleAfter(fromOrden);
  if (next) {
    s.current   = next.orden;
    s.updatedAt = Date.now();
    res.json({
      success: true,
      data: {
        finished: false,
        nextUrl: `${next.url}/?sid=${s.sid}`,
        nextModule: { id: next.id, nombre: next.nombre, orden: next.orden, url: next.url },
      },
    });
    return;
  }
  // No hay siguiente — flujo completado
  s.updatedAt = Date.now();
  res.json({ success: true, data: { finished: true, sid: s.sid } });
});

// Roles, Usuarios (stubs vacíos para que el dashboard no falle)
app.get('/api/roles',  (_req, res) => res.json({ success: true, data: [] }));
app.get('/api/users',  (_req, res) => res.json({ success: true, data: [] }));

// 404 catch-all API
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'Ruta no implementada en mock.' });
});

// ── Arranque ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────────┐');
  console.log('  │   MOCK SERVER — Sin DB, sin auth real           │');
  console.log(`  │   http://localhost:${PORT}                          │`);
  console.log(`  │   API Key: ${API_KEY}  │`);
  console.log('  │                                                 │');
  console.log('  │   Login:   admin@exelixi.com / cualquier pass  │');
  console.log('  │   Panel:   http://localhost:5200/panel          │');
  console.log('  └─────────────────────────────────────────────────┘');
  console.log('');
});
