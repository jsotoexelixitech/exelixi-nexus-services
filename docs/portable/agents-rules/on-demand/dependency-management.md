---
trigger: always_on
---

# Gestión de Dependencias

Antes de instalar un paquete nuevo:

1. ¿Ya existe algo similar en `package.json`? → Reutiliza.
2. ¿Se puede implementar nativamente en < 20 líneas? → Hazlo sin paquete.
3. ¿El paquete tiene mantenimiento activo y sin alertas críticas? → Verifica antes de instalar.

**Clasificación obligatoria:**

- Prod → `dependencies` | Dev/test/build → `devDependencies`
