import { logger } from '../utils/logger.js';

const mockPayment = async ({ orderId, paymentMethod, amount }) => {
  return new Promise((resolve) => {
    // Simulate payment processing delay
    setTimeout(() => {
      const success = process.env.MOCK_PAYMENT_SUCCESS === 'true';
      logger.info(`Mock payment ${success ? 'successful' : 'failed'} for order ${orderId}`);
      resolve({ success });
    }, parseInt(process.env.MOCK_PAYMENT_DELAY) || 1000);
  });
};

export { mockPayment };
