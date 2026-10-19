import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../config/database.js';
import { authenticate, authorizeRoles } from '../middleware/auth.js';
import { validateOrder } from '../middleware/validation.js';
import { logger } from '../utils/logger.js';
import { io } from '../server.js';

const router = express.Router();

// Get all orders for the authenticated user (with optional status filter)
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { status, filter } = req.query;

    let query = `
      SELECT o.*, t.table_number 
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      WHERE o.user_id = ?
    `;
    const params = [userId];

    if (filter === 'active') {
      query += ` AND o.status IN ('placed', 'awaiting_acceptance', 'accepted', 'preparing', 'ready', 'cancellation_requested')`;
    } else if (filter === 'completed') {
      query += ` AND o.status IN ('served', 'refund_completed')`;
    } else if (filter === 'cancelled') {
      query += ` AND o.status IN ('cancelled', 'refund_pending')`;
    } else if (status) {
      query += ` AND o.status = ?`;
      params.push(status);
    }

    query += ` ORDER BY o.created_at DESC`;

    const [orders] = await pool.query(query, params);

    // Fetch items and any open support requests for each order
    for (const order of orders) {
      const [items] = await pool.query(
        `SELECT oi.*, mi.name, mi.image_url, mi.is_vegetarian, mi.is_jain 
         FROM order_items oi
         JOIN menu_items mi ON oi.menu_item_id = mi.id
         WHERE oi.order_id = ?`,
        [order.id]
      );
      order.items = items;

      const [supportRequests] = await pool.query(
        `SELECT * FROM order_support_requests WHERE order_id = ? ORDER BY created_at DESC`,
        [order.id]
      );
      order.supportRequests = supportRequests;
    }

    res.json(orders);
  } catch (error) {
    logger.error('Orders listing error:', error);
    res.status(500).json({ error: 'Failed to retrieve orders' });
  }
});

// Create a new order
router.post('/', authenticate, validateOrder, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { restaurantId, tableId, items, purchaseGoldMember = false } = req.body;
    const userId = req.user.userId;
    const orderId = uuidv4();

    // Check user's current gold status and consistency
    const [userRows] = await connection.query(
      'SELECT id, is_gold, gold_expires_at, gold_type FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );
    const currentUser = userRows[0] || {};
    let isGoldActive = Boolean(currentUser.is_gold);
    if (isGoldActive && currentUser.gold_type === 'temporary' && currentUser.gold_expires_at) {
      if (new Date() > new Date(currentUser.gold_expires_at)) {
        isGoldActive = false;
        await connection.query('UPDATE users SET is_gold = 0, gold_type = "none" WHERE id = ?', [userId]);
      }
    }

    // Check past completed/active non-cancelled orders for consistency
    const [pastOrderRows] = await connection.query(
      'SELECT COUNT(*) as completedCount FROM orders WHERE user_id = ? AND status NOT IN ("cancelled", "refund_completed")',
      [userId]
    );
    const totalPreviousOrders = pastOrderRows[0]?.completedCount || 0;

    let becomesGold = isGoldActive;
    let newGoldType = currentUser.gold_type || 'none';
    let newExpiresAt = currentUser.gold_expires_at || null;

    // Condition 1: Purchased Rs.1 add-on (valid for 2 months)
    if (purchaseGoldMember) {
      becomesGold = true;
      if (newGoldType !== 'permanent') {
        newGoldType = 'temporary';
        const twoMonthsLater = new Date();
        twoMonthsLater.setMonth(twoMonthsLater.getMonth() + 2);
        newExpiresAt = twoMonthsLater;
      }
    }

    // Condition 2: Consistent dining - 2 or more previous non-cancelled orders makes the diner permanent Gold Member!
    if (totalPreviousOrders >= 2) {
      becomesGold = true;
      newGoldType = 'permanent';
      newExpiresAt = null;
    }

    if (becomesGold && (!isGoldActive || newGoldType === 'permanent' || purchaseGoldMember)) {
      await connection.query(
        'UPDATE users SET is_gold = 1, gold_type = ?, gold_expires_at = ? WHERE id = ?',
        [newGoldType, newExpiresAt, userId]
      );
      isGoldActive = true;
    }

    // Verify restaurant exists or fallback to seeded default
    let targetRestaurantId = restaurantId;
    const [restaurants] = await connection.query('SELECT id FROM restaurants WHERE id = ?', [restaurantId]);
    if (restaurants.length === 0) {
      const [defaultRest] = await connection.query('SELECT id FROM restaurants LIMIT 1');
      if (defaultRest.length > 0) {
        targetRestaurantId = defaultRest[0].id;
      }
    }

    // Verify table belongs to restaurant if supplied
    let targetTableId = null;
    if (tableId) {
      const [tableRows] = await connection.query('SELECT id, status FROM tables WHERE (id = ? OR table_number = ?) AND restaurant_id = ?', [tableId, tableId, targetRestaurantId]);
      if (tableRows.length > 0) {
        targetTableId = tableRows[0].id;
      }
    }

    // Authoritative price calculation from database
    let subtotal = 0;
    const verifiedItems = [];

    for (const item of items) {
      const [menuItems] = await connection.query(
        'SELECT id, name, price, is_available FROM menu_items WHERE id = ? LOCK IN SHARE MODE',
        [item.menuItemId]
      );

      if (menuItems.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: `Menu item ${item.menuItemId} not found` });
      }

      const menuItem = menuItems[0];
      if (!menuItem.is_available) {
        await connection.rollback();
        return res.status(400).json({ error: `${menuItem.name} is currently unavailable` });
      }

      const itemTotal = Number(menuItem.price) * item.quantity;
      subtotal += itemTotal;

      verifiedItems.push({
        id: uuidv4(),
        orderId,
        menuItemId: menuItem.id,
        quantity: item.quantity,
        price: menuItem.price,
        specialInstructions: item.specialInstructions || null,
        status: 'pending'
      });
    }

    // Add ₹1.00 add-on fee if customer opted to purchase Gold Membership
    const goldFee = purchaseGoldMember ? 1.00 : 0.00;
    const subtotalWithAddon = subtotal + goldFee;

    // Subtotal + 5% tax + 10% service charge
    const tax = Math.round(subtotalWithAddon * 0.05 * 100) / 100;
    const serviceCharge = Math.round(subtotalWithAddon * 0.10 * 100) / 100;
    const totalAmount = Math.round((subtotalWithAddon + tax + serviceCharge) * 100) / 100;

    // Priority flag: Gold Members get priority order handling
    const isPriorityOrder = becomesGold ? 1 : 0;

    // Create order with initial status 'placed'
    await connection.query(
      'INSERT INTO orders (id, user_id, restaurant_id, table_id, status, total_amount, payment_status, is_priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [orderId, userId, targetRestaurantId, targetTableId, 'placed', totalAmount, 'pending', isPriorityOrder]
    );

    // If order was placed for a dining table, immediately mark table as 'occupied'
    if (targetTableId) {
      await connection.query('UPDATE tables SET status = "occupied" WHERE id = ?', [targetTableId]);
    }

    // Create order items
    for (const item of verifiedItems) {
      await connection.query(
        'INSERT INTO order_items (id, order_id, menu_item_id, quantity, price, special_instructions, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [item.id, item.orderId, item.menuItemId, item.quantity, item.price, item.specialInstructions, item.status]
      );
    }

    await connection.commit();

    // Emit events
    io.emit('order:placed', {
      orderId,
      userId,
      restaurantId: targetRestaurantId,
      tableId: targetTableId,
      status: 'placed',
      isPriority: Boolean(isPriorityOrder),
      isGold: Boolean(becomesGold)
    });
    if (targetTableId) {
      io.emit('table:updated', { tableId: targetTableId, status: 'occupied' });
    }

    res.status(201).json({
      orderId,
      subtotal,
      goldFee,
      tax,
      serviceCharge,
      totalAmount,
      status: 'placed',
      isGold: Boolean(becomesGold),
      goldType: newGoldType,
      isPriority: Boolean(isPriorityOrder)
    });
  } catch (error) {
    await connection.rollback();
    logger.error('Order creation error:', error);
    res.status(500).json({ error: 'Order creation failed' });
  } finally {
    connection.release();
  }
});

