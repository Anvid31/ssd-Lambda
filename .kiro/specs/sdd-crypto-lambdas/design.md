# Documento de Diseño Técnico

## sdd-crypto-lambdas

---

## Overview

El proyecto **sdd-crypto-lambdas** implementa un mecanismo de cifrado de doble capa para payloads JSON mediante dos funciones AWS Lambda. El flujo combina **firma digital** (JWT/RS256) con **cifrado asimétrico** (JWE/RSA-OAEP+A256GCM) usando la librería `jose`, gestionando las claves RSA a través de AWS Secrets Manager para nunca exponer material criptográfico en el código fuente ni en variables de entorno en texto plano.

La arquitectura garantiza tres propiedades de seguridad fundamentales:
- **Confidencialidad**: El contenido del payload sólo puede ser leído por quien posea la clave privada RSA de descifrado.
- **Autenticidad**: La firma RS256 garantiza que el payload fue generado por el poseedor de la clave privada de firma.
- **Integridad**: Cualquier alteración del token invalida tanto el cifrado AES-GCM (tag de autenticación) como la firma RS256.


---

## Architecture

### Diagrama de Componentes (Alto Nivel)

```mermaid
graph TD
    Client["Cliente HTTP<br/>(sistema externo)"]

    subgraph AWS Cloud
        APIGW["API Gateway<br/>CryptoApi (REGIONAL)<br/>POST /encrypt<br/>POST /decrypt"]

        subgraph Lambda EncryptFunction
            EH["handler.js<br/>(encrypt)"]
        end

        subgraph Lambda DecryptFunction
            DH["handler.js<br/>(decrypt)"]
        end

        CM["CryptoModule<br/>lambdas/shared/crypto.js<br/>(jose)"]
        SM["AWS Secrets Manager<br/>sdd-crypto/private-key<br/>sdd-crypto/public-key"]
        CW["CloudWatch Logs"]
    end

    Client -->|"POST /encrypt { payload }"| APIGW
    Client -->|"POST /decrypt { token }"| APIGW
    APIGW -->|"event"| EH
    APIGW -->|"event"| DH
    EH -->|"signAndEncrypt()"| CM
    DH -->|"decryptAndVerify()"| CM
    EH -->|"getSecret(ARN)"| CM
    DH -->|"getSecret(ARN)"| CM
    CM -->|"GetSecretValue"| SM
    SM -->|"SecretString (PEM)"| CM
    EH -->|"console.error"| CW
    DH -->|"console.error"| CW
    EH -->|"HTTP 200 { token }"| Client
    DH -->|"HTTP 200 { payload }"| Client
```

### Flujo de Datos — Cifrado (POST /encrypt)

```mermaid
sequenceDiagram
    participant C as Cliente
    participant AG as API Gateway
    participant E as EncryptFunction
    participant CM as CryptoModule
    participant SM as Secrets Manager

    C->>AG: POST /encrypt<br/>{ "userId": "123", "role": "admin" }
    AG->>E: event.body = '{"userId":"123","role":"admin"}'
    E->>E: Validar env vars (PRIVATE_KEY_SECRET_ARN, PUBLIC_KEY_SECRET_ARN)
    E->>E: Parsear y validar body (objeto no vacío, no array)
    par Recuperar claves en paralelo
        E->>SM: GetSecretValue(PRIVATE_KEY_SECRET_ARN)
        SM-->>E: SecretString (PEM clave privada)
    and
        E->>SM: GetSecretValue(PUBLIC_KEY_SECRET_ARN)
        SM-->>E: SecretString (PEM clave pública)
    end
    E->>CM: signAndEncrypt(payload, privatePem, publicPem)
    CM->>CM: importPKCS8(privatePem, "RS256") → signingKey
    CM->>CM: importSPKI(publicPem, "RSA-OAEP") → encryptionKey
    CM->>CM: SignJWT(payload).setExpiration("5m").sign(signingKey) → jwtString
    CM->>CM: CompactEncrypt(jwt).setHeader({alg:"RSA-OAEP", enc:"A256GCM"}).encrypt(encKey) → jwe
    CM-->>E: jweToken (5 segmentos separados por '.')
    E-->>AG: HTTP 200 { "token": "<jwe>" }
    AG-->>C: HTTP 200 { "token": "<jwe>" }
```


