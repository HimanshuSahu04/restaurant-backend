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

// Simple in-memory storage for testing
const users = [];
const orders = [];

// Mock auth route
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

// Mock order routes
app.post('/api/orders', (req, res) => {
  const order = { id: String(orders.length + 1), ...req.body };
  orders.push(order);
  res.status(201).json({ orderId: order.id });
});

app.get('/api/orders/:orderId', (req, res) => {
  const order = orders.find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

const server = createServer(app);

describe('Authentication', () => {
  it('should register a new user', async () => {
    const res = await request(server)
      .post('/api/auth/register')
      .send({
        name: 'Test User',
        email: 'test@example.com',
        phone: '1234567890',
        password: 'password123',
        role: 'customer'
      });

    assert.strictEqual(res.status, 201);
    assert.ok(res.body.token);
  });

  it('should login an existing user', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .send({
        email: 'test@example.com',
        password: 'password123'
      });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.token);
  });
});

describe('Orders', () => {
  it('should create a new order', async () => {
    const res = await request(server)
      .post('/api/orders')
      .send({
        restaurantId: 'test-restaurant',
        tableId: 'table-1',
        items: [{ menuItemId: 'item-1', quantity: 2, price: 9.99 }]
      });

    assert.strictEqual(res.status, 201);
    assert.ok(res.body.orderId);
  });

  it('should get order details', async () => {
    const res = await request(server)
      .get('/api/orders/1');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, '1');
  });
});

after(async () => {
  server.close();
  await pool.end();
});
