/* ==========================================
   MJ HUB - Application Logic & Support Widget (v5.1 - Transaction Insertion & RLS Hardened)
   ========================================== */

const SUPABASE_URL = 'https://atczodlljmlayvldxfmv.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_dwbeKLcSG7-nfKzZz8x8Zw_U9FtwJTy';

let supabaseClient = null;
if (window.supabase && SUPABASE_URL !== 'https://YOUR_PROJECT_ID.supabase.co') {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
}

let currentBalanceNgn = 0.00;
let currentBalanceUsd = 0.00;
let dashboardCurrencyMode = 'ngn'; 
let conversionDirection = 'usdtongn'; 
let exchangeRate = 1420; 

let cartItems = [];
let transactions = [];
let userOnboarded = false;
let userData = { name: '', email: '', phone: '', address: '', bio: '', bvn: '', nin: '', avatarUrl: '', customerId: '' };

let currentActiveFilter = 'all';

document.addEventListener('DOMContentLoaded', async () => {
    // Initialize Support Widget & Draggable Functionality
    initSupportWidgetAndDragging();

    // Wire up Customer Lookup Logic
    const lookupBtn = document.getElementById('lookupBtn');
    const searchInput = document.getElementById('searchCustomerId');
    const userResultCard = document.getElementById('userResultCard');
    const resCustomerId = document.getElementById('resCustomerId');
    const resEmail = document.getElementById('resEmail');
    const errorMessage = document.getElementById('errorMessage');

    if (lookupBtn) {
      lookupBtn.addEventListener('click', async () => {
        const customerId = searchInput.value.trim();
        errorMessage.textContent = '';
        userResultCard.style.display = 'none';

        if (!customerId) {
          errorMessage.textContent = 'Please enter a valid Customer ID.';
          return;
        }

        try {
          const response = await fetch(`/api/admin/users/lookup?customerId=${customerId}`);
          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.message || 'User not found.');
          }

          // Populate and display the user info
          resCustomerId.textContent = data.customerId;
          resEmail.textContent = data.email;
          userResultCard.style.display = 'block';

        } catch (err) {
          errorMessage.textContent = err.message;
        }
      });
    }

    if (supabaseClient) {
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        
        if (session && !error) {
            const user = session.user;
            const meta = user.user_metadata || {};
            const userEmail = user.email;
            const displayName = meta.full_name || meta.username || userEmail.split('@')[0];
            const phoneVal = meta.phone || '';
            const addressVal = meta.address || '';
            const bioVal = meta.bio || '';
            const bvnVal = meta.bvn || '';
            const ninVal = meta.nin || '';
            const avatarVal = meta.avatar_url || '';
            
            userData.email = userEmail;
            userData.name = displayName;
            userData.phone = phoneVal;
            userData.address = addressVal;
            userData.bio = bioVal;
            userData.bvn = bvnVal;
            userData.nin = ninVal;
            userData.avatarUrl = avatarVal;
            userOnboarded = true;
            
            // Populate UI Elements
            document.getElementById('dropdownName').textContent = displayName;
            document.getElementById('dropdownEmail').textContent = userEmail;
            document.getElementById('profileHeaderName').textContent = displayName;
            document.getElementById('profileHeaderEmail').textContent = userEmail;
            document.getElementById('heroWelcomeTitle').textContent = 'Welcome back, ' + displayName + '!';
            document.getElementById('heroSubText').textContent = 'Manage your account balance and access MJ Boosters, MJ SMS, and MJ Logs seamlessly.';
            
            if(avatarVal) {
                document.getElementById('headerAvatarText').innerHTML = `<img src="${avatarVal}" alt="Avatar">`;
                document.getElementById('profileAvatarInitial').innerHTML = `<img src="${avatarVal}" alt="Avatar">`;
            } else {
                document.getElementById('headerAvatarText').textContent = displayName.charAt(0).toUpperCase();
                document.getElementById('profileAvatarInitial').textContent = displayName.charAt(0).toUpperCase();
            }

            // Populate Profile Settings Form Inputs
            document.getElementById('profileNameInput').value = displayName;
            document.getElementById('profileEmailInput').value = userEmail;
            document.getElementById('profilePhoneInput').value = phoneVal;
            document.getElementById('profileAddressInput').value = addressVal;
            document.getElementById('profileBioInput').value = bioVal;
            document.getElementById('profileBvnInput').value = bvnVal;
            document.getElementById('profileNinInput').value = ninVal;

            // Fetch live user balance and customer_id from profiles table
            await fetchUserProfileAndBalance(user.id);

            // Fetch live user transactions from Supabase database
            await fetchUserTransactions(user.id);

            // Enable real-time balance sync listener
            listenToBalanceChanges(user.id);
        }
    }

    const allSections = document.querySelectorAll('.app-section');
    const sidebarLinks = document.querySelectorAll('.sidebar-link');
    const sidebar = document.getElementById('sidebarDrawer');
    const overlay = document.getElementById('sidebarOverlay');
    const menuToggle = document.getElementById('menuToggleBtn');
    const sidebarClose = document.getElementById('sidebarCloseBtn');
    
    const profileToggle = document.getElementById('profileDropdownToggle');
    const profileDropdown = document.getElementById('profileDropdownMenu');

    const notifBtn = document.getElementById('notificationBtn');
    const notifDropdown = document.getElementById('notificationDropdown');
    const notifDot = document.getElementById('notifDot');
    
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    const dropdownThemeToggleBtn = document.getElementById('dropdownThemeToggleBtn');

    function toggleAppTheme() {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme');
        if(currentTheme === 'dark') {
            html.setAttribute('data-theme', 'light');
            themeToggleBtn.textContent = '☀️';
            dropdownThemeToggleBtn.textContent = 'Light';
            document.getElementById('themeIndicatorText').textContent = 'Light';
        } else {
            html.setAttribute('data-theme', 'dark');
            themeToggleBtn.textContent = '🌙';
            dropdownThemeToggleBtn.textContent = 'Dark';
            document.getElementById('themeIndicatorText').textContent = 'Dark';
        }
    }

    themeToggleBtn.addEventListener('click', toggleAppTheme);
    dropdownThemeToggleBtn.addEventListener('click', toggleAppTheme);

    function navigateToSection(targetId) {
        allSections.forEach(section => {
            section.classList.remove('active');
            if(section.id === targetId) { section.classList.add('active'); }
        });

        sidebarLinks.forEach(link => {
            link.classList.remove('active');
            if(link.getAttribute('data-target') === targetId) { link.classList.add('active'); }
        });

        document.querySelectorAll('.bottom-nav .nav-item').forEach(item => item.classList.remove('active'));
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    window.switchSection = function(sectionId) { 
        navigateToSection(sectionId); 
    };

    sidebarLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            const target = link.getAttribute('data-target');
            if(target) {
                e.preventDefault();
                navigateToSection(target);
                sidebar.classList.remove('open');
                overlay.classList.remove('active');
            }
        });
    });

    menuToggle.addEventListener('click', () => {
        sidebar.classList.add('open');
        overlay.classList.add('active');
    });

    sidebarClose.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
    });

    overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
        profileDropdown.classList.remove('active');
        notifDropdown.classList.remove('active');
        document.getElementById('floatingPopupModal').classList.remove('active');
        document.getElementById('changePasswordModal').classList.remove('active');
        document.getElementById('currencyConverterModal').classList.remove('active');
        document.getElementById('activityHistoryDrawer').classList.remove('active');
    });

    profileToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        profileDropdown.classList.toggle('active');
        notifDropdown.classList.remove('active');
    });

    notifBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        notifDropdown.classList.toggle('active');
        profileDropdown.classList.remove('active');
        notifDot.style.display = 'none';
    });

    document.addEventListener('click', (e) => {
        profileDropdown.classList.remove('active');
        notifDropdown.classList.remove('active');
        
        const widget = document.getElementById('support-widget');
        const popup = document.getElementById('support-popup');
        if (widget && popup && !widget.contains(e.target)) {
            popup.classList.remove('active');
            widget.classList.remove('open');
        }
    });

    renderTransactionsList();
});