// Get order details
router.get('/:orderId', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.userId;

    const [orders] = await pool.query(
      `SELECT o.*, t.table_number, r.name as restaurant_name 
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN restaurants r ON o.restaurant_id = r.id
       WHERE o.id = ? AND o.user_id = ?`,
      [orderId, userId]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    // Get order items with item details
    const [orderItems] = await pool.query(
      `SELECT oi.*, mi.name, mi.image_url, mi.is_vegetarian, mi.is_jain 
       FROM order_items oi
       JOIN menu_items mi ON oi.menu_item_id = mi.id
       WHERE oi.order_id = ?`,
      [orderId]
    );

    // Get cancellation record if any
    const [cancellations] = await pool.query(
      'SELECT * FROM order_cancellations WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
      [orderId]
    );

    // Get support requests if any
    const [supportRequests] = await pool.query(
      'SELECT * FROM order_support_requests WHERE order_id = ? ORDER BY created_at DESC',
      [orderId]
    );

    // Get customer review if any
    let review = null;
    try {
      const [reviewRows] = await pool.query(
        'SELECT * FROM order_reviews WHERE order_id = ? LIMIT 1',
        [orderId]
      );
      review = reviewRows[0] || null;
    } catch (e) {
      // Table may not have been queried yet
    }

    res.json({
      order,
      items: orderItems,
      cancellation: cancellations[0] || null,
      supportRequests,
      review
    });
  } catch (error) {
    logger.error('Order retrieval error:', error);
    res.status(500).json({ error: 'Order retrieval failed' });
  }
});

// Cancel or request cancellation of an order
router.post('/:orderId/cancel', authenticate, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { orderId } = req.params;
    const { reason = 'Customer requested cancellation' } = req.body;
    const userId = req.user.userId;

    // Lock order row for update
    const [orders] = await connection.query(
      'SELECT * FROM orders WHERE id = ? AND user_id = ? FOR UPDATE',
      [orderId, userId]
    );

    if (orders.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    // Business rule:
    // ALL customer cancellation attempts require Owner confirmation/approval.
    // No direct cancellation allowed without Owner confirmation.
    if (['placed', 'awaiting_acceptance', 'accepted', 'preparing'].includes(order.status)) {
      await connection.query('UPDATE orders SET status = "cancellation_requested" WHERE id = ?', [orderId]);

      const cancelRecordId = uuidv4();
      await connection.query(
        'INSERT INTO order_cancellations (id, order_id, cancelled_by, reason, status) VALUES (?, ?, ?, ?, ?)',
        [cancelRecordId, orderId, userId, `[Customer Request] ${reason}`, 'requested']
      );

      // Fetch table number and customer info for instant staff & owner notification
      const [tableRows] = await connection.query('SELECT table_number FROM tables WHERE id = ?', [order.table_id]);
      const [userRows] = await connection.query('SELECT name, phone FROM users WHERE id = ?', [userId]);

      const tableNumber = tableRows[0]?.table_number || null;
      const customerName = userRows[0]?.name || 'Valued Diner';

      await connection.commit();

      const notifPayload = {
        orderId,
        cancellationId: cancelRecordId,
        reason,
        tableNumber,
        customerName,
        totalAmount: order.total_amount,
        title: 'New Cancellation Request ⚠️',
        message: `Order #${orderId.slice(0, 8)} (${tableNumber ? `Table ${tableNumber}` : 'Takeaway'}) requested cancellation: "${reason}". Requires Owner confirmation.`
      };

      io.emit('order:cancellation_requested', notifPayload);
      io.emit('notification:owner', notifPayload);
      io.emit('order:status', { orderId, status: 'cancellation_requested' });

      return res.json({
        success: true,
        type: 'cancellation_requested',
        status: 'cancellation_requested',
        message: 'Cancellation requested. Awaiting Restaurant Owner confirmation.'
      });
    }

    // 2. Orders that are ready, served, or already cancelled cannot request cancellation

    // 3. Completed, ready, or already cancelled orders cannot be cancelled
    await connection.rollback();
    return res.status(400).json({
      error: `Orders with status "${order.status}" cannot be cancelled directly. Please contact staff or submit a support request.`
    });
  } catch (error) {
    await connection.rollback();
    logger.error('Order cancellation error:', error);
    res.status(500).json({ error: 'Order cancellation failed' });
  } finally {
    connection.release();
  }
});

