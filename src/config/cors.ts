/**
 * cors.ts — Configuración centralizada de CORS para Nexus API
 *
 * Orígenes siempre permitidos (whitelist estática):
 *   - Módulos propios del servidor (192.168.8.120)
 *   - Admin Nexus
 *   - Localhost para desarrollo
 *   - QASys2000 / dominios La Mundial
 *
 * Orígenes adicionales vía ALLOWED_ORIGINS en .env (separados por coma).
 */

/** Orígenes siempre permitidos independientemente del entorno */
const STATIC_ALLOWED_ORIGINS: string[] = [
  // --- Módulos internos (servidor srv001) ---
  'http://192.168.8.120:5180', // RCV / Auto-Casa
  'http://192.168.8.120:5181', // OCR Documentos
  'http://192.168.8.120:5182', // Formulario
  'http://192.168.8.120:5183', // Emisión
  'http://192.168.8.120:5184', // Pagos
  'http://192.168.8.120:5200', // Nexus Admin
  'http://192.168.8.120:3092', // Nexus API (self)

  // --- Desarrollo local ---
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
  'http://localhost:3000',
  'http://localhost:4000',
  'http://localhost:4200', // Angular default port

  // --- Clientes externos / canales de integración ---
  'http://192.168.10.213', // La Mundial — red local del cliente
  'http://192.168.10.213:3000',
  'http://192.168.10.213:8080',
  'http://192.168.10.213:4200',

  // --- QASys2000 / SysIP (La Mundial) ---
  'http://192.168.8.120:91', // QASys2000 — ambiente interno srv001 (Apache)
  'https://qasys2000.lamundialdeseguros.com',
  'http://qasys2000.lamundialdeseguros.com',

  // --- srv001 HTTPS sslip.io (frontends) ---
  'https://nexus-admin.200-75-131-138.sslip.io',
  'https://ocr.200-75-131-138.sslip.io',
  'https://form.200-75-131-138.sslip.io',
  'https://emision.200-75-131-138.sslip.io',
  'https://pagos.200-75-131-138.sslip.io',
  'https://rcv.200-75-131-138.sslip.io',
];

/**
 * Sufijos de hostname confiables (subdominios de La Mundial).
 * Ej.: qasys2000.lamundialdeseguros.com, sys2000.lamundialdeseguros.com
 */
const TRUSTED_HOST_SUFFIXES: string[] = [
  'lamundialdeseguros.com',
  // srv001 dev HTTPS vía sslip.io (Caddy + Let's Encrypt)
  '200-75-131-138.sslip.io',
];

/** Cabeceras permitidas en preflight (Angular envía x-api-key) */
export const CORS_ALLOWED_HEADERS: string[] = [
  'Content-Type',
  'Authorization',
  'x-api-key',
  'X-Requested-With',
  'Accept',
  'Origin',
];

export const CORS_ALLOWED_METHODS: string[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
];

/**
 * Construye la lista final de orígenes permitidos combinando whitelist estática + ALLOWED_ORIGINS.
 */
export function getAllowedOrigins(): string[] {
  const fromEnv = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : [];

  return [...new Set([...STATIC_ALLOWED_ORIGINS, ...fromEnv])];
}

/**
 * Verifica si un hostname coincide con un sufijo confiable (sin falsos positivos).
 */
function hostnameMatchesSuffix(hostname: string, suffix: string): boolean {
  const base = suffix.startsWith('.') ? suffix.slice(1) : suffix;
  return hostname === base || hostname.endsWith(`.${base}`);
}

/**
 * Determina si un origen está permitido (lista exacta o dominio La Mundial).
 */
export function isOriginAllowed(origin: string): boolean {
  if (getAllowedOrigins().includes(origin)) {
    return true;
  }

  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'https:' && protocol !== 'http:') {
      return false;
    }
    return TRUSTED_HOST_SUFFIXES.some((suffix) =>
      hostnameMatchesSuffix(hostname, suffix),
    );
  } catch {
    return false;
  }
}

/**
 * Validador de origen para express cors().
 * Permite peticiones sin Origin (cURL, Postman, server-to-server).
 */
export function corsOriginValidator(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin) {
    callback(null, true);
    return;
  }

  if (isOriginAllowed(origin)) {
    callback(null, true);
  } else {
    // null + false → preflight responde sin CORS (no dispara error 500)
    callback(null, false);
  }
}