/* ==========================================
   SUPPORT WIDGET & DRAGGABLE LOGIC
   ========================================== */
function initSupportWidgetAndDragging() {
    const widget = document.getElementById('support-widget');
    const toggleBtn = document.getElementById('support-toggle-btn');
    const popup = document.getElementById('support-popup');
    const closeBtn = document.getElementById('support-close-btn');
    if (!widget || !toggleBtn || !popup) return;

    let isDragging = false;
    let hasMoved = false;
    let startX, startY, initialX, initialY;

    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (hasMoved) return;
        const isOpen = popup.classList.toggle('active');
        widget.classList.toggle('open', isOpen);
    });

    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            popup.classList.remove('active');
            widget.classList.remove('open');
        });
    }

    toggleBtn.addEventListener('mousedown', (e) => {
        isDragging = true;
        hasMoved = false;
        startX = e.clientX;
        startY = e.clientY;

        const rect = widget.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;

        widget.style.bottom = 'auto';
        widget.style.right = 'auto';
        widget.style.left = `${initialX}px`;
        widget.style.top = `${initialY}px`;

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            hasMoved = true;
            popup.classList.remove('active');
            widget.classList.remove('open');
        }

        let newX = initialX + dx;
        let newY = initialY + dy;
        const maxX = window.innerWidth - widget.offsetWidth;
        const maxY = window.innerHeight - widget.offsetHeight;

        newX = Math.max(0, Math.min(newX, maxX));
        newY = Math.max(0, Math.min(newY, maxY));

        widget.style.left = `${newX}px`;
        widget.style.top = `${newY}px`;
    }

    function onMouseUp() {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        setTimeout(() => { hasMoved = false; }, 50);
    }
}

