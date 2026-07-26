const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const { signup, signin, getProfile } = require('./authController');

const app = express();

// Middleware to parse JSON request bodies
app.use(express.json());

// This line tells Express to serve CSS and other files from the current folder
app.use(express.static(path.join(__dirname)));

// API Authentication & Profile Routes
app.post('/api/auth/signup', signup);
app.post('/api/auth/signin', signin);
app.get('/api/user/profile', getProfile);

// Catch-all route to serve index.html for frontend routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;

// Connect to MongoDB and start the server
mongoose.connect('mongodb://localhost:27017/mr-josh-db', {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => {
    console.log('Connected to MongoDB successfully');
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
})
.catch((err) => {
    console.error('Database connection error:', err);
});
