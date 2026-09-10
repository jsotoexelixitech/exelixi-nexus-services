#!/usr/bin/env python3
"""
Parche auth.controller.ts en srv001:
- Resuelve submódulo SSO por puerto en URL o por nombre (cierrelmds sin :5181)
- Renueva tokenExpiresAt al hacer sso-delegate

Uso en srv001:
  cd ~/nexus-api
  python3 patch-sso-cierrelmds-srv001.py
  npm run build && pm2 restart nexus-api
"""
from pathlib import Path

TARGET = Path("src/modules/auth/auth.controller.ts")

HELPER = '''
/** Puertos dev local en submodulo.url (fallback si la URL es solo dominio HTTPS). */
const SSO_TARGET_PORT: Record<string, string> = {
  ocr: '5181',
  formulario: '5182',
  emision: '5183',
  pagos: '5184',
};

/** Nombre en BD cuando la URL ya no incluye el puerto (ej. cierrelmds.exelixitech.com). */
const SSO_TARGET_NAME: Record<string, string> = {
  ocr: 'OCR Documentos',
  formulario: 'Formulario',
  emision: 'Emisión',
  pagos: 'Pagos',
};

/**
 * Resuelve el submódulo destino del SSO: primero por puerto en URL, luego por nombre.
 */
async function findSubmoduloForSsoTarget(target: string) {
  const key = target in SSO_TARGET_PORT ? target : 'ocr';
  const puerto = SSO_TARGET_PORT[key];
  const nameHint = SSO_TARGET_NAME[key] ?? SSO_TARGET_NAME.ocr;
  const select = { id: true, url: true, nombre: true } as const;

  const byPort = await prisma.submodulo.findFirst({
    where: { url: { contains: puerto }, activo: true },
    select,
  });
  if (byPort) return byPort;

  return prisma.submodulo.findFirst({
    where: {
      activo: true,
      url: { not: null },
      nombre: { contains: nameHint, mode: 'insensitive' },
    },
    orderBy: { id: 'asc' },
    select,
  });
}
'''

OLD_LOOKUP = """      // 2. Mapear el target al puerto del submódulo
      const targetPortMap: Record<string, string> = {
        ocr: '5181',
        formulario: '5182',
        emision: '5183',
        pagos: '5184',
      };

      const puerto = targetPortMap[target] ?? targetPortMap['ocr'];

      // 3. Buscar el submódulo cuya URL contenga el puerto correspondiente
      const submodulo = await prisma.submodulo.findFirst({
        where: {
          url: { contains: puerto },
          activo: true,
        },
        select: { id: true, url: true, nombre: true },
      });

      if (!submodulo) {
        return res.status(404).json({
          success: false,
          message: `No se encontró un submódulo activo para el target "${target}".`,
        });
      }

      // 4. Buscar el tenantToken ya generado para empresa + submódulo"""

NEW_LOOKUP = """      // 2. Resolver submódulo por target (puerto en URL o nombre — soporta dominios sin :5181)
      const submodulo = await findSubmoduloForSsoTarget(target);

      if (!submodulo) {
        return res.status(404).json({
          success: false,
          message: `No se encontró un submódulo activo para el target "${target}".`,
        });
      }

      // 3. Buscar el tenantToken ya generado para empresa + submódulo"""

TOKEN_RENEW = """
      // Renovar ventana de sesión al entrar desde app externa (evita "expirada por inactividad")
      const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
      await (
        prisma as unknown as {
          empresaSubmodulo: {
            update: (args: {
              where: { empresaId_submoduloId: { empresaId: number; submoduloId: number } };
              data: { tokenExpiresAt: Date };
            }) => Promise<unknown>;
          };
        }
      ).empresaSubmodulo.update({
        where: {
          empresaId_submoduloId: {
            empresaId: empresa.id,
            submoduloId: submodulo.id,
          },
        },
        data: { tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
      });

"""

def main() -> None:
    if not TARGET.exists():
        raise SystemExit(f"No existe {TARGET}")

    text = TARGET.read_text(encoding="utf-8")

    if "findSubmoduloForSsoTarget" in text:
        print("Ya parcheado — sin cambios")
        return

    backup = TARGET.with_suffix(".ts.bak-cierrelmds")
    backup.write_text(text, encoding="utf-8")
    print(f"Backup: {backup}")

    anchor = "const authService = new AuthService();"
    if anchor not in text:
        raise SystemExit("No se encontró anchor authService")
    text = text.replace(anchor, anchor + HELPER, 1)

    if OLD_LOOKUP not in text:
        raise SystemExit("Bloque de lookup antiguo no encontrado — revisar auth.controller.ts manualmente")
    text = text.replace(OLD_LOOKUP, NEW_LOOKUP, 1)

    inactive_block = """      if (!empresaSubmodulo || !empresaSubmodulo.activo) {
        return res.status(403).json({
          success: false,
          message: `El servicio "${target}" no está activado para esta empresa.`,
        });
      }

      // 5. Generar token dinámico con metadata"""

    if inactive_block not in text:
        raise SystemExit("Bloque tokenExpiresAt no encontrado")
    text = text.replace(
        inactive_block,
        inactive_block.replace(
            "\n      // 5. Generar token dinámico con metadata",
            TOKEN_RENEW + "      // 5. Generar token dinámico con metadata",
        ),
        1,
    )

    TARGET.write_text(text, encoding="utf-8")
    print("OK: parche aplicado — ejecutar: npm run build && pm2 restart nexus-api")


if __name__ == "__main__":
    main()