async function handleLogout() {
    if (supabaseClient) {
        await supabaseClient.auth.signOut();
    }
    window.location.href = 'landing.html';
}

function handleAvatarUpload(event) {
    const file = event.target.files[0];
    if(file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const base64Img = e.target.result;
            userData.avatarUrl = base64Img;
            document.getElementById('profileAvatarInitial').innerHTML = `<img src="${base64Img}" alt="Avatar">`;
            document.getElementById('headerAvatarText').innerHTML = `<img src="${base64Img}" alt="Avatar">`;
        };
        reader.readAsDataURL(file);
    }
}

async function saveProfileSettingsData() {
    let name = document.getElementById('profileNameInput').value.trim();
    let phone = document.getElementById('profilePhoneInput').value.trim();
    let address = document.getElementById('profileAddressInput').value.trim();
    let bio = document.getElementById('profileBioInput').value.trim();
    let bvn = document.getElementById('profileBvnInput').value.trim();
    let nin = document.getElementById('profileNinInput').value.trim();

    if(!name) {
        alert('Please enter your full name or username.');
        return;
    }

    if (supabaseClient) {
        const { error } = await supabaseClient.auth.updateUser({
            data: { 
                full_name: name, 
                phone: phone, 
                address: address, 
                bio: bio, 
                bvn: bvn, 
                nin: nin, 
                avatar_url: userData.avatarUrl 
            }
        });
        if (error) {
            alert('Error updating profile: ' + error.message);
            return;
        }
    }

    userData.name = name;
    userData.phone = phone;
    userData.address = address;
    userData.bio = bio;
    userData.bvn = bvn;
    userData.nin = nin;
    userOnboarded = true;

    document.getElementById('dropdownName').textContent = name;
    document.getElementById('profileHeaderName').textContent = name;
    document.getElementById('heroWelcomeTitle').textContent = 'Welcome back, ' + name + '!';

    alert('Complete profile settings, BVN, NIN, and bio saved successfully to Supabase!');
}

function openCurrencyModal() {
    document.getElementById('baseConvertInput').value = '';
    document.getElementById('targetConvertOutput').value = '';
    document.getElementById('currencyConverterModal').classList.add('active');
}

function closeCurrencyModal() {
    document.getElementById('currencyConverterModal').classList.remove('active');
}

function toggleConversionDirection() {
    if (conversionDirection === 'usdtongn') {
        conversionDirection = 'ngntousd';
        document.getElementById('toggleDirectionBtn').textContent = '🔄 Convert from: NGN (₦) to USD ($)';
        document.getElementById('convertInputLabel').textContent = 'Amount in NGN (₦)';
        document.getElementById('convertOutputLabel').textContent = 'Equivalent in USD ($)';
    } else {
        conversionDirection = 'usdtongn';
        document.getElementById('toggleDirectionBtn').textContent = '🔄 Convert from: USD ($) to NGN (₦)';
        document.getElementById('convertInputLabel').textContent = 'Amount in USD ($)';
        document.getElementById('convertOutputLabel').textContent = 'Equivalent in NGN (₦)';
    }
    document.getElementById('baseConvertInput').value = '';
    document.getElementById('targetConvertOutput').value = '';
}

