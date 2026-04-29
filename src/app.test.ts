import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from './app';
import { env } from './config/env';

describe('App Integration Tests', () => {
  it('should return 403 if API Key is missing', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(403);
    expect(response.body.success).toBe(false);
  });

  it('should return 200 for health check with valid API Key', async () => {
    const response = await request(app)
      .get('/health')
      .set('x-api-key', env.API_KEY);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('should return 404 for non-existent routes', async () => {
    const response = await request(app)
      .get('/api/not-found')
      .set('x-api-key', env.API_KEY);

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
  });
});
