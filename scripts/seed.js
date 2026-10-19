/**
 * Database Seed Script
 * Run with: npm run seed
 *
 * Populates restaurant_db with unique menu categories, non-duplicated dishes with
 * rich variety across Indian & continental delicacies, dining tables, and seed users.
 */
import bcrypt from 'bcryptjs';
import pool from '../src/config/database.js';
import { logger } from '../src/utils/logger.js';

const SEED = {
  customer: {
    id: 'u0000000-0000-0000-0000-000000000001',
    name: 'Customer Demo',
    email: 'customer@example.com',
    password: 'password123',
    phone: '9876543210',
    role: 'customer',
  },
  staff: {
    id: 'u0000000-0000-0000-0000-000000000002',
    name: 'Kitchen Staff',
    email: 'staff@example.com',
    password: 'password123',
    phone: '9876543211',
    role: 'staff',
  },
  owner: {
    id: 'u0000000-0000-0000-0000-000000000003',
    name: 'Restaurant Owner',
    email: 'owner@example.com',
    password: 'password123',
    phone: '9876543212',
    role: 'owner',
  },
  restaurant: {
    id: 'r0000000-0000-0000-0000-000000000001',
    name: 'Spice Garden Bistro',
    address: '12 MG Road, Indiranagar, Bengaluru',
    phone: '080-23456789',
    email: 'info@spicegardenbistro.com',
  },
  catAppetizers: { id: 'ca000000-0000-0000-0000-000000000001', name: 'Appetizers' },
  catMains:      { id: 'cm000000-0000-0000-0000-000000000001', name: 'Main Course' },
  catDesserts:   { id: 'cd000000-0000-0000-0000-000000000001', name: 'Desserts' },
  catDrinks:     { id: 'cr000000-0000-0000-0000-000000000001', name: 'Beverages' },
};

