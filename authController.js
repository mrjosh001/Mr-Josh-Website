import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const supabaseUrl = process.env.SUPABASE_URL || 'https://atczodlljmlayvldxfmv.supabase.co';
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_dwbeKLcSG7-nfKzZz8x8Zw_U9FtwJTy';

const supabase = createClient(supabaseUrl, supabaseKey);
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_here';

// --- SIGN UP ENDPOINT ---
async function signup(req, res) {
    try {
        const { name, username, email, phone, password, bio, streetAddress, city, country, postalCode, nin, bvn } = req.body;

        const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: { 
                    full_name: name, 
                    username: username || (name ? name.toLowerCase().replace(/\s+/g, '') : ''),
                    phone_number: phone,
                    bio: bio || '',
                    street_address: streetAddress || '',
                    city: city || '',
                    country: country || 'Nigeria',
                    postal_code: postalCode || '',
                    nin: nin || '',
                    bvn: bvn || ''
                }
            }
        });

        if (authError) {
            return res.status(400).json({ error: authError.message });
        }

        const userId = authData.user.id;

        // Insert comprehensive initial profile fields into profiles table with robust persistence structure
        const { error: profileError } = await supabase
            .from('profiles')
            .upsert([
                {
                    id: userId,
                    full_name: name,
                    username: username || (name ? name.toLowerCase().replace(/\s+/g, '') : ''),
                    email: email,
                    phone_number: phone,
                    bio: bio || '',
                    street_address: streetAddress || '',
                    city: city || '',
                    country: country || 'Nigeria',
                    postal_code: postalCode || '',
                    nin: nin || '',
                    bvn: bvn || ''
                }
            ]);

        if (profileError) {
            return res.status(400).json({ error: profileError.message });
        }

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

        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (authError) {
            return res.status(400).json({ error: 'Invalid email or password.' });
        }

        const userId = authData.user.id;

        // Fetch user profile from Supabase with fallback check
        let { data: profileData, error: profileFetchError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();

        // If profile doesn't exist yet, fetch & save/initialize it automatically from metadata or defaults
        if (profileFetchError || !profileData) {
            const metadata = authData.user.user_metadata || {};
            const fallbackName = metadata.full_name || email.split('@')[0];
            
            const newProfilePayload = {
                id: userId,
                full_name: fallbackName,
                username: metadata.username || fallbackName.toLowerCase().replace(/\s+/g, ''),
                email: email,
                phone_number: metadata.phone_number || metadata.phone || '',
                bio: metadata.bio || '',
                street_address: metadata.street_address || '',
                city: metadata.city || '',
                country: metadata.country || 'Nigeria',
                postal_code: metadata.postal_code || '',
                nin: metadata.nin || '',
                bvn: metadata.bvn || ''
            };

            const { data: insertedProfile, error: insertError } = await supabase
                .from('profiles')
                .upsert([newProfilePayload])
                .select()
                .single();

            if (!insertError && insertedProfile) {
                profileData = insertedProfile;
            }
        }

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
        const userId = decoded.userId;

        // Fetch user profile record
        let { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();

        // If fetch fails or record doesn't exist, generate a safe default saved entry
        if (error || !profile) {
            const { data: authUser } = await supabase.auth.admin.getUserById(userId);
            const email = authUser?.user?.email || '';
            const metadata = authUser?.user?.user_metadata || {};
            const fallbackName = metadata.full_name || email.split('@')[0] || 'User';

            const defaultProfile = {
                id: userId,
                full_name: fallbackName,
                username: metadata.username || fallbackName.toLowerCase().replace(/\s+/g, ''),
                email: email,
                phone_number: metadata.phone_number || metadata.phone || '',
                bio: metadata.bio || '',
                street_address: metadata.street_address || '',
                city: metadata.city || '',
                country: metadata.country || 'Nigeria',
                postal_code: metadata.postal_code || '',
                nin: metadata.nin || '',
                bvn: metadata.bvn || ''
            };

            // Save default profile row if missing
            const { data: savedProfile, error: saveError } = await supabase
                .from('profiles')
                .upsert([defaultProfile])
                .select()
                .single();

            if (!saveError && savedProfile) {
                profile = savedProfile;
            } else {
                profile = defaultProfile;
            }
        }

        // Return complete data object matching all required fields
        res.status(200).json({
            id: profile.id,
            fullName: profile.full_name || '',
            username: profile.username || '',
            email: profile.email || '',
            phoneNumber: profile.phone_number || '',
            bio: profile.bio || '',
            streetAddress: profile.street_address || '',
            city: profile.city || '',
            country: profile.country || '',
            postalCode: profile.postal_code || '',
            nin: profile.nin || '',
            bvn: profile.bvn || ''
        });
    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(401).json({ error: 'Invalid or expired token.' });
    }
}

// --- UPDATE PROFILE ENDPOINT ---
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

        // Save and update profile record securely using upsert to handle both updates and persistence across sessions
        const { data, error } = await supabase
            .from('profiles')
            .upsert({
                id: userId,
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
            .select()
            .single();

        if (error) {
            return res.status(400).json({ error: error.message });
        }

        // Also update auth user metadata for consistency across sessions
        await supabase.auth.admin.updateUserById(userId, {
            user_metadata: {
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
            }
        });

        res.status(200).json({
            message: 'Profile updated successfully',
            data
        });
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ error: 'Server error during profile update.' });
    }
}

// --- ADMIN LOOKUP ENDPOINT ---
async function lookupUserByCustomerId(req, res) {
    try {
        const { customerId } = req.query;

        if (!customerId) {
            return res.status(400).json({ error: 'Customer ID is required.' });
        }

        // Query Supabase profiles table using the customer ID field (adjust column name if it differs, e.g., 'customer_id')
        const { data: user, error } = await supabase
            .from('profiles')
            .select('id, email, full_name, phone_number, customer_id')
            .eq('customer_id', customerId)
            .single();

        if (error || !user) {
            return res.status(404).json({ message: 'User not found with this Customer ID.' });
        }

        res.status(200).json(user);
    } catch (error) {
        console.error('Lookup error:', error);
        res.status(500).json({ error: 'Server error during lookup.' });
    }
}

// --- TOKEN & SESSION TRIGGER LOGIC ---
async function verifySession(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided, authorization denied.' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        
        req.user = decoded;
        if (typeof next === 'function') {
            next();
        } else {
            return res.status(200).json({ valid: true, userId: decoded.userId });
        }
    } catch (error) {
        return res.status(401).json({ error: 'Token is invalid or expired.' });
    }
}

module.exports = { signup, signin, getProfile, updateProfile, lookupUserByCustomerId, verifySession };
