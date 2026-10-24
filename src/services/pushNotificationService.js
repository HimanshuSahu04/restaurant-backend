import { Expo } from 'expo-server-sdk';
import pool from '../config/database.js';
import logger from '../utils/logger.js';

const expo = new Expo();

/**
 * Send push notification to a specific user by userId
 */
export async function sendPushNotificationToUser(userId, { title, body, data = {}, sound = 'default' }) {
  try {
    const [rows] = await pool.query('SELECT push_token FROM users WHERE id = ? AND push_token IS NOT NULL', [userId]);
    if (!rows || rows.length === 0 || !rows[0].push_token) {
      return;
    }
    const pushToken = rows[0].push_token;
    if (!Expo.isExpoPushToken(pushToken)) {
      logger.warn(`Invalid Expo push token for user ${userId}: ${pushToken}`);
      return;
    }

    const messages = [{
      to: pushToken,
      sound,
      title,
      body,
      data,
      priority: 'high',
      channelId: 'restaurant-alerts',
    }];

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
    logger.info(`Push notification sent to user ${userId}: "${title}"`);
  } catch (error) {
    logger.error(`Error sending push notification to user ${userId}:`, error.message);
  }
}

/**
 * Send push notification to all staff and owner users
 */
export async function sendPushNotificationToStaff({ title, body, data = {}, sound = 'default' }) {
  try {
    const [rows] = await pool.query(
      "SELECT id, push_token FROM users WHERE role IN ('staff', 'owner') AND push_token IS NOT NULL AND status = 'active'"
    );

    if (!rows || rows.length === 0) return;

    const messages = [];
    for (const user of rows) {
      if (Expo.isExpoPushToken(user.push_token)) {
        messages.push({
          to: user.push_token,
          sound,
          title,
          body,
          data,
          priority: 'high',
          channelId: 'restaurant-alerts',
        });
      }
    }

    if (messages.length === 0) return;

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
    logger.info(`Push notification sent to ${messages.length} staff/owner device(s): "${title}"`);
  } catch (error) {
    logger.error('Error sending push notification to staff/owner:', error.message);
  }
}

export default {
  sendPushNotificationToUser,
  sendPushNotificationToStaff,
};
