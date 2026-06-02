const { generateKeyPairSync } = require('crypto');
const { decryptAndVerify, signAndEncrypt } = require('../lambdas/shared/crypto');

describe('lambda crypto flow integration', () => {
  it('signs and encrypts payload, then decrypts and verifies it', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

    const originalPayload = {
      sub: '979667333545',
      email: 'est_jd_mendoza@fesc.edu.co',
      role: 'backend-test'
    };

    const token = await signAndEncrypt(originalPayload, privatePem, publicPem);
    const decryptedPayload = await decryptAndVerify(token, privatePem, publicPem);

    expect(typeof token).toBe('string');
    expect(decryptedPayload.sub).toBe(originalPayload.sub);
    expect(decryptedPayload.email).toBe(originalPayload.email);
    expect(decryptedPayload.role).toBe(originalPayload.role);
    expect(typeof decryptedPayload.iat).toBe('number');
    expect(typeof decryptedPayload.exp).toBe('number');
  });
});
