jest.mock('../lambdas/shared/crypto', () => ({
  getSecret: jest.fn(),
  decryptAndVerify: jest.fn()
}));

const { handler } = require('../lambdas/decrypt/handler');
const { getSecret, decryptAndVerify } = require('../lambdas/shared/crypto');

describe('decrypt handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PRIVATE_KEY_SECRET_ARN = 'arn:private';
    process.env.PUBLIC_KEY_SECRET_ARN = 'arn:public';
  });

  it('returns payload on success', async () => {
    getSecret.mockResolvedValueOnce('privatePem').mockResolvedValueOnce('publicPem');
    decryptAndVerify.mockResolvedValue({ userId: '123', scope: 'encrypt' });

    const result = await handler({
      body: JSON.stringify({ token: 'jwe-token' })
    });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      payload: { userId: '123', scope: 'encrypt' }
    });
  });

  it('returns 400 for missing token', async () => {
    const result = await handler({
      body: JSON.stringify({})
    });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'Missing or invalid "token" field'
    });
  });

  it('returns 400 for invalid JSON', async () => {
    const result = await handler({
      body: '{invalid'
    });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: 'Invalid JSON body' });
  });
});