// Submit a support request (Replacement, Refund, or Help)
router.post('/:orderId/support-requests', authenticate, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { orderId } = req.params;
    const { type, reason, description, menuItemId } = req.body;
    const userId = req.user.userId;

    if (!['replacement', 'refund', 'help'].includes(type)) {
      await connection.rollback();
      return res.status(400).json({ error: 'Invalid request type. Must be replacement, refund, or help.' });
    }

    const [orders] = await connection.query(
      'SELECT * FROM orders WHERE id = ? AND user_id = ? FOR UPDATE',
      [orderId, userId]
    );

    if (orders.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    // Only orders that are preparing, ready, or served qualify for return/replacement/refund support
    const eligibleStatuses = ['preparing', 'ready', 'served'];
    if (!eligibleStatuses.includes(order.status)) {
      await connection.rollback();
      return res.status(400).json({
        error: `Support requests can only be submitted for active or served orders (current status: ${order.status}).`
      });
    }

    // Check for duplicate pending requests of the same type on this order
    const [existing] = await connection.query(
      'SELECT id FROM order_support_requests WHERE order_id = ? AND type = ? AND status = "pending_review"',
      [orderId, type]
    );

    if (existing.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: `A pending ${type} request already exists for this order.` });
    }

    const requestId = uuidv4();
    const fullDescription = menuItemId ? `[Item ID: ${menuItemId}] ${description || ''}` : description;

    // Check if user is Gold Member for priority handling
    const [userRows] = await connection.query('SELECT is_gold, gold_expires_at, gold_type FROM users WHERE id = ?', [userId]);
    const isGoldUser = userRows[0]?.is_gold && (userRows[0]?.gold_type === 'permanent' || (userRows[0]?.gold_expires_at && new Date() <= new Date(userRows[0]?.gold_expires_at)));
    const isPrioritySupport = isGoldUser ? 1 : 0;

    await connection.query(
      'INSERT INTO order_support_requests (id, order_id, user_id, type, reason, description, status, is_priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [requestId, orderId, userId, type, reason || null, fullDescription || null, 'pending_review', isPrioritySupport]
    );

    await connection.commit();
    io.emit('order:support_requested', {
      requestId,
      orderId,
      type,
      reason,
      status: 'pending_review',
      isPriority: Boolean(isPrioritySupport),
      isGold: Boolean(isGoldUser)
    });

    res.status(201).json({
      success: true,
      requestId,
      status: 'pending_review',
      message: `${type.charAt(0).toUpperCase() + type.slice(1)} request submitted for restaurant review.`
    });
  } catch (error) {
    await connection.rollback();
    logger.error('Support request submission error:', error);
    res.status(500).json({ error: 'Failed to submit support request' });
  } finally {
    connection.release();
  }
});

// Dedicated Call Floor Waiter / Steward endpoint
router.post('/call-waiter', authenticate, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    let { tableNumber, tableId, reason, orderId } = req.body;
    const userId = req.user.userId;

    // Check if user is Gold Member for priority handling
    const [userRows] = await connection.query('SELECT name, phone, is_gold, gold_expires_at, gold_type FROM users WHERE id = ?', [userId]);
    const user = userRows[0] || {};
    const isGoldUser = user.is_gold && (user.gold_type === 'permanent' || (user.gold_expires_at && new Date() <= new Date(user.gold_expires_at)));
    const isPrioritySupport = isGoldUser ? 1 : 0;

    // If orderId or tableNumber is not provided, look up the user's latest active order or table
    if (!orderId && !tableNumber) {
      const [activeOrders] = await connection.query(`
        SELECT o.id, o.table_id, t.table_number
        FROM orders o
        LEFT JOIN tables t ON o.table_id = t.id
        WHERE o.user_id = ? AND o.status IN ('placed', 'accepted', 'preparing', 'ready', 'served')
        ORDER BY o.created_at DESC LIMIT 1
      `, [userId]);

      if (activeOrders.length > 0) {
        orderId = activeOrders[0].id;
        if (!tableNumber && activeOrders[0].table_number) {
          tableNumber = activeOrders[0].table_number;
          tableId = activeOrders[0].table_id;
        }
      }
    }

    // If tableNumber was provided but tableId wasn't, look up tableId
    if (tableNumber && !tableId) {
      const [tableRows] = await connection.query('SELECT id FROM tables WHERE table_number = ? LIMIT 1', [tableNumber]);
      if (tableRows.length > 0) {
        tableId = tableRows[0].id;
      }
    }

    const requestId = uuidv4();
    const serviceReason = reason || 'Customer requested floor waiter assistance at table';

    await connection.query(
      'INSERT INTO order_support_requests (id, order_id, table_number, user_id, type, reason, description, status, is_priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [requestId, orderId || null, tableNumber || null, userId, 'waiter_call', serviceReason, `Table ${tableNumber || 'Assigned'} - ${user.name || 'Customer'} called waiter`, 'pending_review', isPrioritySupport]
    );

    await connection.commit();

    const waiterPayload = {
      requestId,
      orderId: orderId || null,
      tableNumber: tableNumber || 'Assigned Table',
      tableId: tableId || null,
      customerName: user.name || 'Diner',
      customerPhone: user.phone || '',
      reason: serviceReason,
      type: 'waiter_call',
      status: 'pending_review',
      isPriority: Boolean(isPrioritySupport),
      isGold: Boolean(isGoldUser),
      requestedAt: new Date().toISOString(),
      title: isGoldUser ? '⭐ Priority: Waiter Assistance Required' : '🔔 Waiter Assistance Called',
      message: `${isGoldUser ? '[GOLD MEMBER] ' : ''}Customer ${user.name || 'Diner'} is requesting a waiter at Table ${tableNumber || 'Floor'} for: "${serviceReason}".`
    };

    // Emit real-time socket events for staff & waiters
    io.emit('waiter:called', waiterPayload);
    io.emit('order:support_requested', waiterPayload);
    io.emit('notification:staff', waiterPayload);

    res.status(201).json({
      success: true,
      requestId,
      tableNumber,
      isPriority: Boolean(isPrioritySupport),
      isGold: Boolean(isGoldUser),
      message: `Waiter has been notified! A steward is attending Table ${tableNumber || 'your table'}.`
    });
  } catch (error) {
    await connection.rollback();
    logger.error('Call waiter error:', error);
    res.status(500).json({ error: 'Failed to notify waiter. Please try again.' });
  } finally {
    connection.release();
  }
});

// Get support requests for an order
router.get('/:orderId/support-requests', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.userId;

    const [requests] = await pool.query(
      `SELECT sr.* 
       FROM order_support_requests sr
       JOIN orders o ON sr.order_id = o.id
       WHERE sr.order_id = ? AND o.user_id = ?
       ORDER BY sr.created_at DESC`,
      [orderId, userId]
    );

    res.json(requests);
  } catch (error) {
    logger.error('Support requests retrieval error:', error);
    res.status(500).json({ error: 'Failed to retrieve support requests' });
  }
});

// =========================================================================
// STAFF & OWNER MANAGEMENT ENDPOINTS
// =========================================================================

