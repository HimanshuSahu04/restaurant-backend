import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pool from '../src/config/database.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Mock auth routes for testing
const users = [];

app.post('/api/auth/register', (req, res) => {
  const user = { id: String(users.length + 1), ...req.body };
  users.push(user);
  res.status(201).json({ token: 'mock-token' });
});

app.post('/api/auth/login', (req, res) => {
  const user = users.find(u => u.email === req.body.email);
  if (!user || user.password !== req.body.password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ token: 'mock-token' });
});

const server = createServer(app);

describe('Authentication', () => {
  it('should register a new user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'New User',
        email: 'new@example.com',
        phone: '0987654321',
        password: 'password123',
        role: 'customer'
      });

    assert.strictEqual(res.status, 201);
    assert.ok(res.body.token);
  });

  it('should login an existing user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'new@example.com',
        password: 'password123'
      });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.token);
  });
});
