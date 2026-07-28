const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Middleware to parse JSON request bodies from the frontend
app.use(express.json());

// Initialize Supabase Admin Client
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Supplier API Config
const FADDED_API_KEY = process.env.FADDED_API_KEY;
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
                price: item.unit_price, // You can apply a price markup formula here if desired
                stock_quantity: item.in_stock,
                is_available: item.in_stock > 0,
                source: 'api', // Flags this product as an automated API product
                updated_at: new Date().toISOString()
            };

            // Upsert into Supabase (Inserts new products, updates existing ones matching 'product_key')
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

        // Call fadded.net order endpoint
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

        // Return supplier items/credentials to your checkout handler securely
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

// Catch-all route to serve index.html for frontend routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