### Flujo de Datos — Descifrado (POST /decrypt)

```mermaid
sequenceDiagram
    participant C as Cliente
    participant AG as API Gateway
    participant D as DecryptFunction
    participant CM as CryptoModule
    participant SM as Secrets Manager

    C->>AG: POST /decrypt<br/>{ "token": "<jwe>" }
    AG->>D: event.body = '{"token":"<jwe>"}'
    D->>D: Validar env vars
    D->>D: Parsear body y validar campo token (string no vacío)
    par Recuperar claves en paralelo
        D->>SM: GetSecretValue(PRIVATE_KEY_SECRET_ARN)
        SM-->>D: SecretString (PEM clave privada)
    and
        D->>SM: GetSecretValue(PUBLIC_KEY_SECRET_ARN)
        SM-->>D: SecretString (PEM clave pública)
    end
    D->>CM: decryptAndVerify(jweToken, privatePem, publicPem)
    CM->>CM: importPKCS8(privatePem, "RSA-OAEP") → decryptionKey
    CM->>CM: importSPKI(publicPem, "RS256") → verificationKey
    CM->>CM: compactDecrypt(jwe, decryptionKey) → { plaintext: Buffer }
    CM->>CM: Buffer.toString("utf-8") → jwtString
    CM->>CM: jwtVerify(jwt, verificationKey, {algorithms:["RS256"]}) → { payload }
    CM-->>D: payload (claims JWT + iat + exp)
    D-->>AG: HTTP 200 { "payload": { ... } }
    AG-->>C: HTTP 200 { "payload": { ... } }
```

---

## Components and Interfaces

### CryptoModule (`lambdas/shared/crypto.js`)

El módulo compartido es el núcleo criptográfico. Expone tres funciones puras (excepto por la dependencia en SecretsManager):

#### `getSecret(secretArn: string): Promise<string>`

```
Parámetros:
  secretArn  — ARN del secreto en Secrets Manager, o el contenido PEM directamente
               (solo para entornos de prueba, si contiene "-----BEGIN")

Retorna:
  Promise<string>  — Contenido PEM de la clave RSA

Lanza:
  Error("Invalid secret reference")      — si secretArn es null, undefined, o no es string
  Error("Secret <ARN> has no SecretString") — si el secreto existe pero almacena datos binarios
  Error("Failed to retrieve secret <ARN>: <detalle>") — si la llamada a SM falla
```

**Lógica de bifurcación:**
1. Si `secretArn` no es string válido → lanzar error de validación inmediatamente.
2. Si `secretArn` contiene `"-----BEGIN"` → devolver el valor directamente (bypass para tests).
3. En cualquier otro caso → llamar a `GetSecretValue` de Secrets Manager y devolver `SecretString`.

#### `signAndEncrypt(payload: object, privateKeyPem: string, publicKeyPem: string): Promise<string>`

```
Parámetros:
  payload       — Objeto JavaScript plano y serializable a JSON
  privateKeyPem — Clave privada RSA en formato PKCS8 PEM (para firma RS256)
  publicKeyPem  — Clave pública RSA en formato SPKI PEM (para cifrado RSA-OAEP)

Retorna:
  Promise<string>  — Token JWE en formato compacto (5 segmentos separados por '.')
                     Estructura: header.encryptedKey.iv.ciphertext.tag

Lanza:
  Error  — si las claves son inválidas, el payload no es serializable, o falla la operación criptográfica
```

