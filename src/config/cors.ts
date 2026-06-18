/**
 * cors.ts — Configuración centralizada de CORS para Nexus API
 *
 * Orígenes siempre permitidos (whitelist estática):
 *   - Módulos propios del servidor (192.168.8.120)
 *   - Admin Nexus
 *   - Localhost para desarrollo
 *
 * Orígenes externos (clientes / canales de integración):
 *   - 192.168.10.213 — La Mundial (red local del cliente)
 *
 * Para agregar un nuevo origen permitido, añade la IP o dominio
 * en la sección "Clientes externos" y comenta a quién pertenece.
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
  'http://192.168.10.213:3000', // La Mundial — posible puerto de frontend
  'http://192.168.10.213:8080', // La Mundial — posible puerto alternativo
  'http://192.168.10.213:4200', // La Mundial — posible puerto alternativo
];

/**
 * Construye la lista final de orígenes permitidos combinando:
 * 1. La whitelist estática de arriba
 * 2. Los orígenes declarados en la variable de entorno ALLOWED_ORIGINS
 *    (separados por coma), útil para agregar sin re-deployar.
 */
export function getAllowedOrigins(): string[] {
  const fromEnv = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : [];

  // Unión sin duplicados
  return [...new Set([...STATIC_ALLOWED_ORIGINS, ...fromEnv])];
}

/**
 * Función de validación de origen para usar directamente en la opción `origin` de cors().
 * Permite además peticiones sin Origin (cURL, Postman, server-to-server).
 */
export function corsOriginValidator(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  // Sin Origin = petición server-to-server (cURL, Postman, etc.) — siempre permitida
  if (!origin) {
    callback(null, true);
    return;
  }

  const allowed = getAllowedOrigins();
  if (allowed.includes(origin)) {
    callback(null, true);
  } else {
    callback(new Error(`CORS: Origen no permitido → ${origin}`));
  }
}
