const { getSecret, signAndEncrypt } = require("../shared/crypto");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

exports.handler = async (event = {}) => {
  const privateKeySecretArn = process.env.PRIVATE_KEY_SECRET_ARN;
  const publicKeySecretArn = process.env.PUBLIC_KEY_SECRET_ARN;

  if (!privateKeySecretArn || !publicKeySecretArn) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Missing required environment variables" }),
    };
  }

  let payload;
  try {
    if (typeof event.body === "string") {
      payload = JSON.parse(event.body);
    } else {
      payload = event.body;
    }
  } catch (error) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Payload must be a JSON object" }),
    };
  }

  try {
    const [privateKeyPem, publicKeyPem] = await Promise.all([
      getSecret(privateKeySecretArn),
      getSecret(publicKeySecretArn),
    ]);

    const token = await signAndEncrypt(payload, privateKeyPem, publicKeyPem);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ token }),
    };
  } catch (error) {
    console.error("Encrypt error:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Encryption failed" }),
    };
  }
};