// 1. Get all active & history orders for staff/owner dashboard
router.get('/staff/all', authenticate, authorizeRoles('staff', 'owner'), async (req, res) => {
  try {
    const { status, filter } = req.query;

    let query = `
      SELECT o.*, t.table_number, u.name as customer_name, u.phone as customer_phone, u.email as customer_email, u.is_gold, u.gold_type
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN users u ON o.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (filter === 'incoming') {
      query += ` AND o.status IN ('placed', 'awaiting_acceptance')`;
    } else if (filter === 'active') {
      query += ` AND o.status IN ('accepted', 'preparing', 'ready')`;
    } else if (filter === 'served') {
      query += ` AND o.status = 'served'`;
    } else if (filter === 'cancellation_requests') {
      query += ` AND o.status = 'cancellation_requested'`;
    } else if (status) {
      query += ` AND o.status = ?`;
      params.push(status);
    }

    query += ` ORDER BY o.is_priority DESC, o.created_at DESC`;

    const [orders] = await pool.query(query, params);

    for (const order of orders) {
      const [items] = await pool.query(
        `SELECT oi.*, mi.name, mi.image_url, mi.is_vegetarian, mi.is_jain
         FROM order_items oi
         JOIN menu_items mi ON oi.menu_item_id = mi.id
         WHERE oi.order_id = ?`,
        [order.id]
      );
      order.items = items;

      const [cancellations] = await pool.query(
        `SELECT * FROM order_cancellations WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`,
        [order.id]
      );
      order.cancellation = cancellations[0] || null;

      const [supportRequests] = await pool.query(
        `SELECT * FROM order_support_requests WHERE order_id = ? ORDER BY created_at DESC`,
        [order.id]
      );
      order.supportRequests = supportRequests;
    }

    res.json(orders);
  } catch (error) {
    logger.error('Staff orders retrieval error:', error);
    res.status(500).json({ error: 'Failed to retrieve restaurant orders' });
  }
});

// 2. Staff/Chef order acceptance (CRITICAL: Closes customer direct-cancellation window atomically)
router.post('/:orderId/accept', authenticate, authorizeRoles('staff', 'owner'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { orderId } = req.params;

    // Lock order row for update
    const [orders] = await connection.query(
      'SELECT * FROM orders WHERE id = ? FOR UPDATE',
      [orderId]
    );

    if (orders.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    // Atomicity check: Customer direct-cancellation might have occurred concurrently
    if (order.status === 'cancelled' || order.status === 'refund_pending' || order.status === 'refund_completed') {
      await connection.rollback();
      return res.status(409).json({
        error: `Order was already cancelled by the customer before acceptance.`,
        currentStatus: order.status
      });
    }

    if (order.status !== 'placed' && order.status !== 'awaiting_acceptance') {
      await connection.rollback();
      return res.status(400).json({
        error: `Order is already in state '${order.status}' and cannot be re-accepted.`
      });
    }

    // Authoritative transition: 'accepted'
    await connection.query('UPDATE orders SET status = "accepted" WHERE id = ?', [orderId]);
    await connection.query('UPDATE order_items SET status = "accepted" WHERE order_id = ?', [orderId]);

    // Mark table occupied if table_id is set
    if (order.table_id) {
      await connection.query('UPDATE tables SET status = "occupied" WHERE id = ?', [order.table_id]);
    }

    await connection.commit();

    io.emit('order:status', { orderId, status: 'accepted', updatedBy: req.user.role });
    io.emit('order:accepted', { orderId, status: 'accepted' });

    res.json({
      success: true,
      orderId,
      status: 'accepted',
      message: 'Order accepted by kitchen. Direct customer cancellation window is now closed.'
    });
  } catch (error) {
    await connection.rollback();
    logger.error('Order acceptance error:', error);
    res.status(500).json({ error: 'Failed to accept order' });
  } finally {
    connection.release();
  }
});

// 3. Staff/Chef reject incoming order (with reason)
router.post('/:orderId/reject', authenticate, authorizeRoles('staff', 'owner'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { orderId } = req.params;
    const { reason = 'Order cancellation requested' } = req.body;
    const isOwner = req.user.role === 'owner';

    const [orders] = await connection.query(
      'SELECT o.*, t.table_number FROM orders o LEFT JOIN tables t ON o.table_id = t.id WHERE o.id = ? FOR UPDATE',
      [orderId]
    );

    if (orders.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    // Orders that are already 'ready', 'served', or 'cancelled' cannot be cancelled/rejected here
    if (['ready', 'served', 'cancelled', 'refund_completed'].includes(order.status)) {
      await connection.rollback();
      return res.status(400).json({
        error: `Order cannot be cancelled because it is already marked "${order.status}". Cancellation is only allowed before marking "ready".`
      });
    }

    // SCENARIO A: RESTAURANT OWNER (Direct Cancellation before 'ready')
    if (isOwner) {
      const nextStatus = order.payment_status === 'paid' ? 'refund_pending' : 'cancelled';

      await connection.query('UPDATE orders SET status = ? WHERE id = ?', [nextStatus, orderId]);
      await connection.query('UPDATE order_items SET status = "cancelled" WHERE order_id = ?', [orderId]);

      // Record in audit table as approved cancellation by owner
      await connection.query(
        'INSERT INTO order_cancellations (id, order_id, cancelled_by, reason, status) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), orderId, req.user.userId, `[Owner Direct Cancellation] ${reason}`, 'approved']
      );

      // Free table immediately if no other active orders
      let tableFreed = false;
      if (order.table_id) {
        const [otherOrders] = await connection.query(
          'SELECT id FROM orders WHERE table_id = ? AND id != ? AND status IN ("placed", "awaiting_acceptance", "accepted", "preparing", "ready", "served")',
          [order.table_id, orderId]
        );
        if (otherOrders.length === 0) {
          await connection.query('UPDATE tables SET status = "available" WHERE id = ?', [order.table_id]);
          tableFreed = true;
          io.emit('table:updated', { tableId: order.table_id, status: 'available' });
        }
      }

      await connection.commit();

      io.emit('order:status', { orderId, status: nextStatus, reason });
      io.emit('order:cancelled', { orderId, status: nextStatus, reason, tableFreed, cancelledByRole: 'owner' });

      return res.json({
        success: true,
        orderId,
        status: nextStatus,
        tableFreed,
        message: `Order #${orderId.slice(0, 8)} cancelled directly by Owner.`
      });
    }

    // SCENARIO B: CHEF / WAITER / STAFF
    // Any cancellation initiated by Chef/Waiter (whether incoming or preparing) must be submitted as a request to the Owner!
    // The Owner has sole authority to confirm and approve cancellation.
    await connection.query('UPDATE orders SET status = "cancellation_requested" WHERE id = ?', [orderId]);

    const cancellationId = uuidv4();
    await connection.query(
      'INSERT INTO order_cancellations (id, order_id, cancelled_by, reason, status) VALUES (?, ?, ?, ?, ?)',
      [cancellationId, orderId, req.user.userId, `[Staff Request] ${reason}`, 'requested']
    );

    // Get staff requester user detail
    const [staffUsers] = await connection.query('SELECT name, role, employee_role FROM users WHERE id = ?', [req.user.userId]);
    const requesterName = staffUsers[0]?.name || 'Chef / Staff Member';
    const requesterStaffRole = staffUsers[0]?.employee_role || 'Staff';

    await connection.commit();

    const notifPayload = {
      orderId,
      cancellationId,
      tableNumber: order.table_number,
      requestedBy: requesterName,
      requesterRole: 'staff',
      employeeRole: requesterStaffRole,
      reason,
      title: 'Staff Cancellation Request 👨‍🍳',
      message: `${requesterName} (${requesterStaffRole}) requested cancellation for Order #${orderId.slice(0, 8)} (${order.table_number ? `Table ${order.table_number}` : 'Takeaway'}): "${reason}". Awaiting Owner confirmation.`
    };

    io.emit('order:status', { orderId, status: 'cancellation_requested' });
    io.emit('order:cancellation_requested', notifPayload);
    io.emit('notification:owner', notifPayload);

    return res.json({
      success: true,
      orderId,
      status: 'cancellation_requested',
      message: `Cancellation request sent to Restaurant Owner for confirmation.`
    });
  } catch (error) {
    await connection.rollback();
    logger.error('Order cancel/reject error:', error);
    res.status(500).json({ error: 'Failed to process cancellation' });
  } finally {
    connection.release();
  }
});

