import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Mock auth routes
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

// Mock data
let orders = [];

app.post('/api/payments/process', (req, res) => {
  const { orderId } = req.body;
  const order = orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.payment_status = 'paid';
  res.json({ message: 'Payment processed successfully' });
});

app.post('/api/orders', (req, res) => {
  const order = { id: String(orders.length + 1), ...req.body, status: 'placed', payment_status: 'pending' };
  orders.push(order);
  res.status(201).json({ orderId: order.id });
});

describe('Payments', () => {
  let authToken;
  let orderId;

  before(async () => {
    // Register and login
    await request(app).post('/api/auth/register').send({
      name: 'Test User',
      email: 'test@example.com',
      phone: '1234567890',
      password: 'password123',
      role: 'customer'
    });

    const res = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'password123'
    });
    authToken = res.body.token;

    // Create a test order
    const orderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        restaurantId: 'rest-1',
        tableId: 'table-1',
        items: [{ menuItemId: 'item-1', quantity: 2, price: 9.99 }]
      });

    orderId = orderRes.body.orderId;
  });

  it('should process a payment', async () => {
    const res = await request(app)
      .post('/api/payments/process')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        orderId,
        paymentMethod: 'credit_card',
        amount: 19.98
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message, 'Payment processed successfully');
  });
});
