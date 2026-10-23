import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// Support DATABASE_URL / TiDB URI or individual environment variables
const dbConfig = process.env.DATABASE_URL
  ? {
      uri: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: true },
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 15000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'restaurant_db',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 15000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      ssl: (process.env.DB_SSL === 'true' || process.env.DB_HOST?.includes('tidbcloud.com'))
        ? { minVersion: 'TLSv1.2', rejectUnauthorized: true }
        : undefined
    };

const pool = mysql.createPool(dbConfig);

export default pool;

export const query = async (sql, params) => {
  const [rows] = await pool.execute(sql, params);
  return rows;
};
