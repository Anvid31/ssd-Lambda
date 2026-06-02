const { decryptAndVerify, getSecret } = require("../shared/crypto");

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

  let body;
  try {
    if (typeof event.body === "string") {
      body = JSON.parse(event.body);
    } else {
      body = event.body;
    }
  } catch (error) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  if (!body || typeof body.token !== "string" || !body.token.trim()) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Missing or invalid "token" field' }),
    };
  }

  try {
    const [privateKeyPem, publicKeyPem] = await Promise.all([
      getSecret(privateKeySecretArn),
      getSecret(publicKeySecretArn),
    ]);

    const payload = await decryptAndVerify(
      body.token,
      privateKeyPem,
      publicKeyPem,
    );

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ payload }),
    };
  } catch (error) {
    console.error("Decrypt error:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Decryption failed" }),
    };
  }
};