export const seedDatabase = async () => {
  try {
    logger.info('Starting clean idempotent database seeding...');

    // 1. Ensure unique constraint on menu_items (category_id, name)
    try {
      await pool.query(`ALTER TABLE menu_items ADD UNIQUE KEY uk_cat_item_name (category_id, name)`);
      logger.info('Added unique key uk_cat_item_name on menu_items');
    } catch (e) {
      // Key already exists or table has duplicates which we'll wipe below
    }

    // 2. Clear old duplicate menu_items cleanly
    await pool.query(`DELETE FROM menu_items`);
    logger.info('Cleared old duplicate menu items');

    // 3. Ensure unique constraint now if not yet created
    try {
      await pool.query(`ALTER TABLE menu_items ADD UNIQUE KEY uk_cat_item_name (category_id, name)`);
      logger.info('Ensured unique key uk_cat_item_name');
    } catch (e) {
      // Ignored if already present
    }

    // 4. Seed users
    const passwordHash = await bcrypt.hash('password123', 10);
    const users = [SEED.customer, SEED.staff, SEED.owner];
    for (const u of users) {
      await pool.query(
        `INSERT INTO users (id, name, email, password_hash, phone, role)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), role = VALUES(role), phone = VALUES(phone)`,
        [u.id, u.name, u.email, passwordHash, u.phone, u.role]
      );
    }
    logger.info('Users verified');

    // 5. Seed restaurant
    await pool.query(
      `INSERT INTO restaurants (id, name, address, phone)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), address = VALUES(address), phone = VALUES(phone)`,
      [SEED.restaurant.id, SEED.restaurant.name, SEED.restaurant.address, SEED.restaurant.phone]
    );
    logger.info('Restaurant verified');

    // 6. Seed dining tables
    const tables = [
      { id: 't0000000-0000-0000-0000-000000000001', restaurant_id: SEED.restaurant.id, table_number: 1, capacity: 2 },
      { id: 't0000000-0000-0000-0000-000000000002', restaurant_id: SEED.restaurant.id, table_number: 2, capacity: 4 },
      { id: 't0000000-0000-0000-0000-000000000003', restaurant_id: SEED.restaurant.id, table_number: 3, capacity: 4 },
      { id: 't0000000-0000-0000-0000-000000000004', restaurant_id: SEED.restaurant.id, table_number: 4, capacity: 6 },
      { id: 't0000000-0000-0000-0000-000000000005', restaurant_id: SEED.restaurant.id, table_number: 5, capacity: 8 },
      { id: 't0000000-0000-0000-0000-000000000006', restaurant_id: SEED.restaurant.id, table_number: 6, capacity: 4 },
    ];
    for (const table of tables) {
      await pool.query(
        `INSERT IGNORE INTO tables (id, restaurant_id, table_number, capacity, status) VALUES (?, ?, ?, ?, 'available')`,
        [table.id, table.restaurant_id, table.table_number, table.capacity]
      );
    }
    logger.info('Dining tables verified');

    // 7. Seed categories
    const categories = [
      { id: SEED.catAppetizers.id, name: 'Appetizers', description: 'Crisp & sizzling starters' },
      { id: SEED.catMains.id,      name: 'Main Course', description: 'Hearty Indian curries, biryanis & tandoor' },
      { id: SEED.catDesserts.id,   name: 'Desserts', description: 'Delectable sweets & artisanal puddings' },
      { id: SEED.catDrinks.id,     name: 'Beverages', description: 'Cool mocktails, lassi & traditional chai' },
    ];
    for (const cat of categories) {
      await pool.query(
        `INSERT INTO menu_categories (id, restaurant_id, name, description)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)`,
        [cat.id, SEED.restaurant.id, cat.name, cat.description]
      );
    }

    // 8. Seed Distinct, Non-Duplicated Menu Items with Full Details
    const menuItems = [
      // ---- APPETIZERS ----
      {
        id: 'i-app-001',
        catId: SEED.catAppetizers.id,
        name: 'Paneer Tikka Angara',
        price: 289.00,
        desc: 'Charcoal-grilled cottage cheese cubes marinated in fiery tandoori spices and smoked mustard oil.',
        veg: true,
        jain: true,
        img: 'https://images.unsplash.com/photo-1599488615731-7e5c2823ff28?auto=format&fit=crop&w=600&q=80' // grilled tikka skewers with onions & mint
      },
      {
        id: 'i-app-002',
        catId: SEED.catAppetizers.id,
        name: 'Crispy Veg Spring Rolls',
        price: 239.00,
        desc: 'Golden-fried pastry rolls filled with shredded cabbage, bell peppers, carrots, served with sweet chili dip.',
        veg: true,
        jain: true,
        img: 'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=600&q=80' // golden crispy spring rolls
      },
      {
        id: 'i-app-003',
        catId: SEED.catAppetizers.id,
        name: 'Tandoori Chicken Tikka',
        price: 339.00,
        desc: 'Succulent boneless chicken thigh pieces steeped in hung curd, Kashmiri deggi mirch, and roasted over hot coals.',
        veg: false,
        jain: false,
        img: 'https://images.unsplash.com/photo-1610057099443-fde8c4d50f91?auto=format&fit=crop&w=600&q=80' // roasted red tandoori chicken
      },
      {
        id: 'i-app-004',
        catId: SEED.catAppetizers.id,
        name: 'Classic Tomato Bruschetta',
        price: 249.00,
        desc: 'Toasted country baguette slices drizzled with extra virgin olive oil, topped with diced ripe plum tomatoes, garlic & fresh basil.',
        veg: true,
        jain: false,
        img: 'https://images.unsplash.com/photo-1572695157366-5e585ab2b69f?auto=format&fit=crop&w=600&q=80' // tomato basil bruschetta bread
      },
      {
        id: 'i-app-005',
        catId: SEED.catAppetizers.id,
        name: 'Cheese Stuffed Garlic Bread',
        price: 209.00,
        desc: 'Crispy French baguette stuffed with roasted garlic butter, molten mozzarella, and freshly chopped parsley.',
        veg: true,
        jain: false,
        img: 'https://images.unsplash.com/photo-1619535860434-ba1d8fa12536?auto=format&fit=crop&w=600&q=80' // cheesy garlic bread
      },
      {
        id: 'i-app-006',
        catId: SEED.catAppetizers.id,
        name: 'Amritsari Fish Fingers',
        price: 369.00,
        desc: 'Fresh river sole fish marinated in carom seeds, ginger, lime, and gram flour, fried until crisp and flaky.',
        veg: false,
        jain: false,
        img: 'https://images.unsplash.com/photo-1526318896980-cf78c088247c?auto=format&fit=crop&w=600&q=80' // golden fish fritters/fingers
      },

      // ---- MAIN COURSE ----
      {
        id: 'i-main-001',
        catId: SEED.catMains.id,
        name: 'Butter Chicken Masala',
        price: 389.00,
        desc: 'Slow-simmered tender chicken pieces in velvety, sun-ripened tomato-cashew makhani gravy with fenugreek.',
        veg: false,
        jain: false,
        img: 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?auto=format&fit=crop&w=600&q=80' // authentic butter chicken curry
      },
      {
        id: 'i-main-002',
        catId: SEED.catMains.id,
        name: 'Paneer Butter Masala',
        price: 329.00,
        desc: 'Soft fresh cottage cheese cubes cooked in aromatic buttery tomato gravy, subtly flavored with cardamom and kasuri methi.',
        veg: true,
        jain: true,
        img: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?auto=format&fit=crop&w=600&q=80' // paneer in rich tomato gravy
      },
      {
        id: 'i-main-003',
        catId: SEED.catMains.id,
        name: 'Hyderabadi Dum Biryani',
        price: 369.00,
        desc: 'Long-grain royal basmati rice cooked on slow dum with aromatic spices, saffron, and tender marinated chicken pieces.',
        veg: false,
        jain: false,
        img: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?auto=format&fit=crop&w=600&q=80' // authentic chicken dum biryani
      },
      {
        id: 'i-main-004',
        catId: SEED.catMains.id,
        name: 'Dal Makhani Bukhara',
        price: 279.00,
        desc: 'Overnight slow-simmered whole black urad lentils infused with vine tomatoes, churned butter, and single cream.',
        veg: true,
        jain: true,
        img: 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?auto=format&fit=crop&w=600&q=80' // dark creamy dal makhani
      },
      {
        id: 'i-main-005',
        catId: SEED.catMains.id,
        name: 'Palak Paneer',
        price: 319.00,
        desc: 'Delicate cottage cheese tossed in freshly blanched organic spinach purée tempered with browned garlic and cumin.',
        veg: true,
        jain: true,
        img: 'https://images.unsplash.com/photo-1589302168068-964664d93dc0?auto=format&fit=crop&w=600&q=80' // rich green palak paneer
      },
      {
        id: 'i-main-006',
        catId: SEED.catMains.id,
        name: 'Mutton Rogan Josh',
        price: 439.00,
        desc: 'Kashmiri delicacy of tender braised mutton simmered in yogurt gravy flavored with fennel seeds, ginger, and ratanjot.',
        veg: false,
        jain: false,
        img: 'https://images.unsplash.com/photo-1545247181-516773cae754?auto=format&fit=crop&w=600&q=80' // deep red mutton curry
      },
      {
        id: 'i-main-007',
        catId: SEED.catMains.id,
        name: 'Vegetable Dum Biryani',
        price: 319.00,
        desc: 'Fragrant basmati rice layered with garden vegetables, caramelized onions, mint, and whole roasted tandoor spices.',
        veg: true,
        jain: true,
        img: 'https://images.unsplash.com/photo-1645177628172-a94c1f96e6db?auto=format&fit=crop&w=600&q=80' // vegetable biryani rice
      },
      {
        id: 'i-main-008',
        catId: SEED.catMains.id,
        name: 'Butter Garlic Naan Basket',
        price: 149.00,
        desc: 'A trio of clay-oven baked naans brushed with pure desi ghee, crushed tandoori garlic, and coriander leaves.',
        veg: true,
        jain: true,
        img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=600&q=80' // tandoori naan bread
      },
      {
        id: 'i-main-009',
        catId: SEED.catMains.id,
        name: 'Woodfired Margherita Pizza',
        price: 349.00,
        desc: 'Hand-stretched sourdough base, San Marzano tomato sauce, fresh buffalo mozzarella, and fragrant Genovese basil.',
        veg: true,
        jain: false,
        img: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?auto=format&fit=crop&w=600&q=80' // margherita pizza
      },
      {
        id: 'i-main-010',
        catId: SEED.catMains.id,
        name: 'Crispy Grilled Chicken Burger',
        price: 329.00,
        desc: 'Smoky grilled chicken patty topped with aged cheddar cheese, crisp iceberg lettuce, caramelized onions, and house remoulade.',
        veg: false,
        jain: false,
        img: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=600&q=80' // gourmet burger with fries
      },

      // ---- DESSERTS ----
      {
        id: 'i-des-001',
        catId: SEED.catDesserts.id,
        name: 'Warm Gulab Jamun with Rabri',
        price: 189.00,
        desc: 'Traditional fried mawa dumplings soaked in cardamom sugar syrup, served warm alongside chilled saffron rabri.',
        veg: true,
        jain: true,
        img: 'https://images.unsplash.com/photo-1541781774459-bb2af2f05b55?auto=format&fit=crop&w=600&q=80' // authentic sweet dessert dumplings
      },
      {
        id: 'i-des-002',
        catId: SEED.catDesserts.id,
        name: 'Belgium Chocolate Truffle Cake',
        price: 249.00,
        desc: 'Decadent multi-layered Belgian dark chocolate sponge glazed with silky ganache and chocolate curls.',
        veg: true,
        jain: false,
        img: 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?auto=format&fit=crop&w=600&q=80' // chocolate truffle cake
      },
      {
        id: 'i-des-003',
        catId: SEED.catDesserts.id,
        name: 'Kesar Pista Kulfi',
        price: 169.00,
        desc: 'Traditional slow-reduced frozen milk dessert flavored with rich saffron strands, pistachios, and green cardamom.',
        veg: true,
        jain: true,
        img: 'https://images.unsplash.com/photo-1563805042-7684c019e1cb?auto=format&fit=crop&w=600&q=80' // gourmet ice cream dessert
      },
      {
        id: 'i-des-004',
        catId: SEED.catDesserts.id,
        name: 'Molten Lava Brownie with Gelato',
        price: 239.00,
        desc: 'Warm fudge brownie with a molten chocolate center served with a scoop of artisanal Madagascar vanilla gelato.',
        veg: true,
        jain: false,
        img: 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?auto=format&fit=crop&w=600&q=80' // molten chocolate brownie
      },

      // ---- BEVERAGES ----
      {
        id: 'i-bev-001',
        catId: SEED.catDrinks.id,
        name: 'Punjabi Mango Lassi',
        price: 149.00,
        desc: 'Thick churned fresh yogurt drink blended with Alphonso mango pulp, saffron, and crushed green pistachios.',
        veg: true,
        jain: true,
        img: 'https://images.unsplash.com/photo-1525385133512-2f3bdd039054?auto=format&fit=crop&w=600&q=80' // mango smoothie/lassi
      },
      {
        id: 'i-bev-002',
        catId: SEED.catDrinks.id,
        name: 'Kolkata Masala Chai',
        price: 89.00,
        desc: 'Strong brewed CTC tea simmered with whole fresh ginger, crushed cardamom, cloves, and full-cream milk.',
        veg: true,
        jain: true,
        img: 'https://images.unsplash.com/photo-1557006021-b85faa2bc5e2?auto=format&fit=crop&w=600&q=80' // spiced hot masala tea
      },
      {
        id: 'i-bev-003',
        catId: SEED.catDrinks.id,
        name: 'Fresh Mint Lime Soda',
        price: 119.00,
        desc: 'Zesty sparkling lime cooler infused with bruised garden mint leaves and black rock salt.',
        veg: true,
        jain: true,
        img: 'https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&w=600&q=80' // chilled mint lime drink with ice
      },
      {
        id: 'i-bev-004',
        catId: SEED.catDrinks.id,
        name: 'Iced Hazelnut Frappe',
        price: 199.00,
        desc: 'Chilled Arabica espresso blended with roasted hazelnut syrup, cream, and topped with whipped foam.',
        veg: true,
        jain: true,
        img: 'https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?auto=format&fit=crop&w=600&q=80' // iced coffee frappe
      },
    ];

    for (const item of menuItems) {
      await pool.query(
        `INSERT INTO menu_items (id, category_id, name, description, price, image_url, is_vegetarian, is_jain, is_available)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, true)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           description = VALUES(description),
           price = VALUES(price),
           image_url = VALUES(image_url),
           is_vegetarian = VALUES(is_vegetarian),
           is_jain = VALUES(is_jain)`,
        [item.id, item.catId, item.name, item.desc, item.price, item.img, item.veg, item.jain]
      );
    }

    logger.info(`Seeding complete — ${menuItems.length} unique, distinct menu items populated without duplicates.`);
  } catch (error) {
    logger.error('Error seeding database:', error);
    throw error;
  } finally {
    await pool.end();
  }
};

seedDatabase();