// 4. Update order lifecycle status (accepted -> preparing -> ready -> served)
router.patch('/:orderId/status', authenticate, authorizeRoles('staff', 'owner'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { orderId } = req.params;
    const { status } = req.body;

    const validTransitions = ['preparing', 'ready', 'served'];
    if (!validTransitions.includes(status)) {
      await connection.rollback();
      return res.status(400).json({ error: `Invalid target status. Must be one of: ${validTransitions.join(', ')}` });
    }

    const [orders] = await connection.query(
      'SELECT * FROM orders WHERE id = ? FOR UPDATE',
      [orderId]
    );

    if (orders.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    // Prevent moving cancelled orders forward
    if (['cancelled', 'cancellation_requested', 'refund_pending', 'refund_completed'].includes(order.status)) {
      await connection.rollback();
      return res.status(400).json({ error: `Cannot advance an order that is ${order.status}` });
    }

    let servedUpdate = '';
    const updateParams = [status];
    if (status === 'served') {
      servedUpdate = ', served_by = COALESCE(served_by, ?)';
      updateParams.push(req.user.userId);
    }
    updateParams.push(orderId);

    await connection.query(`UPDATE orders SET status = ? ${servedUpdate} WHERE id = ?`, updateParams);
    await connection.query('UPDATE order_items SET status = ? WHERE order_id = ?', [status, orderId]);

    // Do NOT automatically free table when marked served unless payment is also completed ('paid')
    if (status === 'served' && order.table_id && order.payment_status === 'paid') {
      const [unpaidOrActive] = await connection.query(
        'SELECT id FROM orders WHERE table_id = ? AND id != ? AND (payment_status != "paid" OR status IN ("placed", "accepted", "preparing", "ready"))',
        [order.table_id, orderId]
      );
      if (unpaidOrActive.length === 0) {
        await connection.query('UPDATE tables SET status = "available" WHERE id = ?', [order.table_id]);
        io.emit('table:updated', { tableId: order.table_id, status: 'available' });
      }
    }

    await connection.commit();

    io.emit('order:status', { orderId, status });

    res.json({
      success: true,
      orderId,
      status,
      message: `Order status advanced to ${status}.`
    });
  } catch (error) {
    await connection.rollback();
    logger.error('Order status update error:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  } finally {
    connection.release();
  }
});

// 4b. Owner & Staff: Confirm Bill Payment (Marks order as paid and releases the dining table)
router.post('/:orderId/mark-paid', authenticate, authorizeRoles('staff', 'owner'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { orderId } = req.params;

    const [orders] = await connection.query(
      'SELECT * FROM orders WHERE id = ? FOR UPDATE',
      [orderId]
    );

    if (orders.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    if (['cancelled', 'cancellation_requested', 'refund_pending', 'refund_completed'].includes(order.status)) {
      await connection.rollback();
      return res.status(400).json({ error: `Cannot mark payment as paid for a cancelled order (status: ${order.status}).` });
    }

    // Update payment status to 'paid'
    await connection.query('UPDATE orders SET payment_status = "paid" WHERE id = ?', [orderId]);

    // Check if table can now be freed
    let tableFreed = false;
    if (order.table_id) {
      const [unpaidOrActive] = await connection.query(
        'SELECT id FROM orders WHERE table_id = ? AND id != ? AND (payment_status != "paid" OR status IN ("placed", "accepted", "preparing", "ready"))',
        [order.table_id, orderId]
      );

      // Only free if no other unpaid or active kitchen orders remain on this table
      if (unpaidOrActive.length === 0) {
        await connection.query('UPDATE tables SET status = "available" WHERE id = ?', [order.table_id]);
        tableFreed = true;
        io.emit('table:updated', { tableId: order.table_id, status: 'available' });
      }
    }

    await connection.commit();

    io.emit('order:payment', { orderId, payment_status: 'paid', tableFreed });
    io.emit('order:status', { orderId, payment_status: 'paid' });

    res.json({
      success: true,
      orderId,
      payment_status: 'paid',
      tableFreed,
      message: tableFreed
        ? 'Payment recorded successfully. Table is now marked Available.'
        : 'Payment recorded successfully.'
    });
  } catch (error) {
    await connection.rollback();
    logger.error('Mark paid error:', error);
    res.status(500).json({ error: 'Failed to record payment' });
  } finally {
    connection.release();
  }
});

// 5. Customer Requests Queue (cancellations + support cases)
router.get('/staff/requests', authenticate, authorizeRoles('staff', 'owner'), async (req, res) => {
  try {
    // 5a. Active customer and staff cancellation requests
    const [cancellationRequests] = await pool.query(`
      SELECT oc.*, o.total_amount, o.payment_status, o.status as order_status, o.table_id,
             t.table_number, u.name as customer_name, u.phone as customer_phone, u.role as requester_role
      FROM order_cancellations oc
      JOIN orders o ON oc.order_id = o.id
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN users u ON oc.cancelled_by = u.id
      WHERE oc.status = 'requested' OR o.status = 'cancellation_requested'
      ORDER BY oc.created_at DESC
    `);

    // Attach items to cancellation requests
    for (const reqItem of cancellationRequests) {
      const [items] = await pool.query(
        `SELECT oi.*, mi.name FROM order_items oi JOIN menu_items mi ON oi.menu_item_id = mi.id WHERE oi.order_id = ?`,
        [reqItem.order_id]
      );
      reqItem.items = items;
    }

    // 5b. Support requests (replacements, refunds, help, waiter_call)
    const [supportRequests] = await pool.query(`
      SELECT sr.*, o.total_amount, o.payment_status, o.status as order_status, o.table_id,
             COALESCE(sr.table_number, t.table_number) as table_number,
             u.name as customer_name, u.phone as customer_phone, u.is_gold, u.gold_type
      FROM order_support_requests sr
      LEFT JOIN orders o ON sr.order_id = o.id
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN users u ON sr.user_id = u.id
      ORDER BY sr.is_priority DESC, sr.created_at DESC
    `);

    res.json({
      cancellations: cancellationRequests,
      supportRequests
    });
  } catch (error) {
    logger.error('Staff requests retrieval error:', error);
    res.status(500).json({ error: 'Failed to retrieve customer requests' });
  }
});

// 6. Review & decide on Cancellation Request (RESTAURANT OWNER ONLY)
router.post('/:orderId/cancellation-decision', authenticate, authorizeRoles('owner'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { orderId } = req.params;
    const { decision, staffNote } = req.body; // 'approve' or 'reject'

    if (req.user.role !== 'owner') {
      await connection.rollback();
      return res.status(403).json({ error: 'Only the Restaurant Owner has authority to confirm or approve order cancellations.' });
    }

    if (!['approve', 'reject'].includes(decision)) {
      await connection.rollback();
      return res.status(400).json({ error: "Decision must be 'approve' or 'reject'" });
    }

    const [orders] = await connection.query(
      'SELECT * FROM orders WHERE id = ? FOR UPDATE',
      [orderId]
    );

    if (orders.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];

    // If decision is approve
    if (decision === 'approve') {
      const nextStatus = order.payment_status === 'paid' ? 'refund_pending' : 'cancelled';

      await connection.query('UPDATE orders SET status = ? WHERE id = ?', [nextStatus, orderId]);
      await connection.query('UPDATE order_items SET status = "cancelled" WHERE order_id = ?', [orderId]);
      await connection.query(
        'UPDATE order_cancellations SET status = "approved" WHERE order_id = ? AND status = "requested"',
        [orderId]
      );

      // Free table if occupied immediately
      if (order.table_id) {
        const [otherOrders] = await connection.query(
          'SELECT id FROM orders WHERE table_id = ? AND id != ? AND status IN ("placed", "awaiting_acceptance", "accepted", "preparing", "ready", "served")',
          [order.table_id, orderId]
        );
        if (otherOrders.length === 0) {
          await connection.query('UPDATE tables SET status = "available" WHERE id = ?', [order.table_id]);
          io.emit('table:updated', { tableId: order.table_id, status: 'available' });
        }
      }

      await connection.commit();
      io.emit('order:status', { orderId, status: nextStatus });
      io.emit('order:cancelled', { orderId, status: nextStatus, note: staffNote });
      io.emit('order:cancellation_decision', {
        orderId,
        decision: 'approved',
        status: nextStatus,
        userId: order.user_id,
        title: 'Cancellation Approved',
        message: staffNote
          ? `Your cancellation request was approved by the restaurant. Note: "${staffNote}"`
          : 'Your cancellation request was approved by the restaurant.'
      });

      return res.json({
        success: true,
        orderId,
        status: nextStatus,
        message: 'Cancellation request approved by restaurant.'
      });
    } else {
      // Rejection: revert order back to its working state (e.g. 'preparing')
      await connection.query('UPDATE orders SET status = "preparing" WHERE id = ?', [orderId]);
      await connection.query(
        'UPDATE order_cancellations SET status = "rejected" WHERE order_id = ? AND status = "requested"',
        [orderId]
      );

      await connection.commit();
      io.emit('order:status', { orderId, status: 'preparing' });
      io.emit('order:cancellation_decision', {
        orderId,
        decision: 'rejected',
        status: 'preparing',
        userId: order.user_id,
        title: 'Cancellation Request Declined',
        message: staffNote
          ? `Your order cancellation request was declined by the restaurant: "${staffNote}". Preparation continues.`
          : 'The restaurant cannot cancel your order at this stage because kitchen preparation is actively underway.'
      });

      return res.json({
        success: true,
        orderId,
        status: 'preparing',
        message: 'Cancellation request rejected. Order resumed preparation.'
      });
    }
  } catch (error) {
    await connection.rollback();
    logger.error('Cancellation decision error:', error);
    res.status(500).json({ error: 'Failed to process cancellation decision' });
  } finally {
    connection.release();
  }
});