function performCurrencyConversion() {
    let inputVal = parseFloat(document.getElementById('baseConvertInput').value) || 0;
    if (conversionDirection === 'usdtongn') {
        let res = inputVal * exchangeRate;
        document.getElementById('targetConvertOutput').value = '₦' + res.toLocaleString(undefined, {minimumFractionDigits: 2});
    } else {
        let res = inputVal / exchangeRate;
        document.getElementById('targetConvertOutput').value = '$' + res.toLocaleString(undefined, {minimumFractionDigits: 2});
    }
}

async function applyCurrencyConversion() {
    let inputVal = parseFloat(document.getElementById('baseConvertInput').value) || 0;
    if (inputVal <= 0) {
        dashboardCurrencyMode = (conversionDirection === 'usdtongn') ? 'usd' : 'ngn';
        updateBalanceDisplay();
        closeCurrencyModal();
        alert('Dashboard currency updated successfully!');
        return;
    }

    let newNgn = currentBalanceNgn;
    let newUsd = currentBalanceUsd;
    let conversionDesc = '';
    let convertedAmountStr = '';
    let amountUsdVal = 0;
    let amountNgnVal = 0;

    if (conversionDirection === 'ngntousd') {
        if (currentBalanceNgn < inputVal) {
            alert('Insufficient Naira (NGN) balance for this conversion.');
            return;
        }
        let usdGained = inputVal / exchangeRate;
        newNgn -= inputVal;
        newUsd += usdGained;
        conversionDesc = `Converted ₦${inputVal.toLocaleString()} to $${usdGained.toFixed(2)}`;
        convertedAmountStr = '$' + usdGained.toFixed(2);
        amountNgnVal = inputVal;
        amountUsdVal = usdGained;
    } else {
        if (currentBalanceUsd < inputVal) {
            alert('Insufficient USD balance for this conversion.');
            return;
        }
        let ngnGained = inputVal * exchangeRate;
        newUsd -= inputVal;
        newNgn += ngnGained;
        conversionDesc = `Converted $${inputVal.toLocaleString()} to ₦${ngnGained.toLocaleString()}`;
        convertedAmountStr = '₦' + ngnGained.toLocaleString();
        amountUsdVal = inputVal;
        amountNgnVal = ngnGained;
    }

    if (supabaseClient) {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            const { error: profileError } = await supabaseClient.from('profiles').update({ balance: newNgn, balance_usd: newUsd }).eq('id', session.user.id);
            if (profileError) {
                alert("Profile Update Error: " + profileError.message);
                return;
            }
            
            const { error: txError } = await supabaseClient.from('transactions').insert({
                user_id: session.user.id,
                customer_id: userData.customerId || null,
                type: 'conversion',
                category: 'deposit',
                title: 'Currency Conversion',
                subtitle: conversionDesc,
                amount: convertedAmountStr,
                amount_ngn: amountNgnVal,
                amount_usd: amountUsdVal,
                status: 'Success'
            });

            if (txError) {
                alert("Database Insert Error: " + txError.message);
                return;
            }

            await fetchUserTransactions(session.user.id);
        }
    }

    currentBalanceNgn = newNgn;
    currentBalanceUsd = newUsd;
    updateBalanceDisplay();
    closeCurrencyModal();
    alert('Currency converted and logged successfully!');
}

function openChangePasswordModal() {
    document.getElementById('changePasswordModal').classList.add('active');
}

function closeChangePasswordModal() {
    document.getElementById('changePasswordModal').classList.remove('active');
}

async function submitNewPassword() {
    let nxt = document.getElementById('newPasswordInput').value;
    let cfm = document.getElementById('confirmPasswordInput').value;

    if(!nxt || !cfm) {
        alert('Please fill out the new password fields.');
        return;
    }
    if(nxt !== cfm) {
        alert('New passwords do not match.');
        return;
    }

    if (supabaseClient) {
        const { error } = await supabaseClient.auth.updateUser({ password: nxt });
        if (error) {
            alert('Error updating password: ' + error.message);
            return;
        }
    }

    alert('Password updated successfully!');
    closeChangePasswordModal();
    document.getElementById('currentPasswordInput').value = '';
    document.getElementById('newPasswordInput').value = '';
    document.getElementById('confirmPasswordInput').value = '';
}

