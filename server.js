// Sidebar Drawer Elements
const menuToggle = document.getElementById('menu-toggle');
const closeMenu = document.getElementById('close-menu');
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('sidebar-overlay');

// Open Sidebar
menuToggle.addEventListener('click', () => {
    sidebar.classList.add('open');
    overlay.classList.add('active');
});

// Close Sidebar function
function closeSidebarNav() {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
}

closeMenu.addEventListener('click', closeSidebarNav);
overlay.addEventListener('click', closeSidebarNav);

// Tab Navigation Switching
document.querySelectorAll('.tab-link').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetTab = link.getAttribute('data-tab');

        // Remove active states from links & sections
        document.querySelectorAll('.tab-link').forEach(l => l.classList.remove('active'));
        document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));

        // Activate selected item
        link.classList.add('active');
        document.getElementById(targetTab).classList.add('active');

        // Close drawer automatically on mobile view
        closeSidebarNav();
    });
});

// Mock Application State & History Handlers
let userWallet = 5000; // Default startup mockup balance
const balanceDisplay = document.getElementById('wallet-balance');

function updateWalletUI(newBalance) {
    userWallet = newBalance;
    balanceDisplay.textContent = `₦${userWallet.toLocaleString()}`;
}
updateWalletUI(userWallet);

// Helper function to append orders to respective history lists
function addHistoryItem(listId, textMessage) {
    const listElement = document.getElementById(listId);
    
    // Clear default empty text if present
    if (listElement.children.length === 1 && listElement.children[0].textContent.includes('yet')) {
        listElement.innerHTML = '';
    }

    const listItem = document.createElement('li');
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    listItem.textContent = `[${timestamp}] ${textMessage}`;
    listElement.prepend(listItem);
}

// Action Button Simulations
document.getElementById('generate-sms-btn').addEventListener('click', () => {
    const service = document.getElementById('sms-service-select').value;
    addHistoryItem('sms-order-history', `Generated OTP Number for ${service.toUpperCase()}`);
    alert('OTP Number Generated Successfully!');
});

document.getElementById('buy-log-btn').addEventListener('click', () => {
    const logType = document.getElementById('log-type-select').value;
    addHistoryItem('logs-order-history', `Purchased log package: ${logType}`);
    alert('Log credentials unlocked successfully!');
});

document.getElementById('buy-boost-btn').addEventListener('click', () => {
    const boostType = document.getElementById('boost-service-select').value;
    addHistoryItem('boost-order-history', `Submitted boost task: ${boostType}`);
    alert('SME Booster order submitted successfully!');
});

document.getElementById('deposit-btn').addEventListener('click', () => {
    const amountInput = document.getElementById('deposit-amount');
    const amount = parseFloat(amountInput.value);

    if (isNaN(amount) || amount <= 0) {
        alert('Please enter a valid funding amount.');
        return;
    }

    updateWalletUI(userWallet + amount);
    addHistoryItem('deposit-history', `Successfully funded ₦${amount.toLocaleString()}`);
    amountInput.value = '';
    alert('Wallet funded successfully!');
});