// 7. Review & decide on Support Request (Replacement, Refund, Help)
router.post('/support-requests/:requestId/decision', authenticate, authorizeRoles('staff', 'owner'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { requestId } = req.params;
    const { decision, note } = req.body; // 'approve', 'reject', 'progress', 'complete'
    const userRole = req.user.role;

    const [requests] = await connection.query(
      'SELECT sr.*, o.payment_status, o.total_amount FROM order_support_requests sr LEFT JOIN orders o ON sr.order_id = o.id WHERE sr.id = ? FOR UPDATE',
      [requestId]
    );

    if (requests.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Support request not found' });
    }

    const request = requests[0];

    // Enforce Owner-Only rule for refunds if required
    if (request.type === 'refund' && decision === 'approve' && userRole !== 'owner') {
      await connection.rollback();
      return res.status(403).json({
        error: 'Only Restaurant Owners have authority to approve monetary refunds.'
      });
    }

    let nextSupportStatus = request.status;
    let nextOrderStatus = undefined;

    if (decision === 'approve') {
      if (request.type === 'replacement') {
        nextSupportStatus = 'replacement_preparing';
      } else if (request.type === 'refund') {
        nextSupportStatus = 'refund_pending';
        nextOrderStatus = 'refund_pending';
      } else {
        nextSupportStatus = 'approved';
      }
    } else if (decision === 'reject') {
      nextSupportStatus = 'rejected';
    } else if (decision === 'progress') {
      if (request.type === 'replacement') {
        nextSupportStatus = 'replacement_ready';
      }
    } else if (decision === 'complete') {
      if (request.type === 'refund') {
        nextSupportStatus = 'refund_completed';
        nextOrderStatus = 'refund_completed';
        await connection.query('UPDATE orders SET payment_status = "refunded" WHERE id = ?', [request.order_id]);
      } else {
        nextSupportStatus = 'closed';
      }
    }

    await connection.query(
      'UPDATE order_support_requests SET status = ?, description = CONCAT(COALESCE(description, ""), " [Note: ", ?, "]") WHERE id = ?',
      [nextSupportStatus, note || `Updated to ${nextSupportStatus} by ${userRole}`, requestId]
    );

    if (nextOrderStatus) {
      await connection.query('UPDATE orders SET status = ? WHERE id = ?', [nextOrderStatus, request.order_id]);
      io.emit('order:status', { orderId: request.order_id, status: nextOrderStatus });
    }

    await connection.commit();
    io.emit('order:support_updated', { requestId, orderId: request.order_id, status: nextSupportStatus, decision });

    res.json({
      success: true,
      requestId,
      status: nextSupportStatus,
      message: `Support case successfully updated to ${nextSupportStatus}.`
    });
  } catch (error) {
    await connection.rollback();
    logger.error('Support decision error:', error);
    res.status(500).json({ error: 'Failed to process support decision' });
  } finally {
    connection.release();
  }
});

