import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../config/database.js';
import { logger } from '../utils/logger.js';
import { authenticate, authorizeRoles } from '../middleware/auth.js';
import { io } from '../server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Get menu categories (public)
router.get('/categories', async (req, res) => {
  try {
    const { restaurantId } = req.query;

    let categories;
    if (restaurantId && restaurantId !== 'demo-restaurant') {
      [categories] = await pool.query(
        'SELECT * FROM menu_categories WHERE restaurant_id = ?',
        [restaurantId]
      );
    } else {
      [categories] = await pool.query('SELECT * FROM menu_categories');
    }

    res.json(categories);
  } catch (error) {
    logger.error('Menu categories retrieval error:', error);
    res.status(500).json({ error: 'Menu categories retrieval failed' });
  }
});

// Create menu category (Owner only)
router.post('/categories', async (req, res) => {
  try {
    const { name, description, restaurantId } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    const defaultRestId = restaurantId || 'r0000000-0000-0000-0000-000000000001';
    const id = uuidv4();
    await pool.query(
      'INSERT INTO menu_categories (id, restaurant_id, name, description) VALUES (?, ?, ?, ?)',
      [id, defaultRestId, name.trim(), description || `${name.trim()} category`]
    );

    res.status(201).json({ id, name: name.trim(), description, message: 'Category created successfully' });
  } catch (error) {
    logger.error('Create category error:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// Get menu items by category (public)
router.get('/items', async (req, res) => {
  try {
    const { categoryId } = req.query;

    let items;
    if (categoryId) {
      [items] = await pool.query(
        `SELECT mi.*, mc.name as category_name 
         FROM menu_items mi 
         LEFT JOIN menu_categories mc ON mi.category_id = mc.id 
         WHERE mi.category_id = ?`,
        [categoryId]
      );
    } else {
      [items] = await pool.query(
        `SELECT mi.*, mc.name as category_name 
         FROM menu_items mi 
         LEFT JOIN menu_categories mc ON mi.category_id = mc.id 
         ORDER BY mi.created_at DESC`
      );
    }

    res.json(items);
  } catch (error) {
    logger.error('Menu items retrieval error:', error);
    res.status(500).json({ error: 'Menu items retrieval failed' });
  }
});

// Toggle menu item availability (Both staff and owner can update stock/availability)
router.patch('/items/:id/availability', authenticate, authorizeRoles('staff', 'owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const { isAvailable } = req.body;

    await pool.query('UPDATE menu_items SET is_available = ? WHERE id = ?', [isAvailable ? 1 : 0, id]);

    // Fetch the updated item to broadcast full detail
    const [rows] = await pool.query('SELECT * FROM menu_items WHERE id = ?', [id]);
    const updatedItem = rows.length > 0 ? rows[0] : { id, is_available: isAvailable ? 1 : 0 };

    // Broadcast immediate real-time update to all connected clients (customer & staff apps)
    io.emit('menu:item_updated', {
      itemId: id,
      isAvailable: Boolean(isAvailable),
      item: updatedItem
    });
    io.emit('menu:updated', { itemId: id });

    res.json({ success: true, id, isAvailable: Boolean(isAvailable), message: `Item availability updated.` });
  } catch (error) {
    logger.error('Update item availability error:', error);
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

// Configure multer storage for food dish photos
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '../../public/uploads'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, 'dish-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Upload dish image (Owner and staff authorized)
router.post('/upload-image', authenticate, authorizeRoles('owner', 'staff'), upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }
    // Generate server URL or relative path
    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({
      success: true,
      imageUrl: fileUrl,
      filename: req.file.filename,
      message: 'Dish image uploaded successfully'
    });
  } catch (error) {
    logger.error('Upload image error:', error);
    res.status(500).json({ error: 'Image upload failed' });
  }
});

// Create menu item (Owner only)
router.post('/items', authenticate, authorizeRoles('owner'), async (req, res) => {
  try {
    const {
      name,
      categoryId,
      categoryName,
      price,
      original_price,
      discount_percent,
      deal_tag,
      custom_offer,
      description,
      isVegetarian,
      isJain,
      imageUrl,
      image_url
    } = req.body;
    const finalImage = imageUrl !== undefined ? imageUrl : (image_url !== undefined ? image_url : null);
    if (!name || !price) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    let finalCategoryId = categoryId || null;

    // If owner specified categoryName instead or categoryId is missing, resolve or auto-create category
    if (!finalCategoryId && categoryName) {
      const [existing] = await pool.query('SELECT id FROM menu_categories WHERE LOWER(name) = LOWER(?) LIMIT 1', [categoryName.trim()]);
      if (existing.length > 0) {
        finalCategoryId = existing[0].id;
      } else {
        const newCatId = uuidv4();
        const defaultRestId = 'r0000000-0000-0000-0000-000000000001';
        await pool.query(
          'INSERT INTO menu_categories (id, restaurant_id, name, description) VALUES (?, ?, ?, ?)',
          [newCatId, defaultRestId, categoryName.trim(), `${categoryName.trim()} selection`]
        );
        finalCategoryId = newCatId;
      }
    }

    // Fallback to first available category if still null so item always appears in Customer app
    if (!finalCategoryId) {
      const [firstCat] = await pool.query('SELECT id FROM menu_categories LIMIT 1');
      if (firstCat.length > 0) finalCategoryId = firstCat[0].id;
    }

    const id = uuidv4();
    await pool.query(
      `INSERT INTO menu_items (
        id, category_id, name, description, price, original_price, discount_percent, deal_tag, custom_offer, is_vegetarian, is_jain, is_available, image_url
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        id,
        finalCategoryId,
        name,
        description || null,
        price,
        original_price || null,
        discount_percent || null,
        deal_tag || null,
        custom_offer || null,
        isVegetarian ? 1 : 0,
        isJain ? 1 : 0,
        finalImage
      ]
    );

    // Broadcast real-time update
    io.emit('menu:item_created', { id, categoryId: finalCategoryId, name });
    io.emit('menu:updated', { itemId: id });

    res.status(201).json({ success: true, id, message: 'Menu item created successfully' });
  } catch (error) {
    logger.error('Create menu item error:', error);
    res.status(500).json({ error: 'Failed to create menu item' });
  }
});

// Update menu item (Owner only)
router.put('/items/:id', authenticate, authorizeRoles('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      categoryId,
      categoryName,
      price,
      original_price,
      discount_percent,
      deal_tag,
      custom_offer,
      description,
      isVegetarian,
      isJain,
      isAvailable,
      imageUrl,
      image_url
    } = req.body;
    const finalImage = imageUrl !== undefined ? imageUrl : (image_url !== undefined ? image_url : null);

    let finalCategoryId = categoryId !== undefined ? categoryId : null;

    if (!finalCategoryId && categoryName) {
      const [existing] = await pool.query('SELECT id FROM menu_categories WHERE LOWER(name) = LOWER(?) LIMIT 1', [categoryName.trim()]);
      if (existing.length > 0) {
        finalCategoryId = existing[0].id;
      } else {
        const newCatId = uuidv4();
        const defaultRestId = 'r0000000-0000-0000-0000-000000000001';
        await pool.query(
          'INSERT INTO menu_categories (id, restaurant_id, name, description) VALUES (?, ?, ?, ?)',
          [newCatId, defaultRestId, categoryName.trim(), `${categoryName.trim()} selection`]
        );
        finalCategoryId = newCatId;
      }
    }

    await pool.query(
      `UPDATE menu_items 
       SET name = COALESCE(?, name),
           category_id = COALESCE(?, category_id),
           price = COALESCE(?, price),
           original_price = ?,
           discount_percent = ?,
           deal_tag = ?,
           custom_offer = ?,
           description = COALESCE(?, description),
           is_vegetarian = COALESCE(?, is_vegetarian),
           is_jain = COALESCE(?, is_jain),
           is_available = COALESCE(?, is_available),
           image_url = ?
       WHERE id = ?`,
      [
        name,
        finalCategoryId,
        price,
        original_price !== undefined ? (original_price || null) : null,
        discount_percent !== undefined ? (discount_percent || null) : null,
        deal_tag !== undefined ? (deal_tag || null) : null,
        custom_offer !== undefined ? (custom_offer || null) : null,
        description,
        isVegetarian,
        isJain,
        isAvailable,
        finalImage,
        id
      ]
    );

    const [rows] = await pool.query('SELECT * FROM menu_items WHERE id = ?', [id]);
    const updatedItem = rows.length > 0 ? rows[0] : null;

    // Broadcast real-time update
    io.emit('menu:item_updated', {
      itemId: id,
      isAvailable: isAvailable !== undefined ? Boolean(isAvailable) : (updatedItem ? Boolean(updatedItem.is_available) : true),
      item: updatedItem
    });
    io.emit('menu:updated', { itemId: id });

    res.json({ success: true, id, message: 'Menu item updated successfully' });
  } catch (error) {
    logger.error('Update menu item error:', error);
    res.status(500).json({ error: 'Failed to update menu item' });
  }
});

// Delete menu item (Owner only)
router.delete('/items/:id', authenticate, authorizeRoles('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM menu_items WHERE id = ?', [id]);

    io.emit('menu:item_deleted', { itemId: id });
    io.emit('menu:updated', { itemId: id });

    res.json({ success: true, id, message: 'Menu item deleted successfully' });
  } catch (error) {
    logger.error('Delete menu item error:', error);
    res.status(500).json({ error: 'Failed to delete menu item' });
  }
});

export default router;