**Pasos internos:**
1. `importPKCS8(privateKeyPem, "RS256")` → `signingKey`
2. `importSPKI(publicKeyPem, "RSA-OAEP")` → `encryptionKey`
3. `new SignJWT(payload).setProtectedHeader({alg:"RS256", typ:"JWT"}).setIssuedAt().setExpirationTime("5m").sign(signingKey)` → `jwtString`
4. `new CompactEncrypt(Buffer.from(jwtString)).setProtectedHeader({alg:"RSA-OAEP", enc:"A256GCM"}).encrypt(encryptionKey)` → `jweToken`

**Claims JWT generados:**
- `iat` (issued at): Unix timestamp del momento de la firma
- `exp` (expiration): `iat + 300` (exactamente 5 minutos)


#### `decryptAndVerify(jweToken: string, privateKeyPem: string, publicKeyPem: string): Promise<object>`

```
Parámetros:
  jweToken      — Token JWE en formato compacto (5 segmentos separados por '.')
  privateKeyPem — Clave privada RSA en formato PKCS8 PEM (para descifrado RSA-OAEP)
  publicKeyPem  — Clave pública RSA en formato SPKI PEM (para verificación RS256)

Retorna:
  Promise<object>  — Claims del JWT verificado:
                     { ...camposOriginales, iat: number, exp: number }

Lanza:
  Error  — si el JWE está malformado, la firma es inválida, el token ha expirado,
           o las claves son incorrectas
```

**Pasos internos:**
1. `importPKCS8(privateKeyPem, "RSA-OAEP")` → `decryptionKey`
2. `importSPKI(publicKeyPem, "RS256")` → `verificationKey`
3. `compactDecrypt(jweToken, decryptionKey)` → `{ plaintext: Uint8Array }`
4. `Buffer.from(plaintext).toString("utf-8")` → `jwtString`
5. `jwtVerify(jwtString, verificationKey, {algorithms: ["RS256"]})` → `{ payload }`

**Verificaciones automáticas de `jwtVerify` (librería `jose`):**
- Algoritmo de firma = `RS256` (enforced por parámetro `algorithms`)
- Claim `exp` no expirado respecto al tiempo de sistema
- Integridad de la firma RSASSA-PKCS1-v1_5

### EncryptFunction Handler (`lambdas/encrypt/handler.js`)

```
Entrada (API Gateway event):
  event.body — string JSON serializado o objeto pre-parseado
               Debe ser un objeto JSON plano (no array, no null, no primitivo)

Salida HTTP:
  200 { "token": "<jwe>" }                          — éxito
  400 { "error": "Invalid JSON body" }              — JSON malformado
  400 { "error": "Payload must be a JSON object" }  — tipo incorrecto
  500 { "error": "Missing required environment variables" } — env vars ausentes
  500 { "error": "Encryption failed" }              — error de SM o criptografía
```

**Variables de entorno requeridas:**
- `PRIVATE_KEY_SECRET_ARN` — ARN del secreto de clave privada
- `PUBLIC_KEY_SECRET_ARN` — ARN del secreto de clave pública

**Flujo de validación (orden de precedencia):**
1. Verificar env vars → 500 si ausentes
2. Parsear `event.body` → 400 si JSON inválido
3. Verificar que el payload es objeto plano (no array, no null, no primitivo) → 400 si inválido
4. Recuperar claves + ejecutar criptografía → 500 si falla, 200 si éxito

### DecryptFunction Handler (`lambdas/decrypt/handler.js`)

```
Entrada (API Gateway event):
  event.body — string JSON serializado o objeto pre-parseado
               Debe contener campo "token" de tipo string no vacío

Salida HTTP:
  200 { "payload": { ...claims } }                          — éxito
  400 { "error": "Invalid JSON body" }                      — JSON malformado
  400 { "error": "Missing or invalid \"token\" field" }     — token ausente o inválido
  500 { "error": "Missing required environment variables" } — env vars ausentes
  500 { "error": "Decryption failed" }                      — error de SM o criptografía
```

**Flujo de validación (orden de precedencia):**
1. Verificar env vars → 500 si ausentes
2. Parsear `event.body` → 400 si JSON inválido
3. Verificar que `body.token` es string no vacío/whitespace → 400 si inválido
4. Recuperar claves + ejecutar descifrado/verificación → 500 si falla, 200 si éxito

