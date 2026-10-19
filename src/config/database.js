import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// Create a connection pool with retry on disconnect
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'restaurant_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000,
  // Auto-reconnect on lost connection
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

export default pool;

export const query = async (sql, params) => {
  const [rows] = await pool.execute(sql, params);
  return rows;
};
