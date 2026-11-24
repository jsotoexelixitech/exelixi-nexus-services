---
trigger: always_on
---

# Variables de Entorno

- **Jamás** hardcodees credenciales, URLs o secretos en el código.
- Al agregar una variable → actualiza `.env.example` con valor ficticio y comentario.
- Accede a `process.env` solo desde un archivo de configuración centralizado.
- Valida variables críticas al inicio del servidor.
- `.env` **nunca** va a Git.