function toggleActivityHistory() {
    const drawer = document.getElementById('activityHistoryDrawer');
    const overlay = document.getElementById('sidebarOverlay');
    drawer.classList.toggle('active');
    overlay.classList.toggle('active');
}

/* ==========================================
   SUPABASE PROFILE & BALANCE FETCHING & REAL-TIME SYNC
   ========================================== */
async function fetchUserProfileAndBalance(userId) {
    if (!supabaseClient) return;
    try {
        const { data, error } = await supabaseClient
            .from('profiles')
            .select('balance, balance_usd, customer_id')
            .eq('id', userId)
            .single();

        if (data && !error) {
            currentBalanceNgn = parseFloat(data.balance) || 0.00;
            currentBalanceUsd = parseFloat(data.balance_usd) || (currentBalanceNgn / exchangeRate);
            if (data.customer_id) {
                userData.customerId = data.customer_id;
            }
            updateBalanceDisplay();
        }
    } catch (err) {
        console.error("Error fetching user profile balance:", err);
    }
}

function listenToBalanceChanges(userId) {
    if (!supabaseClient) return;
    supabaseClient
        .channel('public:profiles')
        .on('postgres_changes', { 
            event: 'UPDATE', 
            schema: 'public', 
            table: 'profiles', 
            filter: `id=eq.${userId}` 
        }, payload => {
            if (payload.new) {
                currentBalanceNgn = parseFloat(payload.new.balance) || 0.00;
                currentBalanceUsd = parseFloat(payload.new.balance_usd) || (currentBalanceNgn / exchangeRate);
                if (payload.new.customer_id) {
                    userData.customerId = payload.new.customer_id;
                }
                updateBalanceDisplay();
            }
        })
        .subscribe();
}

/* ==========================================
   DYNAMIC SUPABASE TRANSACTION FETCH & FILTER
   ========================================== */
async function fetchUserTransactions(userId) {
    if (!supabaseClient) return;
    try {
        const { data, error } = await supabaseClient
            .from('transactions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (data && !error) {
            transactions = data.map(tx => ({
                id: tx.id,
                category: tx.category || tx.type || 'deposit',
                title: tx.title || (tx.type === 'deposit' ? 'Wallet Deposit' : 'Currency Conversion'),
                subtitle: tx.subtitle || '',
                amount: tx.amount || (tx.amount_ngn ? '₦' + Number(tx.amount_ngn).toLocaleString() : '₦0.00'),
                date: new Date(tx.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                status: tx.status || 'Success'
            }));
            renderTransactionsList();
        }
    } catch (err) {
        console.error("Error fetching transactions:", err);
    }
}

function filterTransactions(category, btnElement) {
    currentActiveFilter = category;
    
    document.querySelectorAll('.filter-tab, .filter-tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    if (btnElement) {
        btnElement.classList.add('active');
    }

    renderTransactionsList();
}

function renderTransactionsList() {
    const container = document.getElementById('transactionListContainer') || document.getElementById('transactionsContainer');
    if (!container) return;

    let filtered = transactions;
    if (currentActiveFilter !== 'all') {
        filtered = transactions.filter(tx => tx.category === currentActiveFilter || tx.type === currentActiveFilter);
    }

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-text text-center text-slate-400 py-8 text-sm">No transaction history found.</div>`;
        return;
    }

    container.innerHTML = '';
    filtered.forEach(tx => {
        let icon = '💳';
        if (tx.category === 'sms' || tx.type === 'sms') icon = '📱';
        else if (tx.category === 'log' || tx.type === 'log') icon = '📦';
        else if (tx.category === 'booster' || tx.type === 'booster') icon = '⚡';

        let statusLower = (tx.status || '').toLowerCase();
        let statusClass = 'status-success';
        if (statusLower.includes('cancel')) statusClass = 'status-canceled';
        else if (statusLower.includes('pending') || statusLower.includes('code')) statusClass = 'status-pending';

        let card = document.createElement('div');
        card.className = 'transaction-card flex items-center justify-between p-3 mb-2 rounded-xl bg-slate-800/60 border border-slate-700/50';
        card.innerHTML = `
            <div class="transaction-left flex items-center space-x-3">
                <div class="transaction-icon-box p-2 rounded-lg bg-slate-700/50 text-blue-400">${icon}</div>
                <div class="transaction-details">
                    <h4 class="text-sm font-semibold text-white">${tx.title}</h4>
                    <span class="text-xs text-slate-400">${tx.subtitle} • ${tx.date}</span>
                </div>
            </div>
            <div class="transaction-right text-right">
                <div class="transaction-amount text-sm font-bold text-white">${tx.amount}</div>
                <span class="transaction-status ${statusClass} text-[10px] px-2 py-0.5 rounded-full font-medium">${tx.status}</span>
            </div>
        `;
        container.appendChild(card);
    });
}