---

## Data Models

### Payload de Entrada — EncryptFunction

```json
{
  "userId": "string",
  "role": "string",
  "...": "cualquier campo JSON serializable"
}
```

Restricción: debe ser un objeto JSON plano. Arrays, primitivos y null son rechazados con HTTP 400.

### Payload de Salida — EncryptFunction

```json
{
  "token": "eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00ifQ...."
}
```

El token JWE en formato compacto contiene exactamente 5 segmentos separados por `.`:
```
<header_b64url>.<encryptedKey_b64url>.<iv_b64url>.<ciphertext_b64url>.<tag_b64url>
```


### Payload de Entrada — DecryptFunction

```json
{
  "token": "eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00ifQ...."
}
```

### Payload de Salida — DecryptFunction

```json
{
  "payload": {
    "userId": "string",
    "role": "string",
    "iat": 1712345678,
    "exp": 1712345978
  }
}
```

El objeto `payload` incluye todos los campos del payload original más los claims `iat` y `exp` añadidos por `SignJWT`. El delta `exp - iat` es exactamente `300` segundos.

### Claims JWT Internos

| Campo | Tipo   | Descripción                                      |
|-------|--------|--------------------------------------------------|
| `iat` | number | Unix timestamp del momento de la firma           |
| `exp` | number | `iat + 300` (expiración en 5 minutos)            |
| `*`   | any    | Campos del payload original (sobrescriben si coinciden con claims JWT estándar) |

### Estructura del Secreto en Secrets Manager

Cada secreto almacena el contenido PEM directamente como `SecretString`:

```
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...
-----END PRIVATE KEY-----
```

```
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
-----END PUBLIC KEY-----
```

---

## Correctness Properties

*Una propiedad es una característica o comportamiento que debe mantenerse verdadero a través de todas las ejecuciones válidas de un sistema — esencialmente, un enunciado formal sobre lo que el sistema debe hacer. Las propiedades sirven como puente entre las especificaciones legibles por humanos y las garantías de corrección verificables por máquinas.*

### Property 1: Round Trip Criptográfico

*Para todo* objeto JavaScript plano y serializable `P` y par de claves RSA de 2048 bits o mayor `(privada, pública)`, la función `signAndEncrypt(P, privada, pública)` SHALL producir un token JWE con exactamente 5 segmentos separados por `.`, y `decryptAndVerify(token, privada, pública)` SHALL devolver un objeto que contiene todos los campos de `P` con sus valores originales exactos, más los claims `iat` y `exp` como números enteros con `exp - iat === 300`.

**Validates: Requirements 4.1, 4.2, 4.3, 4.4**

### Property 2: Rechazo de Payloads No-Objeto en signAndEncrypt

*Para todo* valor JavaScript que no sea un objeto plano (es decir, valores `null`, `undefined`, primitivos como `string`, `number`, `boolean`, o arrays), la función `signAndEncrypt(valor, privatePem, publicPem)` SHALL lanzar un error sin producir ningún token ni realizar operaciones criptográficas parciales.

**Validates: Requirements 4.6**

### Property 3: Rechazo de Referencias de Secreto Inválidas en getSecret

*Para todo* valor que no sea un string (incluyendo `null`, `undefined`, números, booleanos, arrays y objetos), la función `getSecret(valor)` SHALL lanzar un error con el mensaje `"Invalid secret reference"` sin realizar ninguna llamada a la API de Secrets Manager.

**Validates: Requirements 3.5**

---

## Error Handling

### Estrategia de Error por Capa

```mermaid
flowchart TD
    A[Request entrante] --> B{¿Env vars presentes?}
    B -- No --> E1[HTTP 500: Missing required environment variables]
    B -- Sí --> C{¿Body JSON válido?}
    C -- No --> E2[HTTP 400: Invalid JSON body]
    C -- Sí --> D{¿Payload válido?}
    D -- No --> E3[HTTP 400: Payload must be a JSON object<br/>o Missing or invalid token field]
    D -- Sí --> F{¿Secretos recuperados?}
    F -- Error --> E4[console.error + HTTP 500: Encryption/Decryption failed]
    F -- Sí --> G{¿Operación cripto exitosa?}
    G -- Error --> E4
    G -- Sí --> H[HTTP 200: token / payload]
```


