---
trigger: always_on
priority: 1
---

# Protocolo de Navegación de Código (3 pasos — obligatorio en cada solicitud)

## PASO 1 — ctags (costo: 0 tokens adicionales)

El archivo `tags` en la raíz del workspace contiene **52,000+ símbolos** de todos los proyectos.
Busca el símbolo por nombre antes de leer cualquier archivo:

```
grep -m5 "NombreFuncionOClase" c:\Users\javier.soto\Desktop\all-projects\tags
```

Resultado: `símbolo → archivo → línea exacta`. Lee solo esa sección.

## PASO 2 — ripgrep (costo: tokens mínimos)

Cuando no conoces el nombre exacto del símbolo, busca texto en el código:

```
rg -m5 "descripción o endpoint" --glob "!node_modules/**" --glob "!dist/**" --glob "!build/**"
```

Devuelve archivo + línea. Lee solo ese fragmento.

**No usar** MCP `code-rag` / `code_search()` — desactivado por alto consumo de CPU/RAM.

## PASO 3 — Lectura directa (último recurso)

Solo si los pasos 1 y 2 no identificaron el archivo:

- Máx. 2 archivos por tarea.
- Nunca leas: `node_modules/` · `dist/` · `build/` · `.git/` · `dev-dist/`.

---

**Regla de actualización:** Después de cambios grandes en código, ejecutar:

```
.\update-tags.ps1  (en la raíz del workspace)
```