function toggleFloatingPopup() {
    document.getElementById('floatingPopupModal').classList.toggle('active');
}

function addToCart(title, price, type) {
    cartItems.push({ id: Date.now(), title, price, type });
    updateCartUI();
    alert(title + ' added to your cart!');
}

function removeFromCart(id) {
    cartItems = cartItems.filter(item => item.id !== id);
    updateCartUI();
}

function updateCartUI() {
    let tbody = document.getElementById('cartTableBody');
    let totalDisplay = document.getElementById('cartTotalDisplay');
    
    if(!tbody || !totalDisplay) return;

    if(cartItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="empty-text">Your cart is currently empty.</td></tr>`;
        totalDisplay.textContent = '₦0.00';
        return;
    }

    tbody.innerHTML = '';
    let total = 0;
    cartItems.forEach(item => {
        total += item.price;
        let tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${item.title}</strong></td>
            <td><span class="badge-status badge-pending" style="text-transform:uppercase;">${item.type}</span></td>
            <td style="font-weight:700; color:var(--primary-color);">₦${item.price.toLocaleString()}</td>
            <td><button class="btn-sm-outline" style="color:var(--primary-color); border-color:var(--primary-color); padding:4px 8px;" onclick="removeFromCart(${item.id})">Remove</button></td>
        `;
        tbody.appendChild(tr);
    });
    totalDisplay.textContent = '₦' + total.toLocaleString(undefined, {minimumFractionDigits: 2});
}

async function buyNowItem(title, price, type) {
    if(currentBalanceNgn < price) {
        alert('Insufficient NGN balance. Please fund your wallet first.');
        switchSection('deposit');
        return;
    }
    let newNgn = currentBalanceNgn - price;
    let newUsd = newNgn / exchangeRate;

    if (supabaseClient) {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            const { error: profileError } = await supabaseClient.from('profiles').update({ balance: newNgn, balance_usd: newUsd }).eq('id', session.user.id);
            if (profileError) {
                alert("Profile Update Error: " + profileError.message);
                return;
            }
            
            const { error: txError } = await supabaseClient.from('transactions').insert({
                user_id: session.user.id,
                customer_id: userData.customerId || null,
                type: type,
                category: type,
                title: title,
                subtitle: 'Instant Purchase',
                amount: '₦' + price.toLocaleString(),
                amount_ngn: price,
                amount_usd: price / exchangeRate,
                status: 'Success'
            });

            if (txError) {
                alert("Database Insert Error: " + txError.message);
                return;
            }

            await fetchUserTransactions(session.user.id);
        }
    }

    currentBalanceNgn = newNgn;
    currentBalanceUsd = newUsd;
    updateBalanceDisplay();
    alert(title + ' purchased and logged successfully!');
    switchSection('home');
}