// 8. Owner-Only Dashboard & Reports analytics
router.get('/owner/reports', authenticate, authorizeRoles('owner'), async (req, res) => {
  try {
    const { period = 'today' } = req.query;

    let dateCondition = 'DATE(created_at) = CURDATE()';
    if (period === 'week') {
      dateCondition = 'created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
    } else if (period === 'month') {
      dateCondition = 'created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
    } else if (period === 'year') {
      dateCondition = 'created_at >= DATE_SUB(NOW(), INTERVAL 1 YEAR)';
    }

    // 1. Total sales and orders
    const [salesRow] = await pool.query(`
      SELECT 
        COUNT(*) as totalOrders,
        COALESCE(SUM(CASE WHEN status NOT IN ('cancelled', 'refund_completed') THEN total_amount ELSE 0 END), 0) as totalRevenue,
        COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END), 0) as paidCollection,
        COALESCE(SUM(CASE WHEN status IN ('cancelled', 'refund_completed') THEN 1 ELSE 0 END), 0) as cancelledOrders,
        COALESCE(SUM(CASE WHEN status = 'refund_completed' OR payment_status = 'refunded' THEN total_amount ELSE 0 END), 0) as refundedAmount
      FROM orders
      WHERE ${dateCondition}
    `);

    // 2. Orders by status
    const [statusBreakdown] = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM orders
      WHERE ${dateCondition}
      GROUP BY status
    `);

    // 3. Top selling menu items
    const [topDishes] = await pool.query(`
      SELECT mi.name, mi.price, mi.is_vegetarian, SUM(oi.quantity) as totalSold, SUM(oi.quantity * oi.price) as revenue
      FROM order_items oi
      JOIN menu_items mi ON oi.menu_item_id = mi.id
      JOIN orders o ON oi.order_id = o.id
      WHERE ${dateCondition.replace(/created_at/g, 'o.created_at')} AND o.status NOT IN ('cancelled', 'refund_completed')
      GROUP BY mi.id, mi.name, mi.price, mi.is_vegetarian
      ORDER BY totalSold DESC
      LIMIT 5
    `);

    // 4. Pending owner approvals count
    const [pendingApprovals] = await pool.query(`
      SELECT COUNT(*) as count 
      FROM order_support_requests 
      WHERE status = 'pending_review' OR status = 'refund_pending'
    `);

    // 5. Cancelled Orders List with reason, initiator (user/staff/owner), and details
    const [cancelledOrdersList] = await pool.query(`
      SELECT 
        o.id as order_id,
        o.table_id,
        t.table_number,
        o.total_amount,
        o.payment_status,
        o.status as order_status,
        o.created_at as order_created_at,
        c.id as cancellation_id,
        c.reason as cancellation_reason,
        c.status as cancellation_status,
        c.created_at as cancelled_at,
        u.id as cancelled_by_id,
        u.name as cancelled_by_name,
        u.role as cancelled_by_role,
        u.employee_role as cancelled_by_employee_role,
        cust.name as customer_name,
        cust.phone as customer_phone
      FROM orders o
      JOIN order_cancellations c ON o.id = c.order_id
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN users u ON c.cancelled_by = u.id
      LEFT JOIN users cust ON o.user_id = cust.id
      WHERE ${dateCondition.replace(/created_at/g, 'o.created_at')}
        AND (o.status IN ('cancelled', 'refund_pending', 'refund_completed') OR c.status IN ('approved', 'cancelled'))
      ORDER BY c.created_at DESC
    `);

    // Attach items to cancelled orders
    for (const cord of cancelledOrdersList) {
      const [items] = await pool.query(
        `SELECT oi.*, mi.name FROM order_items oi JOIN menu_items mi ON oi.menu_item_id = mi.id WHERE oi.order_id = ?`,
        [cord.order_id]
      );
      cord.items = items;
    }

    // 6. Replacement and Refund Support Requests List with reasons & decisions
    const [supportOrdersList] = await pool.query(`
      SELECT 
        sr.id as request_id,
        sr.order_id,
        sr.type as support_type,
        sr.reason as support_reason,
        sr.description as support_description,
        sr.status as support_status,
        sr.created_at as request_created_at,
        o.table_id,
        t.table_number,
        o.total_amount,
        o.payment_status,
        o.status as order_status,
        u.name as customer_name,
        u.phone as customer_phone,
        mi.name as specific_item_name
      FROM order_support_requests sr
      JOIN orders o ON sr.order_id = o.id
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN users u ON sr.user_id = u.id
      LEFT JOIN menu_items mi ON sr.reason LIKE CONCAT('%', mi.name, '%')
      WHERE ${dateCondition.replace(/created_at/g, 'sr.created_at')}
        AND sr.type IN ('replacement', 'refund')
      ORDER BY sr.created_at DESC
    `);

    // Attach items to support orders
    for (const sord of supportOrdersList) {
      const [items] = await pool.query(
        `SELECT oi.*, mi.name FROM order_items oi JOIN menu_items mi ON oi.menu_item_id = mi.id WHERE oi.order_id = ?`,
        [sord.order_id]
      );
      sord.items = items;
    }

    res.json({
      summary: salesRow[0],
      statusBreakdown,
      topDishes,
      pendingApprovalsCount: pendingApprovals[0]?.count || 0,
      cancelledOrdersList,
      supportOrdersList
    });
  } catch (error) {
    logger.error('Owner reports error:', error);
    res.status(500).json({ error: 'Failed to generate owner reports' });
  }
});

// ========================================================
// 8. Today's Order History (Tablewise with Reviews, Dishes & Paid Status)
// ========================================================
router.get('/owner/today-history', authenticate, authorizeRoles('owner'), async (req, res) => {
  try {
    const [orders] = await pool.query(`
      SELECT o.*, t.table_number, u.name as customer_name,
             s.name as served_by_name, s.employee_role as served_by_role,
             r.rating as review_rating, r.comment as review_comment
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN users u ON o.user_id = u.id
      LEFT JOIN users s ON o.served_by = s.id
      LEFT JOIN order_reviews r ON o.id = r.order_id
      WHERE DATE(o.created_at) = CURDATE()
      ORDER BY t.table_number ASC, o.created_at DESC
    `);

    // Attach items to each order
    for (const order of orders) {
      const [items] = await pool.query(
        `SELECT oi.*, mi.name FROM order_items oi JOIN menu_items mi ON oi.menu_item_id = mi.id WHERE oi.order_id = ?`,
        [order.id]
      );
      order.items = items;
    }

    // Group tablewise
    const tablewise = {};
    for (const order of orders) {
      const tableKey = order.table_number ? `Table ${order.table_number}` : 'Takeaway / Other';
      if (!tablewise[tableKey]) {
        tablewise[tableKey] = [];
      }
      tablewise[tableKey].push(order);
    }

    res.json({
      success: true,
      totalOrders: orders.length,
      orders,
      tablewise
    });
  } catch (error) {
    logger.error('Today history error:', error);
    res.status(500).json({ error: 'Failed to retrieve today order history' });
  }
});

// ========================================================
// 9. Employee Management (Roster, Hours, Service Log & Add/Remove)
// ========================================================
router.get('/owner/employees', authenticate, authorizeRoles('owner'), async (req, res) => {
  try {
    const [employees] = await pool.query(`
      SELECT u.id, u.name, u.username, u.email, u.phone, u.role, u.employee_role,
             u.status, u.removal_reason, u.shift_start, u.total_working_minutes,
             u.created_at,
             COUNT(DISTINCT o.id) as total_orders_served,
             COALESCE(SUM(l.duration_minutes), 0) as logged_working_minutes
      FROM users u
      LEFT JOIN orders o ON u.id = o.served_by AND o.status = 'served'
      LEFT JOIN employee_shift_logs l ON u.id = l.user_id
      WHERE u.role = 'staff'
      GROUP BY u.id
      ORDER BY FIELD(u.status, 'pending_approval', 'active', 'rejected', 'removed'), u.created_at DESC
    `);

    // Fetch orders served by each employee with table and dish details
    for (const emp of employees) {
      const [servedOrders] = await pool.query(`
        SELECT o.id, o.total_amount, o.status, o.payment_status, o.created_at,
               t.table_number, u.name as customer_name
        FROM orders o
        LEFT JOIN tables t ON o.table_id = t.id
        LEFT JOIN users u ON o.user_id = u.id
        WHERE o.served_by = ?
        ORDER BY o.created_at DESC
        LIMIT 10
      `, [emp.id]);
      emp.recent_served_orders = servedOrders;
    }

    res.json({
      success: true,
      employees
    });
  } catch (error) {
    logger.error('Get employees error:', error);
    res.status(500).json({ error: 'Failed to retrieve employees list' });
  }
});

// Owner Approve / Reject New Employee Application
router.post('/owner/employees/:id/decision', authenticate, authorizeRoles('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const { decision } = req.body; // 'approve' or 'reject'

    const nextStatus = decision === 'approve' ? 'active' : 'rejected';
    await pool.query('UPDATE users SET status = ? WHERE id = ?', [nextStatus, id]);

    res.json({
      success: true,
      id,
      status: nextStatus,
      message: decision === 'approve' ? 'Employee approved and added to active restaurant roster!' : 'Employee registration rejected.'
    });
  } catch (error) {
    logger.error('Employee decision error:', error);
    res.status(500).json({ error: 'Failed to process employee decision' });
  }
});

// Owner Remove Employee (with remark/reason)
router.post('/owner/employees/:id/remove', authenticate, authorizeRoles('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = 'Deactivated by restaurant management' } = req.body;

    await pool.query(
      'UPDATE users SET status = "removed", removal_reason = ? WHERE id = ?',
      [reason, id]
    );

    // Notify connected employee session if any
    io.emit('employee:status_updated', {
      employeeId: id,
      status: 'removed',
      reason
    });

    res.json({
      success: true,
      id,
      status: 'removed',
      message: 'Employee removed from active roster. Deactivation remark saved.'
    });
  } catch (error) {
    logger.error('Remove employee error:', error);
    res.status(500).json({ error: 'Failed to remove employee' });
  }
});

// ========================================================
// 10. Individual Employee Served Orders History & Shift End
// ========================================================
router.get('/employee/my-served-orders', authenticate, authorizeRoles('staff', 'owner'), async (req, res) => {
  try {
    const employeeId = req.user.userId;

    const [orders] = await pool.query(`
      SELECT o.*, t.table_number, u.name as customer_name,
             r.rating as review_rating, r.comment as review_comment
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN users u ON o.user_id = u.id
      LEFT JOIN order_reviews r ON o.id = r.order_id
      WHERE o.served_by = ?
      ORDER BY o.created_at DESC
    `, [employeeId]);

    for (const order of orders) {
      const [items] = await pool.query(
        `SELECT oi.*, mi.name FROM order_items oi JOIN menu_items mi ON oi.menu_item_id = mi.id WHERE oi.order_id = ?`,
        [order.id]
      );
      order.items = items;
    }

    // Get current employee stats
    const [stats] = await pool.query(`
      SELECT shift_start, total_working_minutes,
             TIMESTAMPDIFF(MINUTE, shift_start, NOW()) as current_session_minutes
      FROM users WHERE id = ?
    `, [employeeId]);

    res.json({
      success: true,
      orders,
      stats: stats[0] || null
    });
  } catch (error) {
    logger.error('My served orders error:', error);
    res.status(500).json({ error: 'Failed to retrieve served orders history' });
  }
});

// Employee Shift Logout / End
router.post('/employee/logout-shift', authenticate, authorizeRoles('staff', 'owner'), async (req, res) => {
  try {
    const employeeId = req.user.userId;

    // Calculate shift minutes
    const [userRow] = await pool.query('SELECT shift_start FROM users WHERE id = ?', [employeeId]);
    if (userRow.length > 0 && userRow[0].shift_start) {
      const shiftStart = new Date(userRow[0].shift_start);
      const diffMinutes = Math.max(1, Math.round((Date.now() - shiftStart.getTime()) / 60000));

      await pool.query(
        'UPDATE users SET total_working_minutes = total_working_minutes + ?, shift_start = NULL WHERE id = ?',
        [diffMinutes, employeeId]
      );

      // Close open shift log
      await pool.query(
        'UPDATE employee_shift_logs SET logout_at = NOW(), duration_minutes = ? WHERE user_id = ? AND logout_at IS NULL ORDER BY login_at DESC LIMIT 1',
        [diffMinutes, employeeId]
      );
    }

    res.json({ success: true, message: 'Shift logged out successfully.' });
  } catch (error) {
    logger.error('Logout shift error:', error);
    res.status(500).json({ error: 'Failed to record shift logout' });
  }
});

// Customer submits a rating & review for completed served order
router.post('/:orderId/review', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { rating, comment } = req.body;
    const userId = req.user.userId;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5 stars.' });
    }

    // Verify order exists and belongs to user
    const [orders] = await pool.query('SELECT * FROM orders WHERE id = ? AND user_id = ?', [orderId, userId]);
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Ensure order_reviews table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_reviews (
        id VARCHAR(36) PRIMARY KEY,
        order_id VARCHAR(36) NOT NULL,
        user_id VARCHAR(36) NOT NULL,
        rating INT NOT NULL,
        comment TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_order (order_id),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Check if review already exists
    const [existing] = await pool.query('SELECT id FROM order_reviews WHERE order_id = ?', [orderId]);
    if (existing.length > 0) {
      await pool.query(
        'UPDATE order_reviews SET rating = ?, comment = ?, created_at = NOW() WHERE order_id = ?',
        [rating, comment || null, orderId]
      );
    } else {
      const reviewId = uuidv4();
      await pool.query(
        'INSERT INTO order_reviews (id, order_id, user_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
        [reviewId, orderId, userId, rating, comment || null]
      );
    }

    res.json({
      success: true,
      message: 'Thank you for your valuable feedback! ⭐',
      rating,
      comment
    });
  } catch (error) {
    logger.error('Order review submission error:', error);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

export default router;

