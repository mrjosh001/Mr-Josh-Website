const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Middleware to parse JSON request bodies from the frontend
app.use(express.json());

// Initialize Supabase Admin Client safely with fallbacks to prevent startup crashes
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("WARNING: Supabase URL or Key is missing from environment variables.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Supplier API Config
const FADDED_API_KEY = process.env.FADDED_API_KEY || 'rsk_live_s5ATWd0yskBvEagViPwQd6HxwfdLrkkpGyZIZFXDnhPEj8W6';
const FADDED_BASE_URL = 'https://fadded.net/api/v1/reseller';

// Common Headers for Supplier API
const supplierHeaders = {
    'X-Api-Key': FADDED_API_KEY,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
};

// =======================================================
// 1. ENDPOINT: Sync Products & Stock from Supplier to Supabase
// =======================================================
app.get('/api/sync-products', async (req, res) => {
    try {
        // Step A: Fetch products from fadded.net API
        const supplierRes = await fetch(`${FADDED_BASE_URL}/products`, {
            method: 'GET',
            headers: supplierHeaders
        });
        const supplierData = await supplierRes.json();

        if (!supplierData.success) {
            return res.status(400).json({ 
                success: false, 
                message: 'Failed to fetch products from supplier', 
                error: supplierData 
            });
        }

        const products = supplierData.data;

        // Step B: Loop through and update/insert products in Supabase
        for (const item of products) {
            const productRecord = {
                product_key: item.product_key,
                name: item.name,
                description: item.description,
                price: item.unit_price, 
                stock_quantity: item.in_stock,
                is_available: item.in_stock > 0,
                source: 'api',
                updated_at: new Date().toISOString()
            };

            const { error } = await supabase
                .from('products')
                .upsert(productRecord, { onConflict: 'product_key' });

            if (error) {
                console.error(`Error updating product ${item.product_key}:`, error);
            }
        }

        return res.json({ 
            success: true, 
            message: `Successfully synced ${products.length} products with Supabase.` 
        });

    } catch (error) {
        console.error('Product sync error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// =======================================================
// 2. ENDPOINT: Automatically Place Order with Supplier
// =======================================================
app.post('/api/place-order', async (req, res) => {
    try {
        const { product_key, quantity, external_order_id, customer_info } = req.body;

        if (!product_key || !quantity) {
            return res.status(400).json({ success: false, message: 'product_key and quantity are required.' });
        }

        const supplierRes = await fetch(`${FADDED_BASE_URL}/order`, {
            method: 'POST',
            headers: supplierHeaders,
            body: JSON.stringify({
                product_key,
                quantity,
                external_order_id,
                customer_info
            })
        });

        const orderData = await supplierRes.json();

        if (!orderData.success) {
            return res.status(400).json({ 
                success: false, 
                code: orderData.code, 
                message: orderData.message || 'Order failed at supplier' 
            });
        }

        return res.json({
            success: true,
            message: 'Order fulfilled successfully',
            data: orderData.data
        });

    } catch (error) {
        console.error('Order processing error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// =======================================================
// 3. ENDPOINT: Check Supplier Wallet Balance
// =======================================================
app.get('/api/supplier-balance', async (req, res) => {
    try {
        const response = await fetch(`${FADDED_BASE_URL}/balance`, {
            method: 'GET',
            headers: supplierHeaders
        });
        const data = await response.json();
        return res.json(data);
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Serving Static Frontend Files
app.use(express.static(path.join(__dirname)));

// Corrected Catch-all route: excludes /api/ requests so frontend scripts and assets load properly
app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
