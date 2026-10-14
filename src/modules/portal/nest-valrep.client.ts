import logger from '../../utils/logger';

type NestEnvelope<T> = { status?: boolean; data?: T };

let cachedBearer: { token: string; exp: number } | null = null;

function nestBaseUrl(): string {
  return (process.env.NEST_API_URL || 'http://127.0.0.1:3002').replace(
    /\/$/,
    '',
  );
}

function nestApiKey(): string {
  return process.env.NEST_API_KEY || process.env.NEST_SERVICE_API_KEY || '';
}

async function getNestBearer(): Promise<string> {
  const apiKey = nestApiKey();
  if (!apiKey) {
    throw new Error('NEST_API_KEY no configurada en nexus-api');
  }
  const now = Date.now();
  if (cachedBearer && cachedBearer.exp > now + 60_000) {
    return cachedBearer.token;
  }
  const url = `${nestBaseUrl()}/api/v1/auth/token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apikey: apiKey }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg =
      typeof body.message === 'string'
        ? body.message
        : `nest token HTTP ${res.status}`;
    throw new Error(msg);
  }
  const token =
    (typeof body.access_token === 'string' && body.access_token) ||
    (typeof body.accessToken === 'string' && body.accessToken) ||
    '';
  if (!token) throw new Error('nest token sin access_token');
  const expiresIn =
    typeof body.expires_in === 'number' ? body.expires_in : 3600;
  cachedBearer = { token, exp: now + expiresIn * 1000 };
  return token;
}

export type ValrepProductosRequest = {
  centidad?: string;
  citem?: string;
  cgestor_in?: string;
  cgestor?: string;
  cproductor?: string;
  /** nest-api: limita al catálogo del gestor (SysIP products/obtener). */
  filtrar_gestor?: boolean;
};

export type ValrepMarketplaceRequest = ValrepProductosRequest & {
  url?: string;
  csub?: string;
};

export type ValrepMarketplaceResult = {
  productos: Record<string, unknown>[];
  cantidad: number;
};

export async function fetchValrepProductosMarketplace(
  body: ValrepMarketplaceRequest,
): Promise<ValrepMarketplaceResult> {
  const bearer = await getNestBearer();
  const url = `${nestBaseUrl()}/api/v1/valrep/productos/marketplace`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const raw = (await res.json().catch(() => ({}))) as NestEnvelope<{
    productos?: Record<string, unknown>[];
    cantidad?: number;
  }>;
  if (!res.ok) {
    const msg =
      typeof (raw as { message?: string }).message === 'string'
        ? (raw as { message: string }).message
        : `valrep/productos/marketplace HTTP ${res.status}`;
    logger.warn(`[portal] marketplace productos: ${msg}`);
    throw new Error(msg);
  }
  const data = raw.data ?? {};
  const productos = Array.isArray(data.productos) ? data.productos : [];
  const cantidad =
    typeof data.cantidad === 'number'
      ? data.cantidad
      : Number(data.cantidad ?? 0);
  return { productos, cantidad: Number.isFinite(cantidad) ? cantidad : 0 };
}

export async function fetchValrepProductos(
  body: ValrepProductosRequest,
): Promise<Record<string, unknown>[]> {
  const bearer = await getNestBearer();
  const url = `${nestBaseUrl()}/api/v1/valrep/productos`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const raw = (await res.json().catch(() => ({}))) as NestEnvelope<
    Record<string, unknown>[]
  >;
  if (!res.ok) {
    const msg =
      typeof (raw as { message?: string }).message === 'string'
        ? (raw as { message: string }).message
        : `valrep/productos HTTP ${res.status}`;
    logger.warn(`[portal] valrep productos: ${msg}`);
    throw new Error(msg);
  }
  const data = raw.data ?? (Array.isArray(raw) ? raw : null);
  if (Array.isArray(data)) return data;
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  return [];
}

export type NestPortalLoginResult = {
  usuario: {
    cusuario?: string | number | null;
    xusuario?: string | null;
    xlogin?: string | null;
    xcorreo?: string | null;
    bcambioclave?: boolean | number | null;
    centidad?: string | null;
    citem?: string | null;
    ccorredor?: string | null;
    cgestor?: string | null;
    ccanalalt?: string | null;
    cscanalalt?: string | null;
  };
  catalogo: {
    centidad: string;
    citem: string;
    cgestor: string | null;
    filtrar_gestor: boolean;
  } | null;
};

/** Error de credenciales Sis2000 (no de token nest). */
export class NestPortalLoginError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * POST nest-api /v1/portal/login (usuarios seusuariosweb, igual que SysIP signIn).
 * Reintenta una vez si el Bearer de servicio expiró.
 */
export async function nestPortalLogin(
  xlogin: string,
  xcontrasena: string,
): Promise<NestPortalLoginResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const bearer = await getNestBearer();
    const res = await fetch(`${nestBaseUrl()}/api/v1/portal/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ xlogin, xcontrasena }),
      signal: AbortSignal.timeout(20_000),
    });
    const raw = (await res
      .json()
      .catch(() => ({}))) as NestEnvelope<NestPortalLoginResult> & {
      message?: string;
    };
    if (res.ok && raw.data?.usuario) return raw.data;

    const msg =
      typeof raw.message === 'string'
        ? raw.message
        : `portal/login HTTP ${res.status}`;
    const credentialError =
      res.status === 401 && /usuario|contraseña|perfil/i.test(msg);
    if (credentialError) throw new NestPortalLoginError(msg, 401);
    if (res.status === 401 && attempt === 0) {
      cachedBearer = null;
      continue;
    }
    logger.warn(`[portal] nest portal/login: ${msg}`);
    throw new NestPortalLoginError(
      res.status === 403
        ? 'La API key de nexus-api no tiene el scope portal:login en nest-api.'
        : 'No se pudo validar el usuario en Sis2000.',
      502,
    );
  }
  throw new NestPortalLoginError(
    'No se pudo validar el usuario en Sis2000.',
    502,
  );
}
