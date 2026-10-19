import { Server } from 'socket.io';
import { logger } from '../utils/logger.js';

const setupWebSocket = (server) => {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  io.on('connection', (socket) => {
    logger.info(`New client connected: ${socket.id}`);

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });

    // Handle order-related events
    socket.on('order:placed', (data) => {
      logger.info(`Order placed: ${data.orderId}`);
      io.emit('order:update', data);
    });

    socket.on('order:status', (data) => {
      logger.info(`Order status updated: ${data.orderId} - ${data.status}`);
      io.emit('order:update', data);
    });

    socket.on('order:cancelled', (data) => {
      logger.info(`Order cancelled: ${data.orderId}`);
      io.emit('order:update', data);
    });
  });

  return io;
};

export { setupWebSocket };