### Clasificación de Errores

| Capa            | Condición                                        | HTTP   | Mensaje                                         | Log |
|-----------------|--------------------------------------------------|--------|-------------------------------------------------|-----|
| Handler         | Env vars ausentes o vacías                       | 500    | `"Missing required environment variables"`      | No  |
| Handler         | JSON del body sintácticamente inválido           | 400    | `"Invalid JSON body"`                           | No  |
| EncryptHandler  | Body es array, null o primitivo                  | 400    | `"Payload must be a JSON object"`               | No  |
| DecryptHandler  | Campo `token` ausente, no-string o whitespace    | 400    | `"Missing or invalid \"token\" field"`          | No  |
| Handler         | Fallo en SecretsManager o en criptografía        | 500    | `"Encryption failed"` / `"Decryption failed"`   | Sí (`console.error`) |
| CryptoModule    | ARN inválido (no-string o null)                  | —      | Lanza: `"Invalid secret reference"`             | —   |
| CryptoModule    | Secreto sin `SecretString`                       | —      | Lanza: `"Secret <ARN> has no SecretString"`     | —   |
| CryptoModule    | Fallo de API de Secrets Manager                  | —      | Lanza: `"Failed to retrieve secret <ARN>: <detalle>"` | — |

### Principios de Diseño de Errores

1. **No filtrar detalles internos al cliente**: Los errores de criptografía y SecretsManager se loguean en CloudWatch (`console.error`) pero el cliente sólo recibe un mensaje genérico (`"Encryption failed"` / `"Decryption failed"`). Esto previene el leakage de información sobre la estructura de claves o el estado del secreto.

2. **Fail fast en validaciones de entrada**: Las validaciones de `env vars`, JSON y tipo de payload se ejecutan antes de cualquier llamada externa (SM o criptografía). Esto evita consumir recursos innecesarios y proporciona feedback rápido al cliente.

3. **Errores criptográficos son opacos**: Un JWE alterado, una firma inválida o un token expirado resultan todos en el mismo HTTP 500 con `"Decryption failed"`. No se distingue entre ellos en la respuesta al cliente (pero sí en los logs).

4. **Propagación de errores desde CryptoModule**: Las excepciones lanzadas por `getSecret`, `signAndEncrypt` y `decryptAndVerify` son capturadas por el bloque `try/catch` del handler, loguadas con `console.error`, y convertidas en respuesta 500.

---

## Consideraciones de Seguridad

### Gestión de Claves RSA

| Aspecto | Decisión de diseño | Justificación |
|---------|--------------------|---------------|
| **Almacenamiento** | AWS Secrets Manager exclusivamente | Las claves nunca están en el código fuente, variables de entorno en texto plano, ni en S3 |
| **Referencia en Lambda** | ARN del secreto vía env var | El ARN no es el secreto en sí; la clave solo se materializa en memoria durante la invocación |
| **Rotación** | Configurable en Secrets Manager (fuera del scope actual) | Desacopla el ciclo de vida de las claves del ciclo de despliegue de la Lambda |
| **Formato** | PKCS8 (privada) y SPKI (pública) en PEM | Formatos estándar soportados por `jose` y generados con `crypto.generateKeyPairSync` de Node.js |
| **Tamaño de clave** | RSA-2048 bits mínimo | Tamaño mínimo recomendado para RSA en contextos modernos; compatible con `RSA-OAEP` |
| **Bypass para tests** | Detección de `"-----BEGIN"` en el ARN | Permite testing local sin acceso a AWS; documentado explícitamente como **solo para tests** |

### IAM con Principio de Mínimo Privilegio

Las funciones Lambda sólo tienen el permiso `secretsmanager:GetSecretValue` y exclusivamente sobre los ARNs específicos de los secretos de clave privada y pública definidos como parámetros SAM:

