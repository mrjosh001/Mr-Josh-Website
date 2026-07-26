const User = require('./userModel'); // Adjust path to your user model file
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Secret key for JWT (use an environment variable in production: process.env.JWT_SECRET)
const JWT_SECRET = 'your_super_secret_key_here';

// --- SIGN UP ENDPOINT ---
async function signup(req, res) {
    try {
        const { name, email, phone, password } = req.body;

        // 1. Check if user already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'Email is already registered.' });
        }

        // 2. Hash the password securely
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // 3. Save the new user to the database
        const newUser = new User({
            name,
            email,
            phone,
            password: hashedPassword
        });

        await newUser.save();

        // 4. Generate token immediately upon sign-up so the profile loads right away
        const token = jwt.sign({ userId: newUser._id }, JWT_SECRET, { expiresIn: '1d' });

        // 5. Return success message, token, and user details (including id)
        res.status(201).json({
            message: 'Account created successfully!',
            token,
            user: {
                id: newUser._id,
                name: newUser.name,
                email: newUser.email,
                phone: newUser.phone
            }
        });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Server error during registration.' });
    }
}

// --- SIGN IN ENDPOINT ---
async function signin(req, res) {
    try {
        const { email, password } = req.body;

        // 1. Find user by email
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ error: 'Invalid email or password.' });
        }

        // 2. Compare submitted password with the stored hashed password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(400).json({ error: 'Invalid email or password.' });
        }

        // 3. Generate a secure token valid for 1 day
        const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '1d' });

        // 4. Return token and user details including the id so the profile UI loads correctly
        res.status(200).json({
            message: 'Signed in successfully',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                phone: user.phone
            }
        });
    } catch (error) {
        console.error('Signin error:', error);
        res.status(500).json({ error: 'Server error during sign in.' });
    }
}

// --- GET PROFILE ENDPOINT ---
async function getProfile(req, res) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Access denied. No token provided.' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        // Find user by ID stored in token, excluding the password field
        const user = await User.findById(decoded.userId).select('-password');
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        res.status(200).json(user);
    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(401).json({ error: 'Invalid or expired token.' });
    }
}

module.exports = { signup, signin, getProfile };
