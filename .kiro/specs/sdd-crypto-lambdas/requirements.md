# Requirements Document

## Introduction

El proyecto **sdd-crypto-lambdas** expone dos funciones AWS Lambda (`encrypt` y `decrypt`) que implementan un flujo de cifrado de doble capa para payloads JSON. La lambda `encrypt` firma el payload como JWT (RS256) y luego lo cifra como JWE (RSA-OAEP + A256GCM), devolviendo un token opaco. La lambda `decrypt` invierte el proceso: descifra el JWE y verifica la firma JWT, devolviendo el payload original. Las claves RSA se gestionan de forma segura a través de AWS Secrets Manager. La infraestructura se define con AWS SAM y el módulo criptográfico compartido utiliza la librería `jose`.

---

## Glossary

- **EncryptFunction**: Función AWS Lambda que recibe un payload JSON y devuelve un token JWE.
- **DecryptFunction**: Función AWS Lambda que recibe un token JWE y devuelve el payload JSON original.
- **CryptoModule**: Módulo compartido (`lambdas/shared/crypto.js`) que encapsula todas las operaciones criptográficas usando la librería `jose`.
- **SecretsManager**: Servicio AWS Secrets Manager utilizado para almacenar y recuperar las claves RSA en formato PEM.
- **JWT**: JSON Web Token firmado con el algoritmo RS256.
- **JWE**: JSON Web Encryption en formato compacto, cifrado con RSA-OAEP y contenido cifrado con A256GCM.
- **Clave_Privada_RSA**: Clave privada RSA en formato PKCS8 PEM, usada para firmar JWTs y descifrar JWEs.
- **Clave_Publica_RSA**: Clave pública RSA en formato SPKI PEM, usada para cifrar JWEs y verificar firmas JWT.
- **Payload**: Objeto JSON arbitrario proporcionado por el cliente para ser protegido criptográficamente.
- **Token**: Cadena JWE en formato compacto devuelta por la EncryptFunction.
- **API_Gateway**: Amazon API Gateway que expone los endpoints HTTP POST `/encrypt` y `/decrypt`.
- **SAM_Template**: Plantilla AWS SAM (`sam/template.yaml`) que define la infraestructura del proyecto.
- **Test_Suite**: Conjunto de tests unitarios e integración ejecutados con Jest.
- **PRIVATE_KEY_SECRET_ARN**: Variable de entorno que contiene el ARN del secreto de la Clave_Privada_RSA en SecretsManager.
- **PUBLIC_KEY_SECRET_ARN**: Variable de entorno que contiene el ARN del secreto de la Clave_Publica_RSA en SecretsManager.

---

## Requirements

### Requirement 1: Cifrado de Payload (EncryptFunction)

**User Story:** Como sistema cliente, quiero enviar un payload JSON al endpoint `/encrypt` y recibir un token JWE, para que los datos sensibles viajen cifrados y firmados entre servicios.

#### Acceptance Criteria

