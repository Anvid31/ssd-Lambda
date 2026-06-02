# Screenshots para documentación

Esta carpeta contiene las capturas de pantalla de las pruebas de AWS Lambda.

## Capturas requeridas:

### 1. lambda-encrypt-test.png

- Captura de la consola de AWS Lambda
- Función: `EncryptFunction`
- Muestra: Evento de prueba y resultado exitoso con el token JWE generado

### 2. lambda-decrypt-test.png

- Captura de la consola de AWS Lambda
- Función: `DecryptFunction`
- Muestra: Evento de prueba con token y resultado exitoso con payload desencriptado

### 3. cloudwatch-logs.png

- Captura de CloudWatch Logs
- Muestra: Logs de ejecución de las funciones Lambda (inicio, procesamiento, fin)
- Incluye: Timestamps y detalles de las invocaciones

### 4. cloudwatch-metrics.png

- Captura de CloudWatch Metrics
- Muestra: Gráficas de métricas como:
  - Invocations (número de invocaciones)
  - Duration (tiempo de ejecución)
  - Errors (errores)
  - Throttles (si aplica)

## Formato recomendado:

- Formato: PNG
- Resolución: 1920x1080 o superior
- Asegurar que el texto sea legible
- Ocultar información sensible (ARNs, IDs de cuenta, tokens reales)