```yaml
- Statement:
    - Effect: Allow
      Action:
        - secretsmanager:GetSecretValue
      Resource:
        - !Ref PrivateKeySecretArn
        - !Ref PublicKeySecretArn
```

**No se otorgan:**
- `secretsmanager:ListSecrets`
- `secretsmanager:DescribeSecret`
- `secretsmanager:PutSecretValue`
- Acceso a ningún otro recurso de AWS (DynamoDB, S3, SSM, etc.)

La política `AWSLambdaBasicExecutionRole` cubre únicamente los permisos de escritura en CloudWatch Logs (`logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`).


### Algoritmos Criptográficos

| Algoritmo | Rol | Justificación |
|-----------|-----|---------------|
| **RS256** (RSASSA-PKCS1-v1_5 + SHA-256) | Firma JWT | Ampliamente soportado, interoperable, asimétrico (la firma requiere clave privada; la verificación sólo necesita clave pública) |
| **RSA-OAEP** (RSA-OAEP-SHA1) | Cifrado de la Content Encryption Key (CEK) del JWE | Estándar de cifrado asimétrico seguro; OAEP es superior a PKCS1v1.5 para cifrado |
| **A256GCM** | Cifrado del contenido del JWE | AES-256 en modo GCM provee confidencialidad y autenticación de integridad (AEAD) con un único tag de 128 bits |

### Propiedades de Seguridad del Doble Cifrado

El patrón JWT dentro de JWE provee:
- **Sin confidencialidad sin autenticidad**: No se puede descifrar el JWE sin la clave privada, y el JWT interno es verificado con la clave pública. Un atacante que obtuviese la clave privada puede descifrar pero no forjar nuevas firmas válidas (necesitaría la *misma* clave privada usada para firmar).
- **Sin reenvío de tokens expirados**: La validación del claim `exp` en `jwtVerify` es automática. Tokens más viejos de 5 minutos son rechazados aunque el JWE sea criptográficamente válido.
- **Autenticación del ciphertext**: El tag GCM detecta cualquier alteración de los bytes cifrados del JWE antes del descifrado del JWT.

---

## Estructura del Proyecto

```
sdd-crypto-lambdas/
├── lambdas/
│   ├── encrypt/
│   │   └── handler.js          # Handler de la EncryptFunction
│   ├── decrypt/
│   │   └── handler.js          # Handler de la DecryptFunction
│   └── shared/
│       └── crypto.js           # CryptoModule: getSecret, signAndEncrypt, decryptAndVerify
├── tests/
│   ├── encrypt.handler.test.js # Tests unitarios del handler de cifrado
│   ├── decrypt.handler.test.js # Tests unitarios del handler de descifrado
│   └── flow.integration.test.js # Test de integración de round trip
├── sam/
│   └── template.yaml           # Plantilla AWS SAM (infraestructura como código)
├── package.json                # Dependencias y scripts de test
├── jest.config.js              # Configuración de Jest
└── samconfig.toml              # Configuración de despliegue SAM
```

**Decisión de diseño — un módulo compartido (`lambdas/shared/crypto.js`):**
Ambas lambdas requieren `getSecret` y sus respectivas funciones criptográficas. Centralizar la lógica en un módulo compartido evita duplicación, facilita el testing unitario del módulo en aislamiento, y garantiza que ambas funciones usen exactamente la misma implementación criptográfica.

**Decisión de diseño — un handler por Lambda:**
Cada función Lambda tiene su propio `handler.js` con responsabilidades claras: validación de entrada, orquestación de la recuperación de claves y delegación de la operación criptográfica al CryptoModule. Esta separación facilita el testing independiente y la evolución de cada handler sin afectar al otro.


---

## Testing Strategy

### Enfoque Dual

El proyecto emplea dos estrategias de testing complementarias:

