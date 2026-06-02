jest.mock('../lambdas/shared/crypto', () => ({
  getSecret: jest.fn(),
  signAndEncrypt: jest.fn()
}));

const { handler } = require('../lambdas/encrypt/handler');
const { getSecret, signAndEncrypt } = require('../lambdas/shared/crypto');

describe('encrypt handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PRIVATE_KEY_SECRET_ARN = 'arn:private';
    process.env.PUBLIC_KEY_SECRET_ARN = 'arn:public';
  });

  it('returns token on success', async () => {
    getSecret.mockResolvedValueOnce('privatePem').mockResolvedValueOnce('publicPem');
    signAndEncrypt.mockResolvedValue('jwe-token');

    const result = await handler({
      body: JSON.stringify({ userId: '123', role: 'tester' })
    });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ token: 'jwe-token' });
    expect(signAndEncrypt).toHaveBeenCalledWith(
      { userId: '123', role: 'tester' },
      'privatePem',
      'publicPem'
    );
  });

  it('returns 400 for invalid JSON', async () => {
    const result = await handler({
      body: '{"broken":true'
    });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns 500 when env vars are missing', async () => {
    delete process.env.PRIVATE_KEY_SECRET_ARN;

    const result = await handler({
      body: JSON.stringify({ ok: true })
    });

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({
      error: 'Missing required environment variables'
    });
  });
});