1. WHEN la EncryptFunction recibe un evento con un campo `body` que contiene un objeto JSON válido (string serializado o objeto pre-parseado), THE EncryptFunction SHALL recuperar la Clave_Privada_RSA y la Clave_Publica_RSA desde SecretsManager en paralelo usando `Promise.all`.
2. WHEN la EncryptFunction ha recuperado ambas claves RSA, THE CryptoModule SHALL firmar el Payload como JWT usando el algoritmo RS256 con la Clave_Privada_RSA, estableciendo un tiempo de expiración de 5 minutos (300 segundos) desde el momento de la firma.
3. WHEN el CryptoModule ha generado el JWT firmado, THE CryptoModule SHALL cifrar el JWT como JWE en formato compacto usando el algoritmo RSA-OAEP para el cifrado de clave y A256GCM para el cifrado del contenido, con la Clave_Publica_RSA.
4. WHEN el proceso de firma y cifrado concluye sin errores, THE EncryptFunction SHALL devolver una respuesta HTTP 200 con un cuerpo JSON que contenga el campo `token` con el valor del JWE generado.
5. IF el campo `body` del evento es un array, nulo, un tipo primitivo, o está ausente/indefinido, THEN THE EncryptFunction SHALL devolver una respuesta HTTP 400 con un cuerpo JSON que contenga el campo `error` con el mensaje `"Payload must be a JSON object"`.
6. IF el campo `body` del evento contiene JSON sintácticamente inválido, THEN THE EncryptFunction SHALL devolver una respuesta HTTP 400 con un cuerpo JSON que contenga el campo `error` con el mensaje `"Invalid JSON body"`.
7. IF la variable de entorno PRIVATE_KEY_SECRET_ARN o PUBLIC_KEY_SECRET_ARN no está definida o es una cadena vacía, THEN THE EncryptFunction SHALL devolver una respuesta HTTP 500 con un cuerpo JSON que contenga el campo `error` con el mensaje `"Missing required environment variables"`, sin intentar recuperar secretos ni ejecutar operaciones criptográficas.
8. IF ocurre un error durante la recuperación de claves desde SecretsManager o durante las operaciones criptográficas, THEN THE EncryptFunction SHALL registrar el error completo en CloudWatch Logs mediante `console.error` antes de devolver una respuesta HTTP 500 con un cuerpo JSON que contenga el campo `error` con el mensaje `"Encryption failed"`.

---

### Requirement 2: Descifrado y Verificación de Token (DecryptFunction)

**User Story:** Como sistema cliente, quiero enviar un token JWE al endpoint `/decrypt` y recibir el payload JSON original, para que los datos puedan ser consumidos por el servicio receptor tras verificar su autenticidad.

#### Acceptance Criteria

1. WHEN la DecryptFunction recibe un evento con un campo `body` (como string serializado o como objeto pre-parseado) que contiene un campo `token` de tipo string no vacío, THE DecryptFunction SHALL recuperar la Clave_Privada_RSA y la Clave_Publica_RSA desde SecretsManager en paralelo usando `Promise.all`.
2. WHEN la DecryptFunction ha recuperado ambas claves RSA, THE CryptoModule SHALL descifrar el Token JWE usando la Clave_Privada_RSA con el algoritmo RSA-OAEP y el algoritmo de contenido A256GCM, obteniendo el JWT interno como texto plano UTF-8.
3. WHEN el CryptoModule ha obtenido el JWT interno, THE CryptoModule SHALL verificar la firma del JWT usando la Clave_Publica_RSA con el algoritmo RS256, incluyendo la validación automática del claim `exp` (expiración del token).
4. WHEN la verificación de firma y expiración es exitosa, THE DecryptFunction SHALL devolver una respuesta HTTP 200 con un cuerpo JSON que contenga el campo `payload` con el objeto de claims del JWT verificado.
5. IF el campo `body` del evento no contiene el campo `token`, o el campo `token` no es un string, o el campo `token` es un string vacío o compuesto solo de espacios, THEN THE DecryptFunction SHALL devolver una respuesta HTTP 400 con un cuerpo JSON que contenga el campo `error` con el mensaje `"Missing or invalid \"token\" field"`.
6. IF el campo `body` del evento contiene JSON sintácticamente inválido, THEN THE DecryptFunction SHALL devolver una respuesta HTTP 400 con un cuerpo JSON que contenga el campo `error` con el mensaje `"Invalid JSON body"`.
7. IF la variable de entorno PRIVATE_KEY_SECRET_ARN o PUBLIC_KEY_SECRET_ARN no está definida o es una cadena vacía, THEN THE DecryptFunction SHALL devolver una respuesta HTTP 500 con un cuerpo JSON que contenga el campo `error` con el mensaje `"Missing required environment variables"`, sin intentar recuperar secretos.
8. IF el Token JWE está malformado, ha sido alterado, o la firma JWT es inválida o ha expirado, THEN THE DecryptFunction SHALL registrar el error completo en CloudWatch Logs mediante `console.error` antes de devolver una respuesta HTTP 500 con un cuerpo JSON que contenga el campo `error` con el mensaje `"Decryption failed"`.
9. IF la llamada a SecretsManager falla durante la recuperación de claves en la DecryptFunction, THEN THE DecryptFunction SHALL registrar el error en CloudWatch Logs y devolver una respuesta HTTP 500 con el mensaje `"Decryption failed"`.

