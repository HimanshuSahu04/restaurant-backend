import Joi from 'joi';

// User validation schema
const userSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  phone: Joi.string().pattern(/^[0-9]{10,15}$/).required(),
  password: Joi.string().min(6).required(),
  role: Joi.string().valid('customer', 'staff', 'owner').required()
});

// Order validation schema
const orderSchema = Joi.object({
  restaurantId: Joi.string().required(),
  tableId: Joi.string().allow(null), // Optional for takeaway orders
  purchaseGoldMember: Joi.boolean().optional(),
  items: Joi.array().items(
    Joi.object({
      menuItemId: Joi.string().required(),
      quantity: Joi.number().integer().min(1).required(),
      price: Joi.number().positive().required(),
      specialInstructions: Joi.string().allow('')
    })
  ).min(1).required()
});

// Validate user data
const validateUser = (req, res, next) => {
  const { error } = userSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }
  next();
};

// Validate order data
const validateOrder = (req, res, next) => {
  const { error } = orderSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }
  next();
};

export { validateUser, validateOrder };