async function checkoutCart() {
    let total = cartItems.reduce((sum, item) => sum + item.price, 0);
    if(total === 0) { alert('Your cart is empty.'); return; }
    if(currentBalanceNgn < total) {
        alert('Insufficient balance to checkout. Please add funds.');
        switchSection('deposit');
        return;
    }
    let newNgn = currentBalanceNgn - total;
    let newUsd = newNgn / exchangeRate;

    if (supabaseClient) {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            const { error: profileError } = await supabaseClient.from('profiles').update({ balance: newNgn, balance_usd: newUsd }).eq('id', session.user.id);
            if (profileError) {
                alert("Profile Update Error: " + profileError.message);
                return;
            }

            for (let item of cartItems) {
                const { error: txError } = await supabaseClient.from('transactions').insert({
                    user_id: session.user.id,
                    customer_id: userData.customerId || null,
                    type: item.type,
                    category: item.type,
                    title: item.title,
                    subtitle: 'Cart Checkout',
                    amount: '₦' + item.price.toLocaleString(),
                    amount_ngn: item.price,
                    amount_usd: item.price / exchangeRate,
                    status: 'Success'
                });

                if (txError) {
                    alert("Database Insert Error on Cart Item: " + txError.message);
                    return;
                }
            }
            await fetchUserTransactions(session.user.id);
        }
    }

    currentBalanceNgn = newNgn;
    currentBalanceUsd = newUsd;
    cartItems = [];
    updateCartUI();
    updateBalanceDisplay();
    alert('All items successfully purchased and logged!');
    switchSection('home');
}

async function processDeposit() {
    let amt = parseFloat(document.getElementById('depositInput').value) || 0;
    if(amt <= 0) { alert('Please enter a valid amount.'); return; }
    
    let newNgn = currentBalanceNgn + amt;
    let newUsd = newNgn / exchangeRate;

    if (!supabaseClient) {
        alert('Error: Supabase client is not initialized!');
        return;
    }

    const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
    if (sessionError || !session) {
        alert('Authentication Error: No active session found. Please log in again.');
        return;
    }

    // 1. Update Profile Balance
    const { error: profileError } = await supabaseClient
        .from('profiles')
        .update({ balance: newNgn, balance_usd: newUsd })
        .eq('id', session.user.id);

    if (profileError) {
        alert("Profile Update Error: " + profileError.message);
        return;
    }
    
    // 2. Insert Transaction Record
    const { error: txError } = await supabaseClient
        .from('transactions')
        .insert({
            user_id: session.user.id,
            customer_id: userData.customerId || null,
            type: 'deposit',
            category: 'deposit',
            title: 'Card / Bank Transfer',
            subtitle: 'Wallet funding',
            amount: '₦' + amt.toLocaleString(),
            amount_ngn: amt,
            amount_usd: amt / exchangeRate,
            status: 'Success'
        });

    if (txError) {
        alert("Database Insert Error: " + txError.message);
        return;
    }

    currentBalanceNgn = newNgn;
    currentBalanceUsd = newUsd;
    updateBalanceDisplay();
    
    await fetchUserTransactions(session.user.id);
    
    alert('Wallet funded with ₦' + amt.toLocaleString() + ' and saved to database successfully!');
    switchSection('home');
}

function updateBalanceDisplay() {
    currentBalanceUsd = currentBalanceNgn / exchangeRate;
    
    const navBadge = document.getElementById('navWalletBadge');
    if (navBadge) navBadge.textContent = 'NGN ₦' + currentBalanceNgn.toLocaleString(undefined, {minimumFractionDigits: 2});
    
    const primaryLabel = document.getElementById('balanceLabelPrimary');
    const primaryBal = document.getElementById('homePrimaryBalance');
    const secLabel = document.getElementById('balanceLabelSecondary');
    const secBal = document.getElementById('homeSecondaryBalance');
    const profBal = document.getElementById('profileBalanceDisplay');

    if (dashboardCurrencyMode === 'usd') {
        if (primaryLabel) primaryLabel.textContent = 'USD Balance';
        if (primaryBal) primaryBal.textContent = '$' + currentBalanceUsd.toLocaleString(undefined, {minimumFractionDigits: 2});
        if (secLabel) secLabel.textContent = 'NGN Balance';
        if (secBal) secBal.textContent = '₦' + currentBalanceNgn.toLocaleString(undefined, {minimumFractionDigits: 2});
    } else {
        if (primaryLabel) primaryLabel.textContent = 'NGN Balance';
        if (primaryBal) primaryBal.textContent = '₦' + currentBalanceNgn.toLocaleString(undefined, {minimumFractionDigits: 2});
        if (secLabel) secLabel.textContent = 'USD Balance';
        if (secBal) secBal.textContent = '$' + currentBalanceUsd.toLocaleString(undefined, {minimumFractionDigits: 2});
    }

    if (profBal) profBal.textContent = '₦' + currentBalanceNgn.toLocaleString(undefined, {minimumFractionDigits: 2});
}
