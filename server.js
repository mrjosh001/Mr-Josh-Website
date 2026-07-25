require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('📦 MongoDB Connected Successfully'))
    .catch((err) => console.error('❌ DB Error:', err));

// Define User Schema for Wallet
const User = mongoose.model('User', new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    balance: { type: Number, default: 0 }
}));

// --- API ROUTES ---

// Test Route
app.get('/', (req, res) => {
    res.json({ success: true, message: "API is live and running!" });
});

// Get User Wallet Balance
app.get('/api/user/wallet/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        let user = await User.findOne({ userId });

        if (!user) {
            user = await User.create({ userId, balance: 0 });
        }

        res.json({ success: true, balance: user.balance });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
