import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../config/database.js';
import { validateUser } from '../middleware/validation.js';
import { logger } from '../utils/logger.js';
import { sendOtpEmail, sendWelcomeEmail, sendEmployeeRegistrationOtpEmail } from '../services/emailService.js';

const router = express.Router();

// Helper to generate a 6-digit OTP
const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

// ==========================================
// 1. Send OTP for Login (Email or Mobile)
// ==========================================
router.post('/login/send-otp', async (req, res) => {
  try {
    const { identifier } = req.body; // Email or Mobile Number

    if (!identifier) {
      return res.status(400).json({ error: 'Please enter your email or mobile number.' });
    }

    const trimmed = identifier.trim();

    // Check if user exists by email or phone
    const [users] = await pool.query(
      'SELECT id, name, email, phone, role FROM users WHERE email = ? OR phone = ? LIMIT 1',
      [trimmed, trimmed]
    );

    if (users.length === 0) {
      return res.status(404).json({
        error: 'No account found with this email or mobile number. Please register first.'
      });
    }

    const user = users[0];
    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Invalidate existing active OTPs for this email
    await pool.query('DELETE FROM otp_verifications WHERE email = ? AND purpose = "login"', [user.email]);

    // Store in otp_verifications
    await pool.query(
      'INSERT INTO otp_verifications (id, email, otp, purpose, payload, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), user.email, otp, 'login', JSON.stringify({ userId: user.id }), expiresAt]
    );

    // Send email to user's registered email
    await sendOtpEmail(user.email, otp, 'login');

    res.json({
      success: true,
      message: `Verification OTP has been sent to ${maskEmail(user.email)}.`,
      email: user.email
    });
  } catch (error) {
    logger.error('Login send-otp error:', error);
    res.status(500).json({ error: 'Failed to send login OTP.' });
  }
});

// ==========================================
// 2. Verify OTP for Login
// ==========================================
router.post('/login/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP code are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = otp.toString().trim().replace(/\s+/g, '');

    const [records] = await pool.query(
      'SELECT * FROM otp_verifications WHERE LOWER(TRIM(email)) = ? AND TRIM(otp) = ? AND purpose = "login" ORDER BY created_at DESC LIMIT 1',
      [cleanEmail, cleanOtp]
    );

    if (records.length === 0) {
      return res.status(400).json({ error: 'Invalid OTP code. Please check the code received in your email.' });
    }

    const record = records[0];
    const isExpired = new Date() > new Date(record.expires_at);
    if (isExpired) {
      await pool.query('DELETE FROM otp_verifications WHERE id = ?', [record.id]);
      return res.status(400).json({ error: 'This OTP has expired. Please request a new verification code.' });
    }

    // Delete used OTP
    await pool.query('DELETE FROM otp_verifications WHERE id = ?', [record.id]);

    // Fetch user details
    const [users] = await pool.query('SELECT id, name, email, phone, role, is_gold, gold_type, gold_expires_at FROM users WHERE LOWER(TRIM(email)) = ?', [cleanEmail]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    const user = users[0];
    const isGoldActive = Boolean(user.is_gold) && (user.gold_type === 'permanent' || (user.gold_expires_at && new Date() <= new Date(user.gold_expires_at)));

    const token = jwt.sign(
      { userId: user.id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        is_gold: isGoldActive,
        gold_type: user.gold_type,
        gold_expires_at: user.gold_expires_at
      }
    });
  } catch (error) {
    logger.error('Login verify-otp error:', error);
    res.status(500).json({ error: 'Failed to verify login OTP.' });
  }
});

