#!/bin/bash
# Restaurant Management System - Setup Script (Linux/Mac)
# Run: bash setup.sh

echo "🍽️  Restaurant Management System - Setup"
echo ""

# Check if MySQL is running
if ! command -v mysql &> /dev/null; then
    echo "❌ MySQL client not found. Please install MySQL first."
    exit 1
fi

cd backend

echo "🔄 Installing backend dependencies..."
npm install --silent

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
