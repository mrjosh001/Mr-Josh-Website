import fs from 'fs';

const path = 'api/grizzly-sync.js';
let source = fs.readFileSync(path, 'utf8');

source = source.replace(".select('balance, customer_id')", ".select('balance, balance_usd, customer_id')");
source = source.replace(
  "    originalBalance = Number(profile.balance || 0);\n    customerId = profile.customer_id;",
  "    originalBalance = Number(profile.balance || 0);\n    originalBalanceUsd = Number(profile.balance_usd || 0);\n    customerId = profile.customer_id;"
);
source = source.replace(
  "  let originalBalance = 0;\n",
  "  let originalBalance = 0;\n  let originalBalanceUsd = 0;\n  let debitSplit = { ngn: 0, usd: 0 };\n"
);

const debitBlock = /    if \(originalBalance < price\) \{[\s\S]*?    deducted = true;/;
const replacement = `    // Shared atomic dual-wallet allocation. Never reject on NGN alone.
    const { data: debited, error: deductErr } = await supabase.rpc('debit_balance_if_sufficient', {
      p_user_id: user_id,
      p_amount: price
    });
    if (deductErr) {
      console.error('[grizzly order] debit_balance_if_sufficient', deductErr.message);
      return res.status(500).json({
        success: false,
        message: 'Could not debit your wallet safely. Please try again or contact support.'
      });
    }

    const debitRow = Array.isArray(debited) ? debited[0] : debited;
    const debitOk = debitRow && (debitRow.success === true || debitRow.success === 'true' || debitRow.success === 1);
    if (!debitOk) {
      return res.status(402).json({
        success: false,
        message: 'Insufficient balance',
        required: price,
        available: Number(debitRow?.new_balance ?? originalBalance),
        available_usd: Number(debitRow?.new_balance_usd ?? originalBalanceUsd)
      });
    }

    debitSplit = {
      ngn: Number(debitRow.ngn_debited || 0),
      usd: Number(debitRow.usd_debited || 0)
    };
    const newBalance = Number(debitRow.new_balance ?? (originalBalance - debitSplit.ngn));
    deducted = true;`;

if (!debitBlock.test(source)) throw new Error('Server 1 NGN-only debit block not found');
source = source.replace(debitBlock, replacement);

source = source.replace(
  "update({ balance: originalBalance }).eq('id', user_id)",
  "update({ balance: originalBalance, balance_usd: originalBalanceUsd }).eq('id', user_id)"
);
source = source.replace(
  ".select('balance').eq('id', user_id).maybeSingle();\n        return res.status(200).json",
  ".select('balance, balance_usd').eq('id', user_id).maybeSingle();\n        return res.status(200).json"
);
source = source.replace(
  "            new_balance: Number(balRow?.balance || 0),",
  "            new_balance: Number(balRow?.balance || 0),\n            new_balance_usd: Number(balRow?.balance_usd || 0),"
);
source = source.replace(
  "        new_balance: newBalance,\n        created_at",
  "        new_balance: newBalance,\n        new_balance_usd: Number(debitRow?.new_balance_usd ?? originalBalanceUsd - debitSplit.usd),\n        ngn_debited: debitSplit.ngn,\n        usd_debited: debitSplit.usd,\n        created_at"
);

fs.writeFileSync(path, source);
console.log('Server 1 dual-wallet checkout patch applied during Vercel build.');