// ==========================================
// 3. Send OTP for Registration
// ==========================================
router.post('/register/send-otp', async (req, res) => {
  try {
    const { name, email, phone } = req.body;

    if (!name || !email || !phone) {
      return res.status(400).json({ error: 'Name, Email, and Mobile Number are required.' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const cleanPhone = phone.toString().replace(/[^0-9]/g, '');

    // Strict 10-digit mobile validation (Indian mobile number standards)
    if (cleanPhone.length !== 10) {
      return res.status(400).json({
        error: 'Please enter a valid 10-digit mobile number (e.g. 9876543210).'
      });
    }

    // Check if user already exists
    const [existing] = await pool.query(
      'SELECT id, email, phone FROM users WHERE LOWER(TRIM(email)) = ? OR TRIM(phone) = ? LIMIT 1',
      [trimmedEmail, cleanPhone]
    );

    if (existing.length > 0) {
      const matchEmail = existing[0].email.toLowerCase() === trimmedEmail;
      return res.status(400).json({
        error: matchEmail
          ? 'An account with this email already exists. Please log in.'
          : 'An account with this mobile number already exists. Please log in.'
      });
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes validity

    // Invalidate previous registration OTP for this email
    await pool.query('DELETE FROM otp_verifications WHERE LOWER(TRIM(email)) = ? AND purpose = "registration"', [trimmedEmail]);

    // Store in otp_verifications with the registration payload
    await pool.query(
      'INSERT INTO otp_verifications (id, email, otp, purpose, payload, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        uuidv4(),
        trimmedEmail,
        otp,
        'registration',
        JSON.stringify({ name: name.trim(), email: trimmedEmail, phone: cleanPhone, role: 'customer' }),
        expiresAt
      ]
    );

    // Send email
    await sendOtpEmail(trimmedEmail, otp, 'registration');

    res.json({
      success: true,
      message: `Verification code sent to ${trimmedEmail}.`
    });
  } catch (error) {
    logger.error('Register send-otp error:', error);
    res.status(500).json({ error: 'Failed to send registration OTP.' });
  }
});

// ==========================================
// 4. Verify OTP for Registration & Confirm
// ==========================================
router.post('/register/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = otp.toString().trim().replace(/\s+/g, '');

    const [records] = await pool.query(
      'SELECT * FROM otp_verifications WHERE LOWER(TRIM(email)) = ? AND TRIM(otp) = ? AND purpose = "registration" ORDER BY created_at DESC LIMIT 1',
      [cleanEmail, cleanOtp]
    );

    if (records.length === 0) {
      return res.status(400).json({ error: 'Invalid verification code. Please check the 6-digit code received in your email.' });
    }

    const record = records[0];
    const isExpired = new Date() > new Date(record.expires_at);
    if (isExpired) {
      await pool.query('DELETE FROM otp_verifications WHERE id = ?', [record.id]);
      return res.status(400).json({ error: 'This verification code has expired. Please request a new one.' });
    }

    const payload = typeof record.payload === 'string'
      ? JSON.parse(record.payload)
      : record.payload;

    const userId = uuidv4();
    const defaultPasswordHash = await bcrypt.hash('customer123', 10);

    // Insert user into MySQL
    await pool.query(
      'INSERT INTO users (id, name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, payload.name, payload.email, payload.phone, defaultPasswordHash, 'customer']
    );

    // Delete used OTP
    await pool.query('DELETE FROM otp_verifications WHERE id = ?', [record.id]);

    // Send Registration Successful Confirmation Email
    await sendWelcomeEmail(payload.email, payload.name);

    const token = jwt.sign(
      { userId, role: 'customer', email: payload.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      success: true,
      message: 'Account registered successfully! Confirmation email sent.',
      token,
      user: {
        id: userId,
        name: payload.name,
        email: payload.email,
        phone: payload.phone,
        role: 'customer'
      }
    });
  } catch (error) {
    logger.error('Register verify-otp error:', error);
    res.status(500).json({ error: 'Failed to complete registration.' });
  }
});

// ==========================================
// 4b. Get Current User Profile & Gold Status
// ==========================================
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization token required' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [users] = await pool.query(
      'SELECT id, name, email, phone, role, is_gold, gold_type, gold_expires_at FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];

    // Check past completed orders for consistency auto-upgrade
    const [pastOrderRows] = await pool.query(
      'SELECT COUNT(*) as completedCount FROM orders WHERE user_id = ? AND status NOT IN ("cancelled", "refund_completed")',
      [user.id]
    );
    const completedCount = pastOrderRows[0]?.completedCount || 0;

    let isGoldActive = Boolean(user.is_gold);
    let goldType = user.gold_type || 'none';
    let expiresAt = user.gold_expires_at;

    // Check consistency criteria: 2 or more orders = permanent gold member
    if (completedCount >= 2 && (!isGoldActive || goldType !== 'permanent')) {
      isGoldActive = true;
      goldType = 'permanent';
      expiresAt = null;
      await pool.query('UPDATE users SET is_gold = 1, gold_type = "permanent", gold_expires_at = NULL WHERE id = ?', [user.id]);
    } else if (isGoldActive && goldType === 'temporary' && expiresAt) {
      if (new Date() > new Date(expiresAt)) {
        isGoldActive = false;
        goldType = 'none';
        await pool.query('UPDATE users SET is_gold = 0, gold_type = "none" WHERE id = ?', [user.id]);
      }
    }

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        is_gold: isGoldActive,
        gold_type: goldType,
        gold_expires_at: expiresAt,
        totalCompletedOrders: completedCount
      }
    });
  } catch (error) {
    logger.error('Fetch me profile error:', error);
    res.status(401).json({ error: 'Invalid or expired session' });
  }
});

// Helper to mask email for UI display
function maskEmail(email) {
  const [user, domain] = email.split('@');
  if (!user || !domain) return email;
  const visible = user.slice(0, 2);
  return `${visible}***@${domain}`;
}

