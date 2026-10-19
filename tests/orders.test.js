import { describe, it, before, after } from 'node:test';
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
const orders = [];
const menuItems = [{ id: 'item-1', price: 9.99 }];
const restaurants = [{ id: 'rest-1' }];
const tables = [{ id: 'table-1' }];

app.post('/api/orders', (req, res) => {
  const order = { id: String(orders.length + 1), ...req.body, status: 'placed', payment_status: 'pending' };
  orders.push(order);
  res.status(201).json({ orderId: order.id });
});

app.get('/api/orders/:orderId', (req, res) => {
  const order = orders.find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order, items: [] });
});

app.patch('/api/orders/:orderId/status', (req, res) => {
  const order = orders.find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.status = req.body.status;
  res.json({ message: 'Order status updated' });
});

app.post('/api/orders/:orderId/cancel', (req, res) => {
  const order = orders.find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.status = 'cancelled';
  res.json({ message: 'Order cancelled' });
});

describe('Orders', () => {
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
  });

  it('should create a new order', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        restaurantId: 'rest-1',
        tableId: 'table-1',
        items: [{ menuItemId: 'item-1', quantity: 2, price: 9.99 }]
      });

    assert.strictEqual(res.status, 201);
    assert.ok(res.body.orderId);
    orderId = res.body.orderId;
  });

  it('should get order details', async () => {
    const res = await request(app)
      .get(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${authToken}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.order.id, orderId);
  });

  it('should update order status', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ status: 'accepted' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message, 'Order status updated');
  });

  it('should cancel an order', async () => {
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        restaurantId: 'rest-1',
        tableId: 'table-1',
        items: [{ menuItemId: 'item-1', quantity: 1, price: 9.99 }]
      });

    const orderToCancelId = createRes.body.orderId;

    const cancelRes = await request(app)
      .post(`/api/orders/${orderToCancelId}/cancel`)
      .set('Authorization', `Bearer ${authToken}`);

    assert.strictEqual(cancelRes.status, 200);
    assert.strictEqual(cancelRes.body.message, 'Order cancelled');
  });
});
