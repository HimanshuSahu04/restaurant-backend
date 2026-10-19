import pool from '../src/config/database.js';

async function migrate() {
  try {
    const [cols] = await pool.query('DESCRIBE users');
    const colNames = cols.map(c => c.Field);

    if (!colNames.includes('username')) {
      await pool.query('ALTER TABLE users ADD COLUMN username VARCHAR(100) UNIQUE NULL AFTER name');
      console.log('Added username column');
    }
    if (!colNames.includes('employee_role')) {
      await pool.query('ALTER TABLE users ADD COLUMN employee_role VARCHAR(50) DEFAULT NULL AFTER role');
      console.log('Added employee_role column');
    }
    if (!colNames.includes('status')) {
      await pool.query("ALTER TABLE users ADD COLUMN status ENUM('pending_approval','active','rejected','removed') DEFAULT 'active' AFTER employee_role");
      console.log('Added status column');
    }
    if (!colNames.includes('removal_reason')) {
      await pool.query('ALTER TABLE users ADD COLUMN removal_reason TEXT NULL AFTER status');
      console.log('Added removal_reason column');
    }
    if (!colNames.includes('shift_start')) {
      await pool.query('ALTER TABLE users ADD COLUMN shift_start TIMESTAMP NULL AFTER removal_reason');
      console.log('Added shift_start column');
    }
    if (!colNames.includes('total_working_minutes')) {
      await pool.query('ALTER TABLE users ADD COLUMN total_working_minutes INT DEFAULT 0 AFTER shift_start');
      console.log('Added total_working_minutes column');
    }

    const [orderCols] = await pool.query('DESCRIBE orders');
    const orderColNames = orderCols.map(c => c.Field);

    if (!orderColNames.includes('served_by')) {
      await pool.query('ALTER TABLE orders ADD COLUMN served_by VARCHAR(36) NULL AFTER user_id');
      console.log('Added served_by to orders');
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_reviews (
        id VARCHAR(36) PRIMARY KEY,
        order_id VARCHAR(36) NOT NULL,
        user_id VARCHAR(36) NOT NULL,
        rating INT NOT NULL,
        comment TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Checked order_reviews table');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS employee_shift_logs (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        login_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        logout_at TIMESTAMP NULL,
        duration_minutes INT DEFAULT 0,
        orders_served_count INT DEFAULT 0
      )
    `);
    console.log('Checked employee_shift_logs table');

    await pool.query("UPDATE users SET username = 'owner' WHERE role = 'owner' AND (username IS NULL OR username = '')");
    await pool.query("UPDATE users SET username = 'staff' WHERE email = 'staff@example.com' AND (username IS NULL OR username = '')");

    console.log('Migration complete successfully!');
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
}

migrate();
