import express from 'express';
import pool from '../config/database.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Get tables for restaurant
router.get('/', async (req, res) => {
  try {
    const { restaurantId } = req.query;

    let tables;
    if (restaurantId && restaurantId !== 'demo-restaurant') {
      [tables] = await pool.query(
        'SELECT id, restaurant_id, table_number, capacity, status FROM tables WHERE restaurant_id = ? ORDER BY table_number ASC',
        [restaurantId]
      );
    } else {
      [tables] = await pool.query(
        'SELECT id, restaurant_id, table_number, capacity, status FROM tables ORDER BY table_number ASC'
      );
    }

    res.json(tables);
  } catch (error) {
    logger.error('Tables retrieval error:', error);
    res.status(500).json({ error: 'Tables retrieval failed' });
  }
});

import { authenticate, authorizeRoles } from '../middleware/auth.js';

// Update table status (e.g. available, occupied)
router.patch('/:id/status', authenticate, authorizeRoles('staff', 'owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    await pool.query('UPDATE tables SET status = ? WHERE id = ?', [status, id]);
    res.json({ success: true, id, status, message: 'Table status updated' });
  } catch (error) {
    logger.error('Update table status error:', error);
    res.status(500).json({ error: 'Failed to update table status' });
  }
});

export default router;

