import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../app';
import { env } from '../../config/env';

const API_KEY = env.API_KEY;

describe('Auth Module', () => {
  describe('POST /api/auth/login', () => {
    it('should reject login with missing fields (Zod validation)', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('x-api-key', API_KEY)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('VALIDATION_ERROR');
      expect(response.body.details).toBeDefined();
    });

    it('should reject login with invalid email format', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('x-api-key', API_KEY)
        .send({ email: 'not-an-email', password: '123456' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'body.email' }),
        ]),
      );
    });

    it('should reject login with short password', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('x-api-key', API_KEY)
        .send({ email: 'test@test.com', password: '123' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'body.password' }),
        ]),
      );
    });

    it('should reject login with non-existent credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('x-api-key', API_KEY)
        .send({ email: 'ghost@noexiste.com', password: 'password123' });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    }, 15000);
  });

  describe('GET /api/auth/me', () => {
    it('should reject without Authorization header', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('x-api-key', API_KEY);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    it('should reject with malformed Bearer token', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('x-api-key', API_KEY)
        .set('Authorization', 'Bearer invalid-token-garbage');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    it('should reject with Bearer prefix but no token', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('x-api-key', API_KEY)
        .set('Authorization', 'NotBearer token123');

      expect(response.status).toBe(401);
    });
  });
});