---

### Requirement 3: Gestión Segura de Claves RSA (SecretsManager)

**User Story:** Como operador del sistema, quiero que las claves RSA se almacenen y recuperen exclusivamente desde AWS Secrets Manager, para que las claves privadas nunca estén expuestas en el código fuente ni en variables de entorno en texto plano.

#### Acceptance Criteria

1. WHEN el CryptoModule recibe un ARN válido de SecretsManager, THE CryptoModule SHALL llamar a la API `GetSecretValue` de SecretsManager y devolver el valor del campo `SecretString` del secreto recuperado.
2. WHEN el ARN del secreto es una cadena no vacía que no contiene la subcadena `"-----BEGIN"`, THE CryptoModule SHALL realizar una llamada a la API de SecretsManager usando ese ARN como `SecretId` para obtener el valor del secreto.
3. IF el secreto recuperado de SecretsManager no contiene un campo `SecretString` (es decir, el secreto almacena datos binarios), THEN THE CryptoModule SHALL lanzar un error con el mensaje `"Secret <ARN> has no SecretString"`, donde `<ARN>` es el identificador del secreto.
4. IF la llamada a la API de SecretsManager falla a nivel de red o de servicio (ej. permisos denegados, ARN no encontrado, timeout), THEN THE CryptoModule SHALL lanzar un error con el mensaje `"Failed to retrieve secret <ARN>: <detalle>"`, donde `<detalle>` es el mensaje del error original de la API.
5. IF el ARN proporcionado a `getSecret` es nulo, indefinido o no es de tipo string, THEN THE CryptoModule SHALL lanzar un error con el mensaje `"Invalid secret reference"` sin realizar ninguna llamada a SecretsManager.
6. IF el valor del ARN proporcionado contiene la subcadena `"-----BEGIN"`, THE CryptoModule SHALL tratar ese valor directamente como el contenido PEM de la clave, omitiendo la llamada a SecretsManager. Esta ruta es exclusiva para entornos de prueba locales y no debe usarse en producción.

---

### Requirement 4: Propiedad de Ida y Vuelta del Flujo Criptográfico

**User Story:** Como desarrollador, quiero garantizar que cualquier payload JSON que sea cifrado por el CryptoModule pueda ser descifrado y verificado correctamente, para que el sistema sea confiable y no haya pérdida de datos.

#### Acceptance Criteria

1. THE CryptoModule SHALL implementar la función `signAndEncrypt(payload, privateKeyPem, publicKeyPem)` que devuelve un Token JWE en formato compacto, definido como una cadena de texto compuesta por exactamente 5 segmentos separados por puntos (`.`).
2. THE CryptoModule SHALL implementar la función `decryptAndVerify(jweToken, privateKeyPem, publicKeyPem)` que devuelve el objeto de claims del JWT original, incluyendo los claims `iat` y `exp` como valores numéricos además de los campos del payload original.
3. PARA TODO objeto JavaScript plano y serializable `P` y par de claves RSA de 2048 bits o mayor `(privada, pública)`, THE CryptoModule SHALL garantizar que `decryptAndVerify(signAndEncrypt(P, privada, pública), privada, pública)` devuelva un objeto que contenga todos los campos originales de `P` con sus valores originales, además de los claims `iat` y `exp` como números enteros (propiedad de ida y vuelta).
4. WHEN el CryptoModule genera un JWT durante `signAndEncrypt`, THE CryptoModule SHALL incluir los claims `iat` (issued at) y `exp` (expiration) con una ventana de expiración de exactamente 300 segundos (5 minutos) a partir del momento de la firma.
5. IF `decryptAndVerify` recibe un token JWE malformado, alterado o con firma inválida, THEN THE CryptoModule SHALL lanzar un error describiendo la causa del fallo criptográfico sin devolver ningún dato de payload.
6. IF `signAndEncrypt` recibe un payload que es nulo, no es un objeto, o no es serializable a JSON, THEN THE CryptoModule SHALL lanzar un error antes de realizar ninguna operación criptográfica.