| Tipo | Herramienta | Objetivo |
|------|-------------|----------|
| **Tests unitarios** | Jest + mocks | Verificar comportamientos específicos con ejemplos concretos (flujos de error, validaciones, contratos HTTP) |
| **Tests de propiedades** (PBT) | `fast-check` + Jest | Verificar propiedades universales a través de inputs generados aleatoriamente (round trip criptográfico, rechazo de inputs inválidos) |
| **Test de integración** | Jest (real criptografía) | Flujo completo de extremo a extremo con claves RSA reales generadas en memoria |

### Tests Unitarios Existentes

Los tests unitarios en `tests/encrypt.handler.test.js` y `tests/decrypt.handler.test.js` cubren los casos de comportamiento específicos del handler utilizando mocks de `../lambdas/shared/crypto`:

**EncryptFunction:**
- ✅ HTTP 200 con token devuelto (éxito)
- ✅ HTTP 400 por JSON sintácticamente inválido
- ✅ HTTP 500 por variables de entorno ausentes
- ⚠️ Falta: HTTP 400 por body no-objeto (array, null, primitivo)

**DecryptFunction:**
- ✅ HTTP 200 con payload devuelto (éxito)
- ✅ HTTP 400 por campo `token` ausente o inválido
- ✅ HTTP 400 por JSON sintácticamente inválido
- ⚠️ Falta: HTTP 500 por variables de entorno ausentes

### Tests de Integración Existentes

El archivo `tests/flow.integration.test.js` ejecuta el flujo completo usando claves RSA-2048 generadas en memoria (sin AWS), verificando la propiedad de round trip con un payload específico. Este test cubre el requisito 6.3.

### Tests de Propiedad (Property-Based Testing)