// ========================================================
// 5. Unified Staff / Owner Login (Username/Email + Password)
//    - If Owner: generates and sends OTP to owner email, requires OTP verification
//    - If Employee (Chef/Waiter/etc): checks status (must be active), logs in directly
// ========================================================
router.post('/login', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const identifier = (username || email || '').trim();

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Please enter your username and password.' });
    }

    // Lookup user by username OR email OR phone
    const [users] = await pool.query(
      'SELECT * FROM users WHERE LOWER(TRIM(username)) = LOWER(?) OR LOWER(TRIM(email)) = LOWER(?) OR TRIM(phone) = ? LIMIT 1',
      [identifier, identifier, identifier]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const user = users[0];

    // Password verification
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // Verify role permissions (only staff/owner allowed in staff portal)
    if (!['owner', 'staff'].includes(user.role)) {
      return res.status(403).json({ error: 'Access denied. This portal is for restaurant personnel only.' });
    }

    // If Employee: Check approval / employment status
    if (user.role === 'staff') {
      if (user.status === 'pending_approval') {
        return res.status(403).json({
          error: 'Your registration is pending approval by the Restaurant Owner. Please wait for owner confirmation.'
        });
      }
      if (user.status === 'removed' || user.status === 'rejected') {
        const reasonMsg = user.removal_reason ? ` Reason: "${user.removal_reason}"` : '';
        return res.status(403).json({
          error: `Your account has been deactivated by the Restaurant Owner.${reasonMsg} Access to operations is restricted.`
        });
      }

      // Record shift start
      await pool.query('UPDATE users SET shift_start = NOW() WHERE id = ?', [user.id]);

      // Record login in employee_shift_logs
      await pool.query(
        'INSERT INTO employee_shift_logs (id, user_id, login_at) VALUES (?, ?, NOW())',
        [uuidv4(), user.id]
      );

      // Direct login for employee!
      const token = jwt.sign(
        { userId: user.id, role: user.role, email: user.email, name: user.name, employeeRole: user.employee_role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );

      return res.json({
        success: true,
        requiresOtp: false,
        token,
        role: user.role,
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          email: user.email,
          phone: user.phone,
          role: user.role,
          employee_role: user.employee_role,
          status: user.status
        }
      });
    }

    // If Owner: Generate verification code and send to owner email!
    if (user.role === 'owner') {
      const otp = generateOtp();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await pool.query('DELETE FROM otp_verifications WHERE email = ? AND purpose = "owner_login"', [user.email]);
      await pool.query(
        'INSERT INTO otp_verifications (id, email, otp, purpose, payload, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        [uuidv4(), user.email, otp, 'owner_login', JSON.stringify({ userId: user.id }), expiresAt]
      );

      await sendOtpEmail(user.email, otp, 'owner login');

      return res.json({
        success: true,
        requiresOtp: true,
        role: 'owner',
        email: user.email,
        maskedEmail: maskEmail(user.email),
        message: `Security verification code sent to Owner email (${maskEmail(user.email)}).`
      });
    }
  } catch (err) {
    logger.error('Staff login error:', err);
    res.status(500).json({ error: 'Login authentication failed.' });
  }
});

