import { after, before } from 'node:test';
import pool from '../src/config/database.js';
import { logger } from '../src/utils/logger.js';

// Setup test database
before(async () => {
  try {
    // Create test database
    await pool.query('CREATE DATABASE IF NOT EXISTS restaurant_db_test');
    await pool.query('USE restaurant_db_test');
    logger.info('Test database created and selected');
  } catch (error) {
    logger.error('Test database setup error:', error);
    throw error;
  }
});

// Cleanup test database
after(async () => {
  try {
    // Drop test database
    await pool.query('DROP DATABASE IF EXISTS restaurant_db_test');
    logger.info('Test database dropped');
  } catch (error) {
    logger.error('Test database cleanup error:', error);
    throw error;
  } finally {
    await pool.end();
  }
});
