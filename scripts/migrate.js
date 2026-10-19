import pool from '../src/config/database.js';
import { logger } from '../src/utils/logger.js';

const createTables = async () => {
  try {
    // Create database if it doesn't exist
    await pool.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\``);
    await pool.query(`USE \`${process.env.DB_NAME}\``);
    logger.info(`Using database: ${process.env.DB_NAME}`);

    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE,
        phone VARCHAR(20) UNIQUE,
        password_hash VARCHAR(255),
        role ENUM('customer', 'staff', 'owner') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Create restaurants table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS restaurants (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        address TEXT NOT NULL,
        phone VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Create tables table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tables (
        id VARCHAR(36) PRIMARY KEY,
        restaurant_id VARCHAR(36) NOT NULL,
        table_number INT NOT NULL,
        capacity INT NOT NULL,
        status ENUM('available', 'occupied', 'reserved') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
      )
    `);

    // Create menu_categories table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS menu_categories (
        id VARCHAR(36) PRIMARY KEY,
        restaurant_id VARCHAR(36) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
      )
    `);

    // Create menu_items table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS menu_items (
        id VARCHAR(36) PRIMARY KEY,
        category_id VARCHAR(36) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL,
        image_url TEXT,
        is_vegetarian BOOLEAN DEFAULT FALSE,
        is_jain BOOLEAN DEFAULT FALSE,
        is_available BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES menu_categories(id) ON DELETE CASCADE
      )
    `);

    // Create orders table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        restaurant_id VARCHAR(36) NOT NULL,
        table_id VARCHAR(36),
        status ENUM('placed', 'awaiting_acceptance', 'accepted', 'preparing', 'ready', 'served', 'cancelled', 'cancellation_requested', 'refund_pending', 'refund_completed') NOT NULL,
        total_amount DECIMAL(10, 2) NOT NULL,
        payment_status ENUM('pending', 'paid', 'refunded') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
        FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE SET NULL
      )
    `);

    // Create order_items table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id VARCHAR(36) PRIMARY KEY,
        order_id VARCHAR(36) NOT NULL,
        menu_item_id VARCHAR(36) NOT NULL,
        quantity INT NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        special_instructions TEXT,
        status ENUM('pending', 'preparing', 'ready', 'served', 'cancelled') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
      )
    `);

    // Create order_cancellations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_cancellations (
        id VARCHAR(36) PRIMARY KEY,
        order_id VARCHAR(36) NOT NULL,
        cancelled_by VARCHAR(36) NOT NULL,
        reason TEXT,
        status ENUM('requested', 'approved', 'rejected', 'cancelled', 'refund_pending', 'refund_completed') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Create order_support_requests table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_support_requests (
        id VARCHAR(36) PRIMARY KEY,
        order_id VARCHAR(36) NOT NULL,
        user_id VARCHAR(36) NOT NULL,
        type ENUM('replacement', 'refund', 'help') NOT NULL,
        reason TEXT,
        description TEXT,
        status ENUM('pending_review', 'approved', 'rejected', 'replacement_preparing', 'replacement_ready', 'refund_pending', 'refund_completed', 'closed') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Create otp_verifications table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_verifications (
        id VARCHAR(36) PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        otp VARCHAR(6) NOT NULL,
        purpose ENUM('login', 'registration') NOT NULL,
        payload JSON,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    logger.info('Database tables created successfully');
  } catch (error) {
    logger.error('Error creating database tables:', error);
    throw error;
  } finally {
    await pool.end();
  }
};

createTables();
