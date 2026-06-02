const {
  CompactEncrypt,
  compactDecrypt,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
} = require("jose");

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

const secretsClient = new SecretsManagerClient({
  region: process.env.AWS_REGION || "us-east-1",
});

async function getSecret(secretArn) {
  if (!secretArn || typeof secretArn !== "string") {
    throw new Error("Invalid secret reference");
  }

  if (secretArn.includes("-----BEGIN")) {
    return secretArn;
  }

  try {
    const command = new GetSecretValueCommand({ SecretId: secretArn });
    const response = await secretsClient.send(command);

    if (!response.SecretString) {
      throw new Error(`Secret ${secretArn} has no SecretString`);
    }

    return response.SecretString;
  } catch (error) {
    throw new Error(`Failed to retrieve secret ${secretArn}: ${error.message}`);
  }
}

async function signAndEncrypt(payload, privateKeyPem, publicKeyPem) {
  const signingKey = await importPKCS8(privateKeyPem, "RS256");
  const encryptionKey = await importSPKI(publicKeyPem, "RSA-OAEP");

  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);

  return new CompactEncrypt(Buffer.from(jwt))
    .setProtectedHeader({ alg: "RSA-OAEP", enc: "A256GCM" })
    .encrypt(encryptionKey);
}

async function decryptAndVerify(jweToken, privateKeyPem, publicKeyPem) {
  const decryptionKey = await importPKCS8(privateKeyPem, "RSA-OAEP");
  const verificationKey = await importSPKI(publicKeyPem, "RS256");

  const { plaintext } = await compactDecrypt(jweToken, decryptionKey);
  const jwt = Buffer.from(plaintext).toString("utf-8");

  const { payload } = await jwtVerify(jwt, verificationKey, {
    algorithms: ["RS256"],
  });

  return payload;
}

module.exports = {
  getSecret,
  signAndEncrypt,
  decryptAndVerify,
};