---

### Requirement 5: Infraestructura y Despliegue con AWS SAM

**User Story:** Como ingeniero de infraestructura, quiero que las funciones Lambda y el API Gateway estén definidos como código en una plantilla AWS SAM, para que el despliegue sea reproducible y versionable.

#### Acceptance Criteria

1. THE SAM_Template SHALL declarar la transformación `AWS::Serverless-2016-10-31` en la sección `Transform`, haciendo del template un documento SAM válido y desplegable.
2. THE SAM_Template SHALL definir la EncryptFunction con el handler `lambdas/encrypt/handler.handler`, y THE SAM_Template SHALL definir la DecryptFunction con el handler `lambdas/decrypt/handler.handler`; ambas funciones SHALL usar el runtime `nodejs20.x`, timeout de 10 segundos y memoria de 256 MB, preferiblemente a través de una sección `Globals`.
3. THE SAM_Template SHALL configurar un recurso `AWS::Serverless::Api` (CryptoApi) con tipo de endpoint `REGIONAL` que exponga el endpoint POST `/encrypt` vinculado a la EncryptFunction y el endpoint POST `/decrypt` vinculado a la DecryptFunction.
4. THE SAM_Template SHALL otorgar a la EncryptFunction y a la DecryptFunction la política gestionada `AWSLambdaBasicExecutionRole` y permisos IAM de `secretsmanager:GetSecretValue` exclusivamente sobre los ARNs de los secretos definidos como parámetros `PrivateKeySecretArn` y `PublicKeySecretArn`.
5. THE SAM_Template SHALL inyectar las variables de entorno PRIVATE_KEY_SECRET_ARN y PUBLIC_KEY_SECRET_ARN en ambas funciones Lambda usando los valores de los parámetros SAM correspondientes.
6. WHERE el parámetro `StageName` es proporcionado durante el despliegue, THE SAM_Template SHALL usar ese valor como nombre del stage del API Gateway, con valor por defecto `dev`.
7. THE SAM_Template SHALL exponer como Outputs del stack los valores `ApiBaseUrl` (URL base del API Gateway), `EncryptFunctionName` (nombre de la EncryptFunction) y `DecryptFunctionName` (nombre de la DecryptFunction), para facilitar la integración y el descubrimiento del despliegue.

---

### Requirement 6: Cobertura de Tests

**User Story:** Como desarrollador, quiero que el proyecto incluya tests unitarios y de integración ejecutables con Jest, para que la corrección del comportamiento pueda verificarse automáticamente en cada cambio.

#### Acceptance Criteria

1. THE Test_Suite SHALL incluir tests unitarios para la EncryptFunction que verifiquen los casos: éxito con token devuelto (HTTP 200), error 400 por JSON sintácticamente inválido, error 400 por body no-objeto (array, null, primitivo), y error 500 por variables de entorno ausentes.
2. THE Test_Suite SHALL incluir tests unitarios para la DecryptFunction que verifiquen los casos: éxito con payload devuelto (HTTP 200), error 400 por campo `token` ausente o inválido, error 400 por JSON sintácticamente inválido, y error 500 por variables de entorno ausentes.
3. THE Test_Suite SHALL incluir un test de integración del flujo completo que genere un par de claves RSA de 2048 bits en memoria, cifre un payload con `signAndEncrypt` y lo descifre con `decryptAndVerify`, verificando que todos los campos del payload original estén presentes en el resultado con sus valores originales, y que los claims `iat` y `exp` sean valores numéricos.
4. WHEN se ejecuta el comando `npm test`, THE Test_Suite SHALL ejecutar todos los tests en modo secuencial (`--runInBand`) y reportar el resultado de cada caso.
