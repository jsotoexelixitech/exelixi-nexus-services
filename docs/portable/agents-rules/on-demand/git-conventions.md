---
trigger: always_on
---

# Conventional Commits (en español)

**Formato:** `<tipo>(<ámbito>): <descripción en imperativo>`

| Tipo       | Uso                       |
| ---------- | ------------------------- |
| `feat`     | Nueva funcionalidad       |
| `fix`      | Corrección de bug         |
| `refactor` | Cambio sin feature ni fix |
| `docs`     | Solo documentación        |
| `chore`    | Mantenimiento/deps        |
| `test`     | Pruebas                   |
| `style`    | Formato visual            |

**Reglas:** máx. 72 chars en línea 1 · sin punto final · verbo en imperativo · commits atómicos.

**Ejemplo:** `feat(auth): implementar validación JWT`
