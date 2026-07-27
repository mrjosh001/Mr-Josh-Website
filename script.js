/* ==========================================
   MJ HUB - Application Logic & Support Widget (v4.4)
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
let userData = { name: '', email: '', phone: '', address: '', bio: '', bvn: '', nin: '', avatarUrl: '' };

document.addEventListener('DOMContentLoaded', async () => {
    // Initialize Support Widget & Draggable Functionality (incorporating user snippet)
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
        
        // Close support popup if clicked outside widget container
        const widget = document.getElementById('support-widget');
        const popup = document.getElementById('support-popup');
        if (widget && popup && !widget.contains(e.target)) {
            popup.classList.remove('active');
            widget.classList.remove('open');
        }
    });

    renderTransactions('all');
});

/* ==========================================
   SUPPORT WIDGET & DRAGGABLE LOGIC (Updated)
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

    // Toggle Popup Visibility (only if user wasn't dragging)
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

    // Dragging Logic
    toggleBtn.addEventListener('mousedown', (e) => {
        isDragging = true;
        hasMoved = false;
        startX = e.clientX;
        startY = e.clientY;

        const rect = widget.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;

        // Switch from bottom/right layout to fixed coordinate layout for dragging
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
            // Close popup if dragged to prevent weird offsets
            popup.classList.remove('active');
            widget.classList.remove('open');
        }

        let newX = initialX + dx;
        let newY = initialY + dy;

        // Boundary constraints to keep widget within viewport
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
        
        // Reset hasMoved flag shortly after click release
        setTimeout(() => {
            hasMoved = false;
        }, 50);
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

function applyCurrencyConversion() {
    if (conversionDirection === 'usdtongn') {
        dashboardCurrencyMode = 'ngn';
    } else {
        dashboardCurrencyMode = 'usd';
    }
    updateBalanceDisplay();
    closeCurrencyModal();
    alert('Dashboard currency updated successfully!');
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

function filterTransactions(type, btnElement) {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    btnElement.classList.add('active');
    renderTransactions(type);
}

function renderTransactions(filterType) {
    const container = document.getElementById('transactionListContainer');
    let filtered = transactions;
    if(filterType !== 'all') {
        filtered = transactions.filter(tx => tx.type === filterType);
    }

    if(filtered.length === 0) {
        container.innerHTML = `<div class="empty-text">No transaction history found.</div>`;
        return;
    }

    container.innerHTML = '';
    filtered.forEach(tx => {
        let icon = '📦';
        let iconClass = 'tx-blue';
        if(tx.type === 'deposit') { icon = '💳'; iconClass = 'tx-blue'; }
        else if(tx.type === 'sms') { icon = '📱'; iconClass = 'tx-blue'; }
        else if(tx.type === 'booster') { icon = '⚡'; iconClass = 'tx-blue'; }

        let card = document.createElement('div');
        card.className = 'transaction-card';
        card.innerHTML = `
            <div class="transaction-left">
                <div class="transaction-icon-box ${iconClass}">${icon}</div>
                <div class="transaction-details">
                    <h4>${tx.title}</h4>
                    <span>${tx.subtitle} • ${tx.date}</span>
                </div>
            </div>
            <div class="transaction-right">
                <div class="transaction-amount">${tx.amount}</div>
                <span class="transaction-status status-${tx.status.toLowerCase()}">${tx.status}</span>
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

function buyNowItem(title, price, type) {
    if(currentBalanceNgn < price) {
        alert('Insufficient NGN balance. Please fund your wallet first.');
        switchSection('deposit');
        return;
    }
    currentBalanceNgn -= price;
    currentBalanceUsd = currentBalanceNgn / exchangeRate;
    transactions.unshift({ id: Date.now(), type, title, subtitle: 'Instant Purchase', amount: '₦' + price.toLocaleString(), date: 'Just now', status: 'Success' });
    updateBalanceDisplay();
    renderTransactions('all');
    alert(title + ' purchased successfully!');
    switchSection('home');
}

function checkoutCart() {
    let total = cartItems.reduce((sum, item) => sum + item.price, 0);
    if(total === 0) { alert('Your cart is empty.'); return; }
    if(currentBalanceNgn < total) {
        alert('Insufficient balance to checkout. Please add funds.');
        switchSection('deposit');
        return;
    }
    currentBalanceNgn -= total;
    currentBalanceUsd = currentBalanceNgn / exchangeRate;
    cartItems.forEach(item => {
        transactions.unshift({ id: Date.now(), type: item.type, title: item.title, subtitle: 'Cart Checkout', amount: '₦' + item.price.toLocaleString(), date: 'Just now', status: 'Success' });
    });
    cartItems = [];
    updateCartUI();
    updateBalanceDisplay();
    renderTransactions('all');
    alert('All items successfully purchased!');
    switchSection('home');
}

function processDeposit() {
    let amt = parseFloat(document.getElementById('depositInput').value) || 0;
    if(amt <= 0) { alert('Please enter a valid amount.'); return; }
    currentBalanceNgn += amt;
    currentBalanceUsd = currentBalanceNgn / exchangeRate;
    transactions.unshift({ id: Date.now(), type: 'deposit', title: 'Card / Bank Transfer', subtitle: 'Wallet funding', amount: '₦' + amt.toLocaleString(), date: 'Just now', status: 'Success' });
    updateBalanceDisplay();
    renderTransactions('all');
    alert('Wallet funded successfully with ₦' + amt.toLocaleString() + '!');
    switchSection('home');
}

function updateBalanceDisplay() {
    currentBalanceUsd = currentBalanceNgn / exchangeRate;
    
    document.getElementById('navWalletBadge').textContent = 'NGN ₦' + currentBalanceNgn.toLocaleString(undefined, {minimumFractionDigits: 2});
    
    if (dashboardCurrencyMode === 'usd') {
        document.getElementById('balanceLabelPrimary').textContent = 'USD Balance';
        document.getElementById('homePrimaryBalance').textContent = '$' + currentBalanceUsd.toLocaleString(undefined, {minimumFractionDigits: 2});
        document.getElementById('balanceIconPrimary').className = 'sleek-card-icon icon-white';
        document.getElementById('balanceIconPrimary').textContent = '💵';

        document.getElementById('balanceLabelSecondary').textContent = 'NGN Balance';
        document.getElementById('homeSecondaryBalance').textContent = '₦' + currentBalanceNgn.toLocaleString(undefined, {minimumFractionDigits: 2});
        document.getElementById('balanceIconSecondary').className = 'sleek-card-icon icon-blue';
        document.getElementById('balanceIconSecondary').textContent = '💳';
    } else {
        document.getElementById('balanceLabelPrimary').textContent = 'NGN Balance';
        document.getElementById('homePrimaryBalance').textContent = '₦' + currentBalanceNgn.toLocaleString(undefined, {minimumFractionDigits: 2});
        document.getElementById('balanceIconPrimary').className = 'sleek-card-icon icon-blue';
        document.getElementById('balanceIconPrimary').textContent = '💳';

        document.getElementById('balanceLabelSecondary').textContent = 'USD Balance';
        document.getElementById('homeSecondaryBalance').textContent = '$' + currentBalanceUsd.toLocaleString(undefined, {minimumFractionDigits: 2});
        document.getElementById('balanceIconSecondary').className = 'sleek-card-icon icon-white';
        document.getElementById('balanceIconSecondary').textContent = '💵';
    }

    document.getElementById('profileBalanceDisplay').textContent = '₦' + currentBalanceNgn.toLocaleString(undefined, {minimumFractionDigits: 2});
}
