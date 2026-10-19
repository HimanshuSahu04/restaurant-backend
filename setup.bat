# Restaurant Management System - Setup Script
# Run this script to set up the project automatically
# This script will:
# 1. Check if MySQL is running
# 2. Create the database (idempotent)
# 3. Run migrations (tables already have IF NOT EXISTS)
# 4. Seed data (idempotent with INSERT IGNORE)

cd backend

echo "🔄 Installing backend dependencies..."
npm install --silent 2>/dev/null

echo "🔄 Running database migrations..."
node scripts/migrate.js

echo "🔄 Seeding database with test data..."
node scripts/seed.js

echo "✅ Backend setup complete!"
echo ""
echo "📋 Test accounts:"
echo "   Customer: customer@example.com / password123"
echo "   Staff:    staff@example.com / password123"
echo "   Owner:    owner@example.com / password123"
echo ""
echo "🚀 To start the backend:"
echo "   npm run dev"
echo ""
echo "📱 To start customer app:"
echo "   cd ../customer-app && npm install && npx expo start"
echo ""
echo "🏪 To start staff app:"
echo "   cd ../staff-app && npm install && npx expo start"