**Librería:** [`fast-check`](https://github.com/dubzzz/fast-check) — librería PBT para JavaScript/TypeScript.

**Instalación:**
```bash
npm install --save-dev fast-check@3.19.0
```

**Configuración:** Mínimo 100 iteraciones por propiedad (parámetro `numRuns: 100`).

**Tag de referencia:** `Feature: sdd-crypto-lambdas, Property <N>: <texto>`

#### Propiedad 1: Round Trip Criptográfico

```javascript
// Feature: sdd-crypto-lambdas, Property 1: Round trip criptográfico
// Valida: Requisitos 4.1, 4.2, 4.3, 4.4
describe('CryptoModule - Propiedad 1: Round trip criptográfico', () => {
  let privatePem, publicPem;

  beforeAll(() => {
    // Par de claves RSA-2048 generado una sola vez para toda la suite PBT
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  });

  it('para cualquier payload plano, signAndEncrypt + decryptAndVerify es identidad', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generador: objetos JS planos con valores string, number, boolean
        fc.object({ values: [fc.string(), fc.integer(), fc.boolean()] }),
        async (originalPayload) => {
          const token = await signAndEncrypt(originalPayload, privatePem, publicPem);

          // Invariante estructural del JWE Compact (RFC 7516)
          expect(token.split('.').length).toBe(5);

          const recovered = await decryptAndVerify(token, privatePem, publicPem);

          // Todos los campos del payload original deben estar presentes con sus valores exactos
          for (const [key, value] of Object.entries(originalPayload)) {
            expect(recovered[key]).toEqual(value);
          }

          // Claims de tiempo deben ser números enteros
          expect(typeof recovered.iat).toBe('number');
          expect(typeof recovered.exp).toBe('number');
          expect(Number.isInteger(recovered.iat)).toBe(true);
          expect(Number.isInteger(recovered.exp)).toBe(true);

          // Ventana de expiración exacta de 300 segundos
          expect(recovered.exp - recovered.iat).toBe(300);
        }
      ),
      { numRuns: 100 }
    );
  });
});
```


#### Propiedad 2: Rechazo de Payloads No-Objeto en signAndEncrypt

```javascript
// Feature: sdd-crypto-lambdas, Property 2: Rechazo de payloads no-objeto
// Valida: Requisito 4.6
describe('CryptoModule - Propiedad 2: Rechazo de payloads no-objeto', () => {
  let privatePem, publicPem;

  beforeAll(() => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  });

  it('para cualquier valor no-objeto, signAndEncrypt lanza error', async () => {
    // Generador: valores que NO son objetos planos (null, primitivos, arrays)
    const nonObjectArb = fc.oneof(
      fc.constant(null),
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.array(fc.string())
    );

    await fc.assert(
      fc.asyncProperty(nonObjectArb, async (invalidPayload) => {
        await expect(
          signAndEncrypt(invalidPayload, privatePem, publicPem)
        ).rejects.toThrow();
      }),
      { numRuns: 100 }
    );
  });
});
```

#### Propiedad 3: Rechazo de Referencias de Secreto Inválidas en getSecret

```javascript
// Feature: sdd-crypto-lambdas, Property 3: Rechazo de referencias de secreto inválidas
// Valida: Requisito 3.5
describe('CryptoModule - Propiedad 3: Rechazo de referencias de secreto inválidas', () => {
  it('para cualquier input no-string, getSecret lanza "Invalid secret reference"', async () => {
    const nonStringArb = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer(),
      fc.boolean(),
      fc.array(fc.string()),
      fc.object()
    );

    await fc.assert(
      fc.asyncProperty(nonStringArb, async (invalidArn) => {
        await expect(getSecret(invalidArn)).rejects.toThrow('Invalid secret reference');
      }),
      { numRuns: 100 }
    );
  });
});
```

### Consideraciones de Performance para PBT

La **Propiedad 1** ejecuta 100 operaciones criptográficas RSA completas. Para minimizar el tiempo de ejecución:
- El par de claves RSA-2048 se genera **una sola vez** en `beforeAll`, no por cada iteración.
- Las operaciones de `importPKCS8` / `importSPKI` dentro de `signAndEncrypt` y `decryptAndVerify` son ejecutadas por la librería `jose` (optimizadas en Node.js nativo).
- Tiempo estimado: ~50-100ms por iteración (criptografía RSA en Node.js), ~5-10 segundos para 100 iteraciones.

Las **Propiedades 2 y 3** no involucran criptografía RSA real, por lo que son virtualmente instantáneas.

### Resumen de Cobertura de Tests

| Requisito | Criterio | Tipo de Test | Archivo |
|-----------|----------|--------------|---------|
| 1.1 | Recuperación paralela de claves | Unitario (example) | `encrypt.handler.test.js` |
| 1.2, 1.3 | JWT/JWE generados correctamente | PBT (Propiedad 1) | `crypto.pbt.test.js` (nuevo) |
| 1.4 | HTTP 200 con token | Unitario | `encrypt.handler.test.js` |
| 1.5 | Rechazo de body no-objeto | Unitario + PBT | `encrypt.handler.test.js` |
| 1.6 | Rechazo de JSON inválido | Unitario (edge case) | `encrypt.handler.test.js` |
| 1.7 | Env vars ausentes → 500 | Unitario | `encrypt.handler.test.js` |
| 1.8 | Error en SM/cripto → 500 | Unitario | `encrypt.handler.test.js` |
| 2.1–2.4 | Flujo de descifrado | Unitario + PBT | `decrypt.handler.test.js` |
| 2.5–2.9 | Validaciones y errores DecryptFunction | Unitario | `decrypt.handler.test.js` |
| 3.1–3.6 | Comportamiento getSecret | Unitario + PBT (Propiedad 3) | `crypto.pbt.test.js` (nuevo) |
| 4.1–4.4 | Round trip e invariantes criptográficas | PBT (Propiedad 1) | `crypto.pbt.test.js` (nuevo) |
| 4.5 | Token malformado → error | Unitario (edge case) | `flow.integration.test.js` |
| 4.6 | Payload inválido → error | PBT (Propiedad 2) | `crypto.pbt.test.js` (nuevo) |
| 5.1–5.7 | Infraestructura SAM | Smoke (manual / sam validate) | `sam/template.yaml` |
| 6.1–6.4 | Cobertura de Test_Suite | Integración | `flow.integration.test.js` |

