import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

// Initialize Supabase client using environment variables
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_here';

// --- SIGN UP ENDPOINT ---
async function signup(req, res) {
    try {
        const { name, email, phone, password } = req.body;

        // 1. Sign up user with Supabase Auth (triggers email verification)
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: { full_name: name, phone }
            }
        });

        if (authError) {
            return res.status(400).json({ error: authError.message });
        }

        const userId = authData.user.id;

        // 2. Insert initial signup details into the public 'profiles' table for data persistence
        const { error: profileError } = await supabase
            .from('profiles')
            .upsert([
                {
                    id: userId,
                    full_name: name,
                    email: email,
                    phone_number: phone,
                    bio: '',
                    street_address: '',
                    city: '',
                    country: '',
                    postal_code: '',
                    nin: '',
                    bvn: ''
                }
            ]);

        if (profileError) {
            return res.status(400).json({ error: profileError.message });
        }

        // 3. Generate internal token if needed for immediate session handling
        const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1d' });

        res.status(201).json({
            message: 'Account created successfully! Please check your email for verification.',
            token,
            user: {
                id: userId,
                name,
                email,
                phone
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

        // 1. Authenticate user via Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (authError) {
            return res.status(400).json({ error: 'Invalid email or password.' });
        }

        const userId = authData.user.id;

        // 2. Fetch extended profile data to load onto dashboard/settings
        const { data: profileData, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();

        const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1d' });

        res.status(200).json({
            message: 'Signed in successfully',
            token,
            user: profileData || authData.user
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

        // Fetch user profile data from Supabase
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', decoded.userId)
            .single();

        if (error || !profile) {
            return res.status(404).json({ error: 'User profile not found.' });
        }

        res.status(200).json(profile);
    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(401).json({ error: 'Invalid or expired token.' });
    }
}

// --- UPDATE PROFILE ENDPOINT (For saving remaining fields) ---
async function updateProfile(req, res) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Access denied. No token provided.' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;

        const { 
            fullName, 
            username, 
            phoneNumber, 
            bio, 
            streetAddress, 
            city, 
            country, 
            postalCode, 
            nin, 
            bvn 
        } = req.body;

        const { data, error } = await supabase
            .from('profiles')
            .update({
                full_name: fullName,
                username: username,
                phone_number: phoneNumber,
                bio,
                street_address: streetAddress,
                city,
                country,
                postal_code: postalCode,
                nin,
                bvn
            })
            .eq('id', userId)
            .select()
            .single();

        if (error) {
            return res.status(400).json({ error: error.message });
        }

        res.status(200).json({
            message: 'Profile updated successfully',
            data
        });
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ error: 'Server error during profile update.' });
    }
}

module.exports = { signup, signin, getProfile, updateProfile };