// ========================================================
// 6. Owner Login OTP Verification
// ========================================================
router.post('/login/verify-owner-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and verification code are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = otp.toString().trim().replace(/\s+/g, '');

    const [records] = await pool.query(
      'SELECT * FROM otp_verifications WHERE LOWER(TRIM(email)) = ? AND TRIM(otp) = ? AND purpose = "owner_login" ORDER BY created_at DESC LIMIT 1',
      [cleanEmail, cleanOtp]
    );

    if (records.length === 0) {
      return res.status(400).json({ error: 'Invalid verification code.' });
    }

    const record = records[0];
    if (new Date() > new Date(record.expires_at)) {
      await pool.query('DELETE FROM otp_verifications WHERE id = ?', [record.id]);
      return res.status(400).json({ error: 'Verification code has expired. Please try signing in again.' });
    }

    await pool.query('DELETE FROM otp_verifications WHERE id = ?', [record.id]);

    const [users] = await pool.query('SELECT * FROM users WHERE LOWER(TRIM(email)) = ? AND role = "owner"', [cleanEmail]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'Owner account not found.' });
    }

    const user = users[0];
    const token = jwt.sign(
      { userId: user.id, role: user.role, email: user.email, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      success: true,
      token,
      role: 'owner',
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status
      }
    });
  } catch (error) {
    logger.error('Verify owner OTP error:', error);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// ========================================================
// 7. Employee Registration - Step 1: Send OTP with Details & Terms
// ========================================================
router.post('/employee/register/send-otp', async (req, res) => {
  try {
    const { name, username, phone, email, role, password } = req.body;

    // Validation
    if (!name || !username || !phone || !email || !role || !password) {
      return res.status(400).json({ error: 'All fields are mandatory: Full Name, Username, Phone, Email, Role, and Password.' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const cleanEmail = email.trim().toLowerCase();
    const cleanPhone = phone.toString().replace(/[^0-9]/g, '');

    // Username format check
    if (cleanUsername.length < 3 || !/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
      return res.status(400).json({ error: 'Username must be at least 3 characters and contain only letters, numbers, or underscore.' });
    }

    // 10-digit mobile number validation
    if (cleanPhone.length !== 10) {
      return res.status(400).json({ error: 'Phone Number must be a valid 10-digit mobile number.' });
    }

    // Email format check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address with proper extension (e.g. name@domain.com).' });
    }

    // Role check
    const validRoles = ['Chef', 'Waiter', 'Kitchen Staff', 'Floor Staff', 'Cashier', 'Other'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Please select a valid role (Chef, Waiter, Kitchen Staff, Floor Staff, Cashier, Other).' });
    }

    // Check if username, email, or phone is already taken
    const [existing] = await pool.query(
      'SELECT id, username, email, phone FROM users WHERE LOWER(TRIM(username)) = ? OR LOWER(TRIM(email)) = ? OR TRIM(phone) = ? LIMIT 1',
      [cleanUsername, cleanEmail, cleanPhone]
    );

    if (existing.length > 0) {
      if (existing[0].username && existing[0].username.toLowerCase() === cleanUsername) {
        return res.status(400).json({ error: 'This username is already taken. Please choose another username.' });
      }
      if (existing[0].email && existing[0].email.toLowerCase() === cleanEmail) {
        return res.status(400).json({ error: 'An account with this email already exists.' });
      }
      if (existing[0].phone && existing[0].phone === cleanPhone) {
        return res.status(400).json({ error: 'An account with this mobile number already exists.' });
      }
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const passwordHash = await bcrypt.hash(password, 10);

    // Save in otp_verifications
    await pool.query('DELETE FROM otp_verifications WHERE LOWER(TRIM(email)) = ? AND purpose = "employee_registration"', [cleanEmail]);
    await pool.query(
      'INSERT INTO otp_verifications (id, email, otp, purpose, payload, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        uuidv4(),
        cleanEmail,
        otp,
        'employee_registration',
        JSON.stringify({
          name: name.trim(),
          username: cleanUsername,
          phone: cleanPhone,
          email: cleanEmail,
          role: role,
          passwordHash
        }),
        expiresAt
      ]
    );

    // Send verification code with terms and filled details
    await sendEmployeeRegistrationOtpEmail(cleanEmail, otp, {
      name: name.trim(),
      username: cleanUsername,
      phone: cleanPhone,
      email: cleanEmail,
      role: role
    });

    res.json({
      success: true,
      message: `Verification code and terms sent to ${cleanEmail}.`
    });
  } catch (error) {
    logger.error('Employee register send-otp error:', error);
    res.status(500).json({ error: 'Failed to initiate employee registration.' });
  }
});

// ========================================================
// 8. Employee Registration - Step 2: Verify OTP & Create Pending Account
// ========================================================
router.post('/employee/register/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and verification code are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = otp.toString().trim().replace(/\s+/g, '');

    const [records] = await pool.query(
      'SELECT * FROM otp_verifications WHERE LOWER(TRIM(email)) = ? AND TRIM(otp) = ? AND purpose = "employee_registration" ORDER BY created_at DESC LIMIT 1',
      [cleanEmail, cleanOtp]
    );

    if (records.length === 0) {
      return res.status(400).json({ error: 'Invalid verification code. Please check your email.' });
    }

    const record = records[0];
    if (new Date() > new Date(record.expires_at)) {
      await pool.query('DELETE FROM otp_verifications WHERE id = ?', [record.id]);
      return res.status(400).json({ error: 'Verification code has expired. Please register again.' });
    }

    const payload = typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload;
    const userId = uuidv4();

    // Create user in 'pending_approval' state
    await pool.query(
      'INSERT INTO users (id, name, username, email, phone, password_hash, role, employee_role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        userId,
        payload.name,
        payload.username,
        payload.email,
        payload.phone,
        payload.passwordHash,
        'staff',
        payload.role,
        'pending_approval'
      ]
    );

    // Delete used OTP
    await pool.query('DELETE FROM otp_verifications WHERE id = ?', [record.id]);

    res.status(201).json({
      success: true,
      message: 'Registration submitted successfully! Your account is now pending approval by the Restaurant Owner.'
    });
  } catch (error) {
    logger.error('Employee verify-otp error:', error);
    res.status(500).json({ error: 'Failed to complete employee registration.' });
  }
});

export default router;

