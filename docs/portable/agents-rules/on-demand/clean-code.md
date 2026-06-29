---
trigger: always_on
---

# Código Limpio (SOLID/KISS/DRY)

- **DRY**: Si la lógica se repite ≥2 veces, extráela a una función/helper.
- **KISS**: Early returns sobre anidación profunda. Funciones < 80 líneas.
- **SRP**: Una clase/función = una responsabilidad.
- **Sin hardcoding**: Usa constantes o variables de entorno.
- **Sin imports/vars sin usar**.
- **Sin `console.log`** ni código de debug en entrega final.
