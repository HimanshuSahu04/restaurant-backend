import nodemailer from 'nodemailer';
import { logger } from '../utils/logger.js';

let transporter = null;

// Initialize transporter (checks for SMTP environment variables or fallback to test/console mode)
const getTransporter = async () => {
  if (transporter) return transporter;

  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  } else {
    // Development fallback using Ethereal or test account
    try {
      const testAccount = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });
      logger.info(`Initialized dev email transporter (Ethereal: ${testAccount.user})`);
    } catch (err) {
      logger.warn('Could not create ethereal test account, will log OTPs directly.');
      transporter = {
        sendMail: async (opts) => {
          logger.info(`[EMAIL TO ${opts.to}]: ${opts.subject}\n${opts.text || opts.html}`);
          return { messageId: 'simulated-' + Date.now() };
        }
      };
    }
  }

  return transporter;
};

export const sendOtpEmail = async (email, otp, purpose = 'login') => {
  const mailer = await getTransporter();
  const subject = purpose === 'registration'
    ? 'Verify Your Restaurant Account - OTP'
    : 'Your Login Verification Code';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; borderRadius: 12px;">
      <h2 style="color: #007AFF; text-align: center;">Restaurant App Verification</h2>
      <p style="font-size: 15px; color: #4a5568;">Hello,</p>
      <p style="font-size: 15px; color: #4a5568;">
        Your one-time verification code for <strong>${purpose}</strong> is:
      </p>
      <div style="text-align: center; margin: 24px 0;">
        <span style="display: inline-block; font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #1a202c; background: #f7fafc; padding: 12px 28px; border-radius: 8px; border: 1px dashed #cbd5e0;">
          ${otp}
        </span>
      </div>
      <p style="font-size: 13px; color: #718096; text-align: center;">
        This OTP is valid for 10 minutes. If you did not request this, please ignore this email.
      </p>
    </div>
  `;

  try {
    const info = await mailer.sendMail({
      from: process.env.EMAIL_FROM || '"Restaurant App" <no-reply@restaurant.com>',
      to: email,
      subject,
      html,
      text: `Your OTP code is ${otp}. Valid for 10 minutes.`
    });

    logger.info(`OTP email dispatched to ${email} (Message ID: ${info.messageId})`);
    if (nodemailer.getTestMessageUrl && info.messageId.indexOf('simulated') === -1) {
      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) {
        logger.info(`Preview Email URL: ${previewUrl}`);
      }
    }
    return true;
  } catch (error) {
    logger.error('Failed to send OTP email:', error);
    return false;
  }
};

export const sendWelcomeEmail = async (email, name) => {
  const mailer = await getTransporter();
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; borderRadius: 12px;">
      <h2 style="color: #28a745; text-align: center;">Registration Successful! 🎉</h2>
      <p style="font-size: 15px; color: #4a5568;">Dear <strong>${name}</strong>,</p>
      <p style="font-size: 15px; color: #4a5568;">
        Welcome to our restaurant! Your account has been registered successfully.
      </p>
      <p style="font-size: 15px; color: #4a5568;">
        You can now select your table, explore our menu, customize your order, and track meal preparation in real-time.
      </p>
      <div style="text-align: center; margin: 24px 0;">
        <span style="display: inline-block; font-size: 16px; font-weight: 600; color: #fff; background: #28a745; padding: 12px 24px; border-radius: 8px;">
          Enjoy Dining with Us
        </span>
      </div>
      <p style="font-size: 13px; color: #718096; text-align: center;">
        Thank you for choosing us!
      </p>
    </div>
  `;

  try {
    await mailer.sendMail({
      from: process.env.EMAIL_FROM || '"Restaurant App" <no-reply@restaurant.com>',
      to: email,
      subject: 'Welcome to Restaurant App - Registration Confirmed',
      html,
      text: `Welcome ${name}! Your account has been successfully registered.`
    });
    logger.info(`Welcome confirmation email dispatched to ${email}`);
    return true;
  } catch (error) {
    logger.error('Failed to send welcome email:', error);
    return false;
  }
};

export const sendEmployeeRegistrationOtpEmail = async (email, otp, details) => {
  const mailer = await getTransporter();
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 550px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
      <h2 style="color: #0284c7; text-align: center; margin-bottom: 4px;">Staff & Employee Registration</h2>
      <p style="text-align: center; color: #64748b; font-size: 13px; margin-top: 0;">Restaurant Operations Portal</p>
      
      <p style="font-size: 15px; color: #334155;">Dear <strong>${details.name}</strong>,</p>
      <p style="font-size: 14px; color: #475569; line-height: 1.5;">
        You have initiated registration to join our restaurant team as a <strong>${details.role}</strong>. Please use the verification code below to verify your email address.
      </p>

      <div style="background-color: #f0f9ff; border: 1.5px dashed #0284c7; border-radius: 10px; padding: 16px; text-align: center; margin: 20px 0;">
        <span style="display: block; font-size: 12px; font-weight: 700; color: #0369a1; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">
          Your 6-Digit Email Verification Code
        </span>
        <span style="display: inline-block; font-size: 32px; font-weight: 900; color: #0284c7; letter-spacing: 6px;">
          ${otp}
        </span>
        <span style="display: block; font-size: 11px; color: #64748b; margin-top: 6px;">
          Valid for 15 minutes. Do not share this code.
        </span>
      </div>

      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin-bottom: 20px;">
        <h4 style="margin: 0 0 10px 0; color: #0f172a; font-size: 13px; text-transform: uppercase;">Submitted Registration Details:</h4>
        <table style="width: 100%; font-size: 13px; color: #334155;">
          <tr><td style="padding: 4px 0; color: #64748b; width: 130px;">Full Name:</td><td><strong>${details.name}</strong></td></tr>
          <tr><td style="padding: 4px 0; color: #64748b;">Username:</td><td><strong>${details.username}</strong></td></tr>
          <tr><td style="padding: 4px 0; color: #64748b;">Phone Number:</td><td><strong>${details.phone}</strong></td></tr>
          <tr><td style="padding: 4px 0; color: #64748b;">Email Address:</td><td><strong>${details.email}</strong></td></tr>
          <tr><td style="padding: 4px 0; color: #64748b;">Desired Role:</td><td><strong>${details.role}</strong></td></tr>
        </table>
      </div>

      <div style="border-top: 1px solid #e2e8f0; padding-top: 14px; margin-top: 20px;">
        <h4 style="margin: 0 0 6px 0; color: #475569; font-size: 12px; text-transform: uppercase;">Terms & Employment Notice:</h4>
        <p style="font-size: 11px; color: #64748b; line-height: 1.5; margin: 0;">
          By completing this verification, you agree to our restaurant conduct policy, hygiene standards, shift timing logs, and customer service agreements. Once verified, your application will be submitted to the Restaurant Owner for final addition to the roster. You will be able to access the operational kitchen dashboard upon Owner approval.
        </p>
      </div>

      <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 24px;">
        If you did not request this registration, please disregard this email.
      </p>
    </div>
  `;

  try {
    await mailer.sendMail({
      from: process.env.EMAIL_FROM || '"Restaurant App" <no-reply@restaurant.com>',
      to: email,
      subject: `Staff Verification Code: ${otp} - Restaurant Employment`,
      html,
      text: `Hello ${details.name}, your staff registration code is ${otp}. Role: ${details.role}. Terms & conditions apply.`
    });
    logger.info(`Employee registration OTP dispatched to ${email}`);
    return true;
  } catch (error) {
    logger.error('Failed to send employee registration OTP email:', error);
    return false;
  }
};


