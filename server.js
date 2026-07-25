const conversionRate = 1400.00;
let currentConvMode = 'USD_NGN';
let walletBalance = 4400.00; // Tracking NGN balance

// Bottom Sheet Handling (`+` button)
function openActionSheet() {
    document.getElementById('action-sheet-overlay').classList.add('active');
    document.getElementById('action-sheet').classList.add('active');
}

function closeActionSheet() {
    document.getElementById('action-sheet-overlay').classList.remove('active');
    document.getElementById('action-sheet').classList.remove('active');
}

// Currency Converter Modal Handling
function openConverterModal() {
    document.getElementById('converter-modal-overlay').classList.add('active');
    document.getElementById('converter-modal').classList.add('active');
    document.getElementById('conv-input-amount').value = '1';
    document.getElementById('converter-rate-display').textContent = `1 USD = ₦${conversionRate.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    calculateConversion();
}

function closeConverterModal() {
    document.getElementById('converter-modal-overlay').classList.remove('active');
    document.getElementById('converter-modal').classList.remove('active');
}

function setConversionMode(mode) {
    currentConvMode = mode;
    if(mode === 'USD_NGN') {
        document.getElementById('tab-usd-ngn').classList.add('active');
        document.getElementById('tab-ngn-usd').classList.remove('active');
        document.getElementById('conv-symbol-send').textContent = 'USD';
        document.getElementById('conv-symbol-receive').textContent = 'NGN';
        document.getElementById('converter-rate-display').textContent = `1 USD = ₦${conversionRate.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    } else {
        document.getElementById('tab-ngn-usd').classList.add('active');
        document.getElementById('tab-usd-ngn').classList.remove('active');
        document.getElementById('conv-symbol-send').textContent = 'NGN';
        document.getElementById('conv-symbol-receive').textContent = 'USD';
        let inverseRate = (1 / conversionRate).toFixed(6);
        document.getElementById('converter-rate-display').textContent = `1 NGN = $${inverseRate} USD`;
    }
    calculateConversion();
}

function calculateConversion() {
    let val = parseFloat(document.getElementById('conv-input-amount').value) || 0;
    let usdEq = walletBalance / conversionRate;

    if(currentConvMode === 'USD_NGN') {
        let res = val * conversionRate;
        document.getElementById('conv-output-amount').textContent = `₦${res.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        document.getElementById('conv-available-text').textContent = `Available: $${usdEq.toFixed(2)} USD`;
    } else {
        let res = val / conversionRate;
        document.getElementById('conv-output-amount').textContent = `$${res.toFixed(2)}`;
        document.getElementById('conv-available-text').textContent = `Available: ₦${walletBalance.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
    }
}

function executeConversion() {
    let val = parseFloat(document.getElementById('conv-input-amount').value) || 0;
    if(val <= 0) {
        alert('Please enter a valid conversion amount.');
        return;
    }

    if(currentConvMode === 'USD_NGN') {
        let requiredUsd = val;
        let userUsd = walletBalance / conversionRate;
        if(userUsd < requiredUsd) {
            alert('Insufficient USD balance.');
            return;
        }
        alert('Currency converted successfully!');
    } else {
        if(walletBalance < val) {
            alert('Insufficient NGN balance.');
            return;
        }
        alert('Currency converted successfully!');
    }
    closeConverterModal();
}

function switchSection(sectionId) {
    console.log('Switching to section: ' + sectionId);
}

function toggleSidebar() {
    console.log('Toggle sidebar clicked');
}
