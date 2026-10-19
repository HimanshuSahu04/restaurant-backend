import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import authRoutes from './routes/auth.js';
import orderRoutes from './routes/orders.js';
import menuRoutes from './routes/menu.js';
import paymentRoutes from './routes/payments.js';
import tableRoutes from './routes/tables.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './utils/logger.js';

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));

// Health check & root route
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Restaurant Management Backend API is running',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      orders: '/api/orders',
      menu: '/api/menu',
      payments: '/api/payments'
    }
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/tables', tableRoutes);

// Error handling middleware
app.use(errorHandler);

// Socket.IO connection
io.on('connection', (socket) => {
  logger.info(`New client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

export { io };
