declare module '*.json' {
  const value: any;
  export default value;
}

declare module '*.png' {
  const value: string;
  export default value;
}

declare module '*.jpg' {
  const value: string;
  export default value;
}

declare module '*.jpeg' {
  const value: string;
  export default value;
}

declare module '*.svg' {
  const value: string;
  export default value;
}

interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: 'customer' | 'staff' | 'owner';
  created_at: Date;
  updated_at: Date;
}

interface Restaurant {
  id: string;
  name: string;
  address: string;
  phone: string;
  created_at: Date;
  updated_at: Date;
}

interface Table {
  id: string;
  restaurant_id: string;
  table_number: number;
  capacity: number;
  status: 'available' | 'occupied' | 'reserved';
  created_at: Date;
  updated_at: Date;
}

interface MenuCategory {
  id: string;
  restaurant_id: string;
  name: string;
  description?: string;
  created_at: Date;
  updated_at: Date;
}

interface MenuItem {
  id: string;
  category_id: string;
  name: string;
  description?: string;
  price: number;
  image_url?: string;
  is_vegetarian: boolean;
  is_jain: boolean;
  is_available: boolean;
  created_at: Date;
  updated_at: Date;
}

interface Order {
  id: string;
  user_id: string;
  restaurant_id: string;
  table_id?: string;
  status: 'placed' | 'awaiting_acceptance' | 'accepted' | 'preparing' | 'ready' | 'served' | 'cancelled' | 'cancellation_requested' | 'refund_pending' | 'refund_completed';
  total_amount: number;
  payment_status: 'pending' | 'paid' | 'refunded';
  created_at: Date;
  updated_at: Date;
}

interface OrderItem {
  id: string;
  order_id: string;
  menu_item_id: string;
  quantity: number;
  price: number;
  special_instructions?: string;
  status: 'pending' | 'preparing' | 'ready' | 'served' | 'cancelled';
  created_at: Date;
  updated_at: Date;
}

interface OrderCancellation {
  id: string;
  order_id: string;
  cancelled_by: string;
  reason?: string;
  status: 'requested' | 'approved' | 'rejected' | 'cancelled' | 'refund_pending' | 'refund_completed';
  created_at: Date;
  updated_at: Date;
}

interface OrderSupportRequest {
  id: string;
  order_id: string;
  user_id: string;
  type: 'replacement' | 'refund' | 'help';
  reason?: string;
  description?: string;
  status: 'pending_review' | 'approved' | 'rejected' | 'replacement_preparing' | 'replacement_ready' | 'refund_pending' | 'refund_completed' | 'closed';
  created_at: Date;
  updated_at: Date;
}
