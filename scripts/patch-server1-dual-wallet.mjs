import fs from 'fs';

// Server 1 + Server 3 (shared grizzly-sync order path)
{
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
      return res.status(500).json({ success: false, message: 'Could not debit your wallet safely. Please try again or contact support.' });
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

    debitSplit = { ngn: Number(debitRow.ngn_debited || 0), usd: Number(debitRow.usd_debited || 0) };
    const newBalance = Number(debitRow.new_balance ?? (originalBalance - debitSplit.ngn));
    deducted = true;`;

  if (!debitBlock.test(source)) throw new Error('Server 1 NGN-only debit block not found');
  source = source.replace(debitBlock, replacement);
  source = source.replace("update({ balance: originalBalance }).eq('id', user_id)", "update({ balance: originalBalance, balance_usd: originalBalanceUsd }).eq('id', user_id)");
  source = source.replace(".select('balance').eq('id', user_id).maybeSingle();\n        return res.status(200).json", ".select('balance, balance_usd').eq('id', user_id).maybeSingle();\n        return res.status(200).json");
  source = source.replace("            new_balance: Number(balRow?.balance || 0),", "            new_balance: Number(balRow?.balance || 0),\n            new_balance_usd: Number(balRow?.balance_usd || 0),");
  source = source.replace("        new_balance: newBalance,\n        created_at", "        new_balance: newBalance,\n        new_balance_usd: Number(debitRow?.new_balance_usd ?? originalBalanceUsd - debitSplit.usd),\n        ngn_debited: debitSplit.ngn,\n        usd_debited: debitSplit.usd,\n        created_at");
  fs.writeFileSync(path, source);
}

// Server 2 (SMS-BUS): replace its old NGN-only precheck with the same
// authoritative atomic dual-wallet RPC. Server 2's existing callers remain intact.
{
  const path = 'api/sms-bus.js';
  let source = fs.readFileSync(path, 'utf8');

  source = source.replace(".select('balance, customer_id')", ".select('balance, balance_usd, customer_id')");

  const oldPrecheck = /  const bal = Number\(profile\.balance\) \|\| 0;\n  if \(bal \+ 1e-9 < amt\) \{[\s\S]*?  \}\n  const \{ data: debited, error: debErr \} = await supabase\.rpc\('debit_balance_if_sufficient', \{/;
  const newPrecheck = `  const bal = Number(profile.balance) || 0;
  const balUsd = Number(profile.balance_usd) || 0;
  // Do not reject based on NGN alone. The RPC atomically allocates NGN, USD,
  // or both according to the configured USD/NGN conversion rules.
  const { data: debited, error: debErr } = await supabase.rpc('debit_balance_if_sufficient', {`;

  if (!oldPrecheck.test(source)) throw new Error('Server 2 NGN-only wallet precheck not found');
  source = source.replace(oldPrecheck, newPrecheck);

  // Capture the exact wallet split returned by the RPC for downstream order/refund linkage.
  source = source.replace(
    "  if (!isDebitOk(debited, debErr)) {",
    "  const debitRow = Array.isArray(debited) ? debited[0] : debited;\n  const ngnDebited = Number(debitRow?.ngn_debited || 0);\n  const usdDebited = Number(debitRow?.usd_debited || 0);\n  if (!isDebitOk(debited, debErr)) {"
  );
  source = source.replace(
    "      balance_before: bal\n    };\n  }\n  // Verify row actually dropped",
    "      balance_before: bal,\n      balance_usd_before: balUsd\n    };\n  }\n  // Verify both wallet deltas when the RPC provides the authoritative split.\n  const { data: afterSplit } = await supabase.from('profiles').select('balance, balance_usd').eq('id', userId).maybeSingle();\n  const afterNgn = Number(afterSplit?.balance);\n  const afterUsd = Number(afterSplit?.balance_usd);\n  if (Number.isFinite(afterNgn) && Math.abs((bal - afterNgn) - ngnDebited) > 0.01) {\n    return { ok: false, message: 'Wallet debit verification failed. Please try again.', balance_before: bal, balance_usd_before: balUsd };\n  }\n  if (Number.isFinite(afterUsd) && Math.abs((balUsd - afterUsd) - usdDebited) > 0.01) {\n    return { ok: false, message: 'Wallet debit verification failed. Please try again.', balance_before: bal, balance_usd_before: balUsd };\n  }\n  // Verify row actually dropped"
  );
  source = source.replace(
    "    balance_before: bal,\n    new_balance: newBal\n  };",
    "    balance_before: bal,\n    balance_usd_before: balUsd,\n    new_balance: newBal,\n    new_balance_usd: Number(after?.balance_usd ?? balUsd - usdDebited),\n    ngn_debited: ngnDebited,\n    usd_debited: usdDebited\n  };"
  );

  fs.writeFileSync(path, source);
}

console.log('Dual-wallet checkout patch applied for Server 1, Server 2, and Server 3 during Vercel build.');
