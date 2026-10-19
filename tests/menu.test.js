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

// Mock menu routes
const categories = [{ id: 'cat-1', restaurant_id: 'rest-1', name: 'Test Category' }];
const menuItems = [{ id: 'item-1', category_id: 'cat-1', name: 'Test Item', price: 9.99 }];

app.get('/api/menu/categories', (req, res) => {
  const { restaurantId } = req.query;
  const filtered = categories.filter(c => c.restaurant_id === restaurantId);
  res.json(filtered);
});

app.get('/api/menu/items', (req, res) => {
  const { categoryId } = req.query;
  const filtered = menuItems.filter(i => i.category_id === categoryId);
  res.json(filtered);
});

describe('Menu', () => {
  let authToken;

  before(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'test@example.com',
        password: 'password123'
      });

    authToken = res.body.token;
  });

  it('should get menu categories', async () => {
    const res = await request(app)
      .get('/api/menu/categories')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ restaurantId: 'rest-1' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].id, 'cat-1');
  });

  it('should get menu items by category', async () => {
    const res = await request(app)
      .get('/api/menu/items')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ categoryId: 'cat-1' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].id, 'item-1');
  });
});
