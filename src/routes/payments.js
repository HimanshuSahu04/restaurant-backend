import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../config/database.js';
import { authenticate } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { mockPayment } from '../services/paymentService.js';

const router = express.Router();

// Process payment
router.post('/process', authenticate, async (req, res) => {
  try {
    const { orderId, paymentMethod, amount } = req.body;
    const userId = req.user.userId;

    // Check if the order belongs to the user
    const [orders] = await pool.query(
      'SELECT * FROM orders WHERE id = ? AND user_id = ?',
      [orderId, userId]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Process payment using mock payment service
    const paymentResult = await mockPayment({
      orderId,
      paymentMethod,
      amount
    });

    if (!paymentResult.success) {
      return res.status(400).json({ error: 'Payment failed' });
    }

    // Update order payment status
    await pool.query(
      'UPDATE orders SET payment_status = ? WHERE id = ?',
      ['paid', orderId]
    );

    res.json({ message: 'Payment processed successfully' });
  } catch (error) {
    logger.error('Payment processing error:', error);
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

export default router;
