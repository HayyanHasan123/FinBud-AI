import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import GrowMyMoneySection from '../components/advisor/GrowMyMoneySection.jsx'
import AnalyticsView from '../components/dashboard/Analytics.jsx'
import WalletView from '../components/dashboard/Wallet.jsx'

const DAILY_TRANSFER_LIMIT = 200000

const REDEMPTION_TIERS = {
  cash_voucher:      { label: 'Cash Voucher',      points_cost: 500,  pkr_value: 250 },
  product_purchase:  { label: 'Product Purchase',  points_cost: 1000, pkr_value: 500 },
  investment_pocket: { label: 'Investment Pocket', points_cost: 750,  pkr_value: 375 }
}

const MOCK_PRODUCT_CATALOGUE = {
  P001: { name: 'FinBud Prepaid Mobile Recharge', pkr_value: 200 },
  P002: { name: 'FinBud Shopping Gift Voucher',   pkr_value: 500 },
  P003: { name: 'FinBud Utility Bill Discount',   pkr_value: 300 }
}

// SBP-assigned 4-letter bank identifier codes — occupy characters 5-8 of every
// Pakistani IBAN (e.g. PK36 SCBL 0000... -> "SCBL" = Standard Chartered).
// Used both to auto-detect the destination bank on Send Money (per mentor
// feedback) and to populate the bank picker in the Wallet/Link Account flow.
const PAKISTAN_BANK_CODES = {
  HABB: 'Habib Bank Limited (HBL)',
  UNIL: 'United Bank Limited (UBL)',
  MUCB: 'MCB Bank',
  MCIB: 'MCB Islamic Bank',
  MEZN: 'Meezan Bank',
  ALFH: 'Bank Alfalah',
  ABPA: 'Allied Bank',
  ASCM: 'Askari Bank',
  BAHL: 'Bank Al Habib',
  FAYS: 'Faysal Bank',
  NBPA: 'National Bank of Pakistan',
  SONE: 'Soneri Bank',
  SCBL: 'Standard Chartered Pakistan',
  JSBL: 'JS Bank',
  BKIP: 'BankIslami',
  KHYB: 'Bank of Khyber',
  BPUN: 'Bank of Punjab',
  SILK: 'Silk Bank',
  SUMB: 'Summit Bank',
  SIND: 'Sindh Bank',
  MPBL: 'Habib Metropolitan Bank',
}
const PAKISTAN_BANKS = Array.from(new Set(Object.values(PAKISTAN_BANK_CODES))).sort()

function detectBankFromIBAN(iban) {
  if (!iban || iban.length < 8) return null
  const code = iban.slice(4, 8).toUpperCase()
  return PAKISTAN_BANK_CODES[code] || null
}

// Heuristic recurring-charge detector — groups expense transactions by
// description and flags ones that repeat 2+ times at a consistent amount
// (within 15%). Works entirely off /api/transaction/history, no new backend
// endpoint required. Bills naturally vary month to month (electricity usage
// changes) so they won't false-positive here — this only catches genuinely
// fixed-price recurring charges, the way Rocket Money's detector does.
function detectSubscriptions(transactions) {
  const groups = {}
  transactions.forEach(tx => {
    if (tx.amount >= 0) return
    const key = tx.description
    if (!groups[key]) groups[key] = []
    groups[key].push(Math.abs(tx.amount))
  })
  const subs = []
  Object.entries(groups).forEach(([description, amounts]) => {
    if (amounts.length < 2) return
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length
    const consistent = amounts.every(a => Math.abs(a - avg) / avg < 0.15)
    if (consistent) subs.push({ description, amount: avg, occurrences: amounts.length })
  })
  return subs.sort((a, b) => b.amount - a.amount)
}



// Fallback list — matches app.py's EXPENSE_CATEGORIES exactly (per mentor
// MoM Session 3). Used only until /api/transaction/categories responds;
// after that, the dropdown uses whatever the backend actually validates
// against, so the two can never drift out of sync again.
const FALLBACK_EXPENSE_CATEGORIES = [
  'Transfer', 'Grocery', 'Utility Bills', 'Rent', 'Household Staff',
  'Society Maintenance', 'Car & Fuel', 'Medical', 'Education', 'Entertainment', 'Other'
]

// What to actually print in transaction history / receipts. The backend now
// stores a real `category` per transaction (dashboard_transactions.category),
// so a categorized transfer (e.g. "Grocery") shows that instead of the raw
// "Transfer to X" description — no client-side guessing needed.
function getTransactionDisplayLabel(tx) {
  if (tx?.transaction_type === 'transfer' && tx?.category && tx.category !== 'Transfer') {
    return tx.category
  }
  return tx?.description || ''
}

// Per-provider icon + color so the Pay Bill picker shows a distinct visual
// for each biller instead of one generic icon repeated for every row.
// Matched case-insensitively against whatever name the backend returns for
// /api/bills/providers, so it degrades gracefully to a category default
// (still colored, just not brand-specific) for any provider not listed here.
const BILLER_VISUALS = {
  // Electricity DISCOs
  'k-electric':  { icon: 'fa-bolt',   color: '#D71920' },
  'kelectric':   { icon: 'fa-bolt',   color: '#D71920' },
  'lesco':       { icon: 'fa-bolt',   color: '#00923F' },
  'pesco':       { icon: 'fa-bolt',   color: '#F7941D' },
  'hesco':       { icon: 'fa-bolt',   color: '#0072BC' },
  'mepco':       { icon: 'fa-bolt',   color: '#8DC63F' },
  'gepco':       { icon: 'fa-bolt',   color: '#662D91' },
  'sepco':       { icon: 'fa-bolt',   color: '#00AEEF' },
  'qesco':       { icon: 'fa-bolt',   color: '#ED1C24' },
  'iesco':       { icon: 'fa-bolt',   color: '#F15A29' },
  'fesco':       { icon: 'fa-bolt',   color: '#0089CF' },
  'tesco':       { icon: 'fa-bolt',   color: '#39B54A' },
  // Gas
  'ssgc':        { icon: 'fa-fire',   color: '#F7941D' },
  'sui southern gas company': { icon: 'fa-fire', color: '#F7941D' },
  'sngpl':       { icon: 'fa-fire',   color: '#00A651' },
  'sui northern gas pipelines limited': { icon: 'fa-fire', color: '#00A651' },
  // Internet / landline
  'ptcl':        { icon: 'fa-wifi',   color: '#004990' },
  'nayatel':     { icon: 'fa-wifi',   color: '#F15A29' },
  'stormfiber':  { icon: 'fa-wifi',   color: '#00AEEF' },
  'storm fiber': { icon: 'fa-wifi',   color: '#00AEEF' },
  'wateen':      { icon: 'fa-wifi',   color: '#662D91' },
  // Mobile network operators
  'jazz':        { icon: 'fa-signal', color: '#F68B1F' },
  'zong':        { icon: 'fa-signal', color: '#66C430' },
  'ufone':       { icon: 'fa-signal', color: '#00954F' },
  'telenor':     { icon: 'fa-signal', color: '#0066B3' },
}

// Category-level fallback (still gives each PayBillStep1 tile its own tone).
const CATEGORY_VISUALS = {
  electricity: { icon: 'fa-bolt', color: '#F7941D' },
  gas:         { icon: 'fa-fire', color: '#EF5350' },
  internet:    { icon: 'fa-wifi', color: '#0072BC' },
}

function getBillerVisual(providerName, category) {
  const key = (providerName || '').trim().toLowerCase()
  if (BILLER_VISUALS[key]) return BILLER_VISUALS[key]
  // Loose match: catches variants like "K-Electric (KE)" or "LESCO Lahore"
  const found = Object.keys(BILLER_VISUALS).find(k => key.includes(k))
  if (found) return BILLER_VISUALS[found]
  return CATEGORY_VISUALS[category] || { icon: 'fa-building', color: null }
}


// activity notification — useful in the receipt/print context, but repeated
// on every single line in the notification feed it's just noise that pushes
// short messages onto 2-3 lines. Strip it for display in the dropdown only;
// the raw message (with balance) is still what gets toasted/logged elsewhere.
function getActivitySummary(message) {
  if (!message) return ''
  return message.replace(/\s*Remaining balance:\s*PKR\s*[\d,.]+\.?\s*$/i, '').trim()
}

// ── TRANSLATIONS (English / Urdu / Roman Urdu) ────────────────────────
// Covers the primary user-facing surfaces: navigation, Home, Analytics,
// Wallet, and the core action modals (Send Money, Pay Bill, Rewards,
// Redeem Points, Top Up). Keys are looked up via t(key) inside Dashboard().
// User-typed input, transaction descriptions, and numeric/currency values
// are never translated — only static interface text.
const TRANSLATIONS = {
  // Nav / topbar / sidebar
  nav_home: { en: 'Home', ur: 'ہوم', roman: 'Home' },
  nav_analytics: { en: 'Analytics', ur: 'تجزیات', roman: 'Analytics' },
  nav_advisor: { en: 'Advisor', ur: 'مشیر', roman: 'Advisor' },
  nav_wallet: { en: 'Wallet', ur: 'بٹوہ', roman: 'Wallet' },
  nav_your_analytics: { en: 'Your Analytics', ur: 'آپ کے تجزیات', roman: 'Aap Ke Analytics' },
  nav_financial_advisor: { en: 'Financial Advisor', ur: 'مالی مشیر', roman: 'Financial Advisor' },
  topbar_dashboard: { en: 'Dashboard', ur: 'ڈیش بورڈ', roman: 'Dashboard' },
  sidebar_profile: { en: 'Profile Overview', ur: 'پروفائل کا جائزہ', roman: 'Profile Overview' },
  sidebar_settings: { en: 'Settings', ur: 'ترتیبات', roman: 'Settings' },
  sidebar_security: { en: 'Security Center', ur: 'سیکیورٹی سینٹر', roman: 'Security Center' },
  sidebar_reports: { en: 'Financial Reports', ur: 'مالی رپورٹس', roman: 'Financial Reports' },
  sidebar_logout: { en: 'LOG OUT', ur: 'لاگ آؤٹ', roman: 'Log Out' },
  sidebar_switch_profile: { en: 'Switch Profile', ur: 'پروفائل تبدیل کریں', roman: 'Profile Switch Karein' },
  sidebar_user_id: { en: 'User ID', ur: 'یوزر آئی ڈی', roman: 'User ID' },
  text_size: { en: 'Text Size', ur: 'تحریر کا سائز', roman: 'Text Size' },
  language: { en: 'Language', ur: 'زبان', roman: 'Zaban' },

  // Home
  home_hello: { en: 'Hello', ur: 'ہیلو', roman: 'Hello' },
  home_your_balance: { en: 'YOUR BALANCE:', ur: 'آپ کا بیلنس:', roman: 'Aap Ka Balance:' },
  home_show_balance: { en: 'SHOW BALANCE', ur: 'بیلنس دکھائیں', roman: 'Balance Dikhayein' },
  home_hide_balance: { en: 'HIDE BALANCE', ur: 'بیلنس چھپائیں', roman: 'Balance Chupayein' },
  home_topup: { en: '+ Top Up', ur: '+ ٹاپ اپ', roman: '+ Top Up' },
  action_send_money: { en: 'SEND MONEY', ur: 'رقم بھیجیں', roman: 'Paise Bhejein' },
  action_pay_bill: { en: 'PAY BILL', ur: 'بل ادا کریں', roman: 'Bill Pay Karein' },
  action_rewards: { en: 'REWARDS', ur: 'انعامات', roman: 'Rewards' },
  action_redeem_points: { en: 'REDEEM POINTS', ur: 'پوائنٹس ریڈیم کریں', roman: 'Points Redeem Karein' },
  chat_line1: { en: 'Chat With', ur: 'بات چیت کریں', roman: 'Chat Karein' },
  chat_line2: { en: 'Your AI Assistant', ur: 'اپنے اے آئی اسسٹنٹ سے', roman: 'Apne AI Assistant Se' },
  tx_recent: { en: 'Recent Transactions', ur: 'حالیہ لین دین', roman: 'Recent Transactions' },
  tx_date: { en: 'Date', ur: 'تاریخ', roman: 'Tareekh' },
  tx_type: { en: 'Type', ur: 'قسم', roman: 'Type' },
  tx_amount: { en: 'Amount', ur: 'رقم', roman: 'Raqam' },
  tx_empty: { en: 'No transactions yet', ur: 'ابھی تک کوئی لین دین نہیں', roman: 'Abhi Tak Koi Transaction Nahi' },
  tx_download_receipt: { en: 'Download Receipt', ur: 'رسید ڈاؤن لوڈ کریں', roman: 'Receipt Download Karein' },
  tx_download_history: { en: 'Download History', ur: 'ہسٹری ڈاؤن لوڈ کریں', roman: 'History Download Karein' },
  tx_download_history_note: { en: 'Choose a date range to download your transaction history as a PDF.', ur: 'اپنی لین دین کی ہسٹری پی ڈی ایف کے طور پر ڈاؤن لوڈ کرنے کے لیے تاریخوں کی حد منتخب کریں۔', roman: 'Apni transaction history PDF ke tor par download karne ke liye date range chunein.' },
  tx_start_date: { en: 'Start Date', ur: 'شروع کی تاریخ', roman: 'Shuru Ki Tareekh' },
  tx_end_date: { en: 'End Date', ur: 'آخری تاریخ', roman: 'Aakhri Tareekh' },
  bell_bill_reminders: { en: 'Bill Reminders', ur: 'بل کی یاد دہانی', roman: 'Bill Reminders' },
  bell_no_bills: { en: 'No bills due', ur: 'کوئی بل واجب الادا نہیں', roman: 'Koi Bill Due Nahi' },
  bell_activity: { en: 'Transaction Activity', ur: 'لین دین کی سرگرمی', roman: 'Transaction Activity' },
  bell_no_activity: { en: 'No activity yet', ur: 'ابھی تک کوئی سرگرمی نہیں', roman: 'Abhi Tak Koi Activity Nahi' },

  // Analytics (AnalyticsView, ../components/dashboard/Analytics.jsx)
  analytics_title: { en: 'Your Analytics', ur: 'آپ کے تجزیات', roman: 'Aap Ke Analytics' },
  analytics_subtitle: { en: 'Your income, spending, and money habits, all in one place.', ur: 'آپ کی آمدنی، اخراجات اور پیسوں کی عادات، سب ایک جگہ۔', roman: 'Aap Ki Income, Kharch, Aur Paison Ki Aadatein, Sab Aik Jagah.' },
  analytics_log_income: { en: '+ Log Income', ur: '+ آمدنی درج کریں', roman: '+ Income Likhein' },
  analytics_this_month: { en: 'This Month', ur: 'اس مہینے', roman: 'Is Mahine' },
  read_aloud: { en: '🔊 Read Aloud', ur: '🔊 پڑھ کر سنائیں', roman: '🔊 Parh Kar Sunayein' },
  analytics_income: { en: 'Income', ur: 'آمدنی', roman: 'Income' },
  analytics_expenses: { en: 'Expenses', ur: 'اخراجات', roman: 'Kharch' },
  analytics_net: { en: 'Net', ur: 'خالص', roman: 'Net' },
  analytics_safe_to_spend: { en: 'Safe to Spend', ur: 'خرچ کرنے کے لیے محفوظ رقم', roman: 'Safe To Spend' },
  analytics_suggested_savings: { en: 'Suggested Savings (20%)', ur: 'تجویز کردہ بچت (20%)', roman: 'Tajweez Kardah Bachat (20%)' },
  analytics_suggested_investment: { en: 'Suggested Investment (10%)', ur: 'تجویز کردہ سرمایہ کاری (10%)', roman: 'Tajweez Kardah Sarmaya Kari (10%)' },
  analytics_summary_empty: { en: "Income vs. expense tracking is coming online soon — this card will populate automatically once it's connected on the backend.", ur: 'آمدنی اور اخراجات کی ٹریکنگ جلد شروع ہو رہی ہے — بیک اینڈ سے منسلک ہوتے ہی یہ کارڈ خود بخود بھر جائے گا۔', roman: 'Income Vs Expense Tracking Jald Shuru Ho Rahi Hai — Yeh Card Backend Se Connect Hote Hi Khud Bhar Jayega.' },
  analytics_credit_score: { en: 'Credit Score', ur: 'کریڈٹ سکور', roman: 'Credit Score' },
  analytics_late_payments: { en: 'Late Payments', ur: 'تاخیر سے ادائیگیاں', roman: 'Late Payments' },
  analytics_monthly_trend: { en: 'Monthly Trend', ur: 'ماہانہ رجحان', roman: 'Monthly Trend' },
  analytics_trend_empty: { en: "Once a few months of data are in, you'll see your income vs. expense trend here.", ur: 'چند مہینوں کا ڈیٹا آنے کے بعد یہاں آپ کی آمدنی اور اخراجات کا رجحان نظر آئے گا۔', roman: 'Chand Mahino Ka Data Aane Ke Baad Yahan Aap Ka Income Vs Expense Trend Nazar Aayega.' },
  analytics_spending_pace: { en: 'Spending Pace', ur: 'خرچ کرنے کی رفتار', roman: 'Kharch Ki Raftaar' },
  analytics_pace_empty: { en: "Once last month is complete, this will compare how fast you're spending this month against last month's total.", ur: 'پچھلا مہینہ مکمل ہونے کے بعد، یہ موازنہ کرے گا کہ آپ اس مہینے کتنی تیزی سے خرچ کر رہے ہیں۔', roman: 'Pichla Mahina Mukammal Hone Ke Baad, Yeh Compare Karega Ke Aap Is Mahine Kitni Tezi Se Kharch Kar Rahe Hain.' },
  analytics_income_sources: { en: 'Income Sources', ur: 'آمدنی کے ذرائع', roman: 'Income Ke Zarayeh' },
  analytics_income_empty: { en: 'No income logged yet — tap "+ Log Income" to add your first entry.', ur: 'ابھی تک کوئی آمدنی درج نہیں — پہلی اندراج کے لیے "+ آمدنی درج کریں" پر ٹیپ کریں۔', roman: 'Abhi Tak Koi Income Likhi Nahi — Pehli Entry Ke Liye "+ Income Likhein" Par Tap Karein.' },
  analytics_spending_breakdown: { en: 'Spending Breakdown', ur: 'اخراجات کی تفصیل', roman: 'Kharch Ki Tafseel' },
  analytics_breakdown_empty: { en: 'No spending yet — make a transfer or pay a bill to see your breakdown.', ur: 'ابھی تک کوئی خرچ نہیں — تفصیل دیکھنے کے لیے رقم بھیجیں یا بل ادا کریں۔', roman: 'Abhi Tak Koi Kharch Nahi — Tafseel Dekhne Ke Liye Paise Bhejein Ya Bill Pay Karein.' },
  analytics_show_more: { en: 'Show More Insights (Subscriptions)', ur: 'مزید معلومات دکھائیں (سبسکرپشنز)', roman: 'Mazeed Maloomat Dikhayein (Subscriptions)' },
  analytics_subscriptions: { en: 'Subscriptions & Recurring', ur: 'سبسکرپشنز اور بار بار ادائیگیاں', roman: 'Subscriptions Aur Recurring' },
  analytics_preview: { en: 'Preview', ur: 'پیش منظر', roman: 'Preview' },
  analytics_subscriptions_empty: { en: "No fixed-amount recurring charges detected yet in your recent transactions. Once you have a few repeat payments of the same amount (like a subscription), they'll show up here automatically.", ur: 'آپ کے حالیہ لین دین میں ابھی تک کوئی مقررہ رقم کی بار بار ادائیگی نہیں ملی۔', roman: 'Aap Ke Recent Transactions Mein Abhi Tak Koi Fixed Amount Ki Recurring Payment Nahi Mili.' },

  // Wallet
  wallet_title: { en: 'Wallet', ur: 'بٹوہ', roman: 'Wallet' },
  wallet_subtitle: { en: 'All your bank accounts and cards, linked in one place.', ur: 'آپ کے تمام بینک اکاؤنٹس اور کارڈز ایک جگہ منسلک۔', roman: 'Aap Ke Tamam Bank Accounts Aur Cards Aik Jagah Link.' },
  wallet_net_worth: { en: 'Net Worth', ur: 'خالص مالیت', roman: 'Net Worth' },
  wallet_finbud_balance: { en: 'FinBud Balance', ur: 'فن بڈ بیلنس', roman: 'FinBud Balance' },
  wallet_linked_accounts: { en: 'Linked Accounts', ur: 'منسلک اکاؤنٹس', roman: 'Linked Accounts' },
  wallet_other_assets: { en: 'Other Assets', ur: 'دیگر اثاثے', roman: 'Doosray Assets' },
  wallet_edit: { en: 'Edit', ur: 'ترمیم کریں', roman: 'Edit Karein' },
  wallet_total_net_worth: { en: 'Total Net Worth', ur: 'کل خالص مالیت', roman: 'Total Net Worth' },
  wallet_link_note: { en: 'Link a bank account below to have its balance count toward your net worth automatically.', ur: 'نیچے بینک اکاؤنٹ منسلک کریں تاکہ اس کا بیلنس خودکار طور پر آپ کی خالص مالیت میں شمار ہو۔', roman: 'Neeche Bank Account Link Karein Taake Uska Balance Automatically Aap Ke Net Worth Mein Shamil Ho.' },
  wallet_linked_bank_accounts: { en: 'Linked Bank Accounts', ur: 'منسلک بینک اکاؤنٹس', roman: 'Linked Bank Accounts' },
  wallet_link_account: { en: '+ Link Account', ur: '+ اکاؤنٹ منسلک کریں', roman: '+ Account Link Karein' },
  wallet_no_banks: { en: 'No bank accounts linked yet. Link an HBL, Meezan, or any other Pakistani bank account to see its balance alongside your FinBud balance.', ur: 'ابھی تک کوئی بینک اکاؤنٹ منسلک نہیں۔ اپنا بینک اکاؤنٹ منسلک کریں۔', roman: 'Abhi Tak Koi Bank Account Link Nahi. Apna Bank Account Link Karein.' },
  wallet_my_cards: { en: 'My Cards', ur: 'میرے کارڈز', roman: 'Mere Cards' },
  wallet_add_card: { en: '+ Add Card', ur: '+ کارڈ شامل کریں', roman: '+ Card Add Karein' },
  wallet_no_cards: { en: 'No cards on file yet. Add a card to enable the Emergency lock feature and start building your wallet.', ur: 'ابھی تک کوئی کارڈ محفوظ نہیں۔ ایمرجنسی لاک فیچر کے لیے کارڈ شامل کریں۔', roman: 'Abhi Tak Koi Card Save Nahi. Emergency Lock Feature Ke Liye Card Add Karein.' },
  wallet_how_this_works: { en: 'How This Works', ur: 'یہ کیسے کام کرتا ہے', roman: 'Yeh Kaise Kaam Karta Hai' },

  // Send Money
  send_money_title: { en: 'Send Money', ur: 'رقم بھیجیں', roman: 'Paise Bhejein' },
  recipient_name: { en: 'Recipient Name', ur: 'وصول کنندہ کا نام', roman: 'Recipient Ka Naam' },
  transfer_method: { en: 'Transfer Method', ur: 'منتقلی کا طریقہ', roman: 'Transfer Method' },
  destination_bank: { en: 'Destination Bank', ur: 'منزل بینک', roman: 'Destination Bank' },
  select_bank: { en: 'Select bank...', ur: 'بینک منتخب کریں...', roman: 'Bank Select Karein...' },
  amount_pkr: { en: 'Amount (PKR)', ur: 'رقم (PKR)', roman: 'Amount (PKR)' },
  purpose: { en: 'Purpose', ur: 'مقصد', roman: 'Purpose' },
  description_optional: { en: 'Description', ur: 'تفصیل', roman: 'Tafseel' },
  optional: { en: '(optional)', ur: '(اختیاری)', roman: '(Optional)' },
  btn_continue: { en: 'CONTINUE', ur: 'جاری رکھیں', roman: 'Continue Karein' },
  confirm_transfer_title: { en: 'Confirm Transfer', ur: 'منتقلی کی تصدیق کریں', roman: 'Transfer Confirm Karein' },
  recipient: { en: 'Recipient', ur: 'وصول کنندہ', roman: 'Recipient' },
  bank: { en: 'Bank', ur: 'بینک', roman: 'Bank' },
  amount: { en: 'Amount', ur: 'رقم', roman: 'Amount' },
  enter_password_confirm: { en: 'Enter your password to confirm', ur: 'تصدیق کے لیے اپنا پاس ورڈ درج کریں', roman: 'Confirm Karne Ke Liye Apna Password Likhein' },
  btn_confirm_send: { en: 'CONFIRM & SEND', ur: 'تصدیق کریں اور بھیجیں', roman: 'Confirm Karke Bhejein' },
  tx_successful: { en: 'Transaction Successful!', ur: 'لین دین کامیاب!', roman: 'Transaction Kamyab!' },
  btn_download_pdf: { en: 'DOWNLOAD PDF', ur: 'پی ڈی ایف ڈاؤن لوڈ کریں', roman: 'PDF Download Karein' },
  btn_done: { en: 'DONE', ur: 'ہو گیا', roman: 'Ho Gaya' },

  // Pay Bill
  pay_bill_title: { en: 'Pay Bill', ur: 'بل ادا کریں', roman: 'Bill Pay Karein' },
  biller: { en: 'Biller', ur: 'بل دینے والا', roman: 'Biller' },
  select_biller: { en: 'Select biller...', ur: 'بل دینے والا منتخب کریں...', roman: 'Biller Select Karein...' },
  consumer_number: { en: 'Consumer Number', ur: 'کنزیومر نمبر', roman: 'Consumer Number' },
  confirm_payment_title: { en: 'Confirm Payment', ur: 'ادائیگی کی تصدیق کریں', roman: 'Payment Confirm Karein' },
  btn_confirm_pay: { en: 'CONFIRM & PAY', ur: 'تصدیق کریں اور ادا کریں', roman: 'Confirm Karke Pay Karein' },

  // Rewards / Redeem / TopUp
  rewards_title: { en: 'FinBud Rewards Program', ur: 'فن بڈ ریوارڈز پروگرام', roman: 'FinBud Rewards Program' },
  current_points: { en: 'Current Points', ur: 'موجودہ پوائنٹس', roman: 'Current Points' },
  available_points: { en: 'Available Points', ur: 'دستیاب پوائنٹس', roman: 'Available Points' },
  btn_got_it: { en: 'GOT IT', ur: 'سمجھ گیا', roman: 'Samajh Gaya' },
  redeem_points_title: { en: 'Redeem Points', ur: 'پوائنٹس ریڈیم کریں', roman: 'Points Redeem Karein' },
  value: { en: 'Value', ur: 'قیمت', roman: 'Value' },
  btn_redeem: { en: 'REDEEM', ur: 'ریڈیم کریں', roman: 'Redeem Karein' },
  btn_close: { en: 'CLOSE', ur: 'بند کریں', roman: 'Band Karein' },
  choose_product_title: { en: 'Choose a Product', ur: 'ایک پروڈکٹ منتخب کریں', roman: 'Aik Product Chunein' },
  btn_confirm: { en: 'CONFIRM', ur: 'تصدیق کریں', roman: 'Confirm Karein' },
  btn_back: { en: 'BACK', ur: 'واپس', roman: 'Wapas' },
  topup_title: { en: 'Top Up Balance (Demo)', ur: 'بیلنس ٹاپ اپ کریں (ڈیمو)', roman: 'Balance Top Up Karein (Demo)' },
  topup_note: { en: 'For demonstration and testing purposes only.', ur: 'صرف مظاہرے اور ٹیسٹنگ کے مقاصد کے لیے۔', roman: 'Sirf Demo Aur Testing Ke Liye.' },
  btn_add_funds: { en: 'ADD FUNDS', ur: 'رقم شامل کریں', roman: 'Funds Add Karein' },
  transfer_successful: { en: 'Transfer Successful!', ur: 'منتقلی کامیاب!', roman: 'Transfer Kamyab!' },
  processing: { en: 'Processing...', ur: 'کارروائی جاری ہے...', roman: 'Processing...' },
  send_via_finbud: { en: 'FinBud Transfer', ur: 'فن بڈ ٹرانسفر', roman: 'FinBud Transfer' },
  send_via_bank: { en: 'Bank Transfer', ur: 'بینک ٹرانسفر', roman: 'Bank Transfer' },
  send_via_finbud_sub: { en: 'Send instantly to another FinBud user — free', ur: 'کسی دوسرے فن بڈ صارف کو فوری بھیجیں — مفت', roman: 'Kisi Doosray FinBud User Ko Foran Bhejein — Free' },
  send_via_bank_sub: { en: 'Send to any Pakistani bank account via 1LINK', ur: '1LINK کے ذریعے کسی بھی بینک اکاؤنٹ میں بھیجیں', roman: '1LINK Ke Zariye Kisi Bhi Bank Account Mein Bhejein' },
  phone_number: { en: 'Phone Number', ur: 'فون نمبر', roman: 'Phone Number' },
  bank_name: { en: 'Bank Name', ur: 'بینک کا نام', roman: 'Bank Ka Naam' },
  iban_account_no: { en: 'IBAN / Account No.', ur: 'آئی بی اے این / اکاؤنٹ نمبر', roman: 'IBAN / Account No.' },
  transferring_to: { en: 'Transferring to', ur: 'منتقل کیا جا رہا ہے', roman: 'Transfer Kiya Ja Raha Hai' },
  btn_verify: { en: 'VERIFY', ur: 'تصدیق کریں', roman: 'Tasdeeq Karein' },
  recipient_not_found: { en: 'No FinBud account exists for that phone number.', ur: 'اس فون نمبر کے لیے کوئی فن بڈ اکاؤنٹ موجود نہیں۔', roman: 'Is Phone Number Ke Liye Koi FinBud Account Mojood Nahi.' },
  fee: { en: 'Fee', ur: 'فیس', roman: 'Fee' },
  total_deducted: { en: 'Total Deducted', ur: 'کل کٹوتی', roman: 'Total Katouti' },
  enter_pin_title: { en: 'Enter your 5-digit PIN', ur: 'اپنا 5 ہندسوں کا پن درج کریں', roman: 'Apna 5-Digit PIN Likhein' },
  btn_verify_send: { en: 'VERIFY & SEND', ur: 'تصدیق کریں اور بھیجیں', roman: 'Tasdeeq Karke Bhejein' },
  wrong_pin: { en: 'Incorrect PIN. Please try again.', ur: 'غلط پن۔ دوبارہ کوشش کریں۔', roman: 'Ghalat PIN. Dobara Koshish Karein.' },
  btn_back: { en: 'BACK', ur: 'واپس', roman: 'Wapas' },
  bill_category: { en: 'Bill Category', ur: 'بل کی قسم', roman: 'Bill Category' },
  service_provider: { en: 'Service Provider', ur: 'سروس فراہم کنندہ', roman: 'Service Provider' },
  bill_reference: { en: 'Bill Reference Number', ur: 'بل حوالہ نمبر', roman: 'Bill Reference Number' },
  reference_number: { en: 'Reference Number', ur: 'حوالہ نمبر', roman: 'Reference Number' },
  confirm_bill_payment: { en: 'Confirm Bill Payment', ur: 'بل کی ادائیگی کی تصدیق کریں', roman: 'Bill Payment Confirm Karein' },
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [userData, setUserData] = useState({ name: 'User', initials: 'U', balance: 0, isMasked: true, userId: '', points: 0 })
  const [transactions, setTransactions] = useState([])
  const [reminders, setReminders] = useState([])
  const [breakdown, setBreakdown] = useState({})
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [remindersOpen, setRemindersOpen] = useState(false)
  const [modal, setModal] = useState(null)
  const [pendingTransfer, setPendingTransfer] = useState(null)
  const [pendingBill, setPendingBill] = useState(null)
  const [openMenuId, setOpenMenuId] = useState(null)
  const [hasCard, setHasCard] = useState(false)
  const [expenseCategories, setExpenseCategories] = useState(FALLBACK_EXPENSE_CATEGORIES)
  const [activeView, setActiveView] = useState('home')
  const [advisor, setAdvisor] = useState({
    loaded: false,
    summary: null,
    summaryAvailable: true,
    incomeBreakdown: {},
    incomeAvailable: true,
    monthlyTrend: [],
    trendAvailable: true,
    utilityUsage: null,
    utilityAvailable: true,
    subscriptions: [],
    creditScore: null,
    creditScoreAvailable: true,
    anomalies: [],
    anomaliesAvailable: true
  })
  const [wallet, setWallet] = useState({
    loaded: false,
    cards: [],
    linkedBanks: [],
    linkedBanksAvailable: true,
    otherAssets: 0,
    otherAssetsAvailable: true
  })
  const printRef = useRef(null)

  // ── MOBILE DETECTION ─────────────────────────────────────
  // Drives which shell renders (MobileShell vs the existing desktop
  // app-shell) — a real structural swap, not a CSS reflow of the same
  // markup. matchMedia + a resize listener keeps it live if the window
  // is resized or the device is rotated, without a page reload.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const handler = e => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // ── LANGUAGE ──────────────────────────────────────────────
  // 'en' | 'ur' (Urdu script) | 'roman' (Roman Urdu). Only static UI text
  // is translated — user-typed input, names, and transaction data always
  // stay as entered/received.
  const [language, setLanguage] = useState('en')
  const [langMenuOpen, setLangMenuOpen] = useState(false)
  function t(key) {
    return TRANSLATIONS[key]?.[language] ?? TRANSLATIONS[key]?.en ?? key
  }

  // ── ACCESSIBILITY (Module F) ────────────────────────────
  // Text size, high contrast, and simple mode are read from localStorage on
  // load and applied as data-attributes on <html>, so a plain CSS override
  // layer (bottom of the <style> block below) can restyle the app instantly
  // — no reload, no backend call. Preferences persist across sessions and
  // across routes (Chat.jsx reads the same keys).
  const [fontSize, setFontSize] = useState(() => localStorage.getItem('finbud_font_size') || 'default')
  const [highContrast, setHighContrast] = useState(() => localStorage.getItem('finbud_high_contrast') === 'true')
  const [simpleMode, setSimpleMode] = useState(() => localStorage.getItem('finbud_simple_mode') === 'true')

  useEffect(() => {
    document.documentElement.setAttribute('data-font-size', fontSize)
    localStorage.setItem('finbud_font_size', fontSize)
  }, [fontSize])

  useEffect(() => {
    document.documentElement.setAttribute('data-contrast', highContrast ? 'high' : 'default')
    localStorage.setItem('finbud_high_contrast', String(highContrast))
  }, [highContrast])

  useEffect(() => {
    document.documentElement.setAttribute('data-simple-mode', String(simpleMode))
    localStorage.setItem('finbud_simple_mode', String(simpleMode))
  }, [simpleMode])

  // Reads the numbers out loud in plain language — for visually impaired,
  // low-literacy, or elderly users. Browser-native, no backend needed.
  function speak(text) {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'en-US'
    window.speechSynthesis.speak(utterance)
  }

  // ── IN-APP TRANSACTION NOTIFICATIONS ────────────────────
  // Two pieces: a transient toast right after any money-moving action
  // completes, and a persistent "Activity" dropdown beside the bill
  // reminders bell that lists recent transactions (reuses the same data
  // already fetched for the Home page transaction table).
  const [toast, setToast] = useState(null)
  const toastTimerRef = useRef(null)
  function showToast(message, type = 'success') {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ message, type })
    toastTimerRef.current = setTimeout(() => setToast(null), 4500)
  }
  const [txNotifOpen, setTxNotifOpen] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [notifUnreadCount, setNotifUnreadCount] = useState(0)

  const seenNotifIdsRef = useRef(new Set())
  async function loadNotifications() {
    try {
      const res = await fetch('/api/notifications?limit=20', { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        const list = data.notifications || []
        // Toast any notification we haven't shown yet (e.g. money arriving
        // from someone else while this tab is open) — first load just
        // records what's already there instead of toasting the whole feed.
        const isFirstLoad = seenNotifIdsRef.current.size === 0
        list.forEach(n => {
          if (!seenNotifIdsRef.current.has(n.id)) {
            seenNotifIdsRef.current.add(n.id)
            if (!isFirstLoad && !n.is_read) showToast(n.message, 'success')
          }
        })
        setNotifications(list)
        setNotifUnreadCount(list.filter(n => !n.is_read).length)
      }
    } catch {}
  }

  async function openNotifications() {
    setTxNotifOpen(o => !o)
    if (!txNotifOpen && notifUnreadCount > 0) {
      try {
        await fetch('/api/notifications/mark-read', { method: 'POST', credentials: 'include' })
        setNotifUnreadCount(0)
      } catch {}
    }
  }

  useEffect(() => { loadAll() }, [])

  // ── LIVE UPDATES ──────────────────────────────────────────
  // The backend already writes both legs of a FinBud→FinBud transfer the
  // instant it happens (sender AND recipient balance/transactions/
  // notifications are all updated server-side in the same request — see
  // /api/transfer/execute in app.py). But the recipient's browser has no
  // way to know that happened until it asks. Previously we only re-fetched
  // after actions the logged-in user themselves performed, so a recipient
  // sitting on their dashboard in another tab/session would see nothing
  // move until they hit refresh. Polling closes that gap; a WebSocket/SSE
  // push would be nicer but this needs no new backend infrastructure.
  //
  // IMPORTANT: every modal's step content (SendMoneyStep2, PayBillStep3,
  // etc.) is a function defined inside this component's body, so it gets
  // a brand-new function identity every time Dashboard re-renders. Any
  // background setState here — even one field like userData.balance —
  // forces Dashboard to re-render, which makes React treat the currently
  // open modal's step as a "new" component and remount it, wiping
  // whatever the person was typing (this was the "fields keep getting
  // wiped mid-typing" bug). So the poll must stay completely silent while
  // a modal is open, and only catch up once it closes.
  const modalOpenRef = useRef(false)
  useEffect(() => { modalOpenRef.current = !!modal }, [modal])

  const prevModalRef = useRef(null)
  useEffect(() => {
    if (prevModalRef.current && !modal) {
      // Modal just closed — catch up on anything the poll skipped while
      // it was open (e.g. money that arrived mid-transfer-flow).
      refreshBalanceOnly(); loadNotifications(); loadTransactions()
    }
    prevModalRef.current = modal
  }, [modal])

  async function refreshBalanceOnly() {
    try {
      const res = await fetch('/api/user/data', { credentials: 'include' })
      if (!res.ok) return
      const user = await res.json()
      setUserData(u => (u.balance === user.balance && u.points === user.points)
        ? u
        : { ...u, balance: user.balance, points: user.points })
    } catch {}
  }

  useEffect(() => {
    const POLL_MS = 8000
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      if (modalOpenRef.current) return   // never refresh mid-input — see note above
      refreshBalanceOnly()
      loadNotifications()
      loadTransactions()
    }
    const id = setInterval(tick, POLL_MS)
    const onFocus = () => tick()
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    if (activeView === 'advisor' && !advisor.loaded) loadAdvisorData()
  }, [activeView, advisor.loaded])

  useEffect(() => {
    if (activeView === 'wallet' && !wallet.loaded) loadWalletData()
  }, [activeView, wallet.loaded])

  async function loadAll() {
    try {
      const res = await fetch('/api/user/data', { credentials: 'include' })
      if (!res.ok) { navigate('/'); return }
      const user = await res.json()
      const parts = user.name.trim().split(' ')
      const initials = parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : user.name.slice(0,2).toUpperCase()
      setUserData({ name: user.name, initials, balance: user.balance, isMasked: true, userId: user.userId, points: user.points })
      loadTransactions()
      loadReminders()
      loadBreakdown()
      checkCard()
      loadCategories()
      loadNotifications()
    } catch { navigate('/') }
  }

  async function checkCard() {
    try {
      const res = await fetch('/api/cards/check', { credentials: 'include' })
      const data = await res.json()
      setHasCard(!!data.has_card)
    } catch { setHasCard(false) }
  }

  async function loadCategories() {
    try {
      const res = await fetch('/api/transaction/categories', { credentials: 'include' })
      const data = await res.json()
      if (data.success && Array.isArray(data.categories) && data.categories.length > 0) {
        setExpenseCategories(data.categories)
      }
    } catch { /* keep FALLBACK_EXPENSE_CATEGORIES */ }
  }

  async function loadTransactions() {
    try {
      const res = await fetch('/api/transaction/history?limit=4', { credentials: 'include' })
      const data = await res.json()
      setTransactions(data.transactions || [])
    } catch {}
  }

  function loadReminders() {
    setReminders([
      { biller: 'K-Electric', amount: 3500, due_date: '2025-11-15', days_left: 3, kind: 'due_soon' },
      { biller: 'PTCL', amount: 1200, due_date: '2025-11-12', days_left: 0, kind: 'due_today' }
    ])
  }

  async function loadBreakdown() {
    try {
      // Anum's backend now aggregates this server-side from the real
      // `category` column on dashboard_transactions (see
      // /api/financial/spending-by-category), so this reflects whatever
      // category a bill or a categorized transfer was actually saved under.
      const res = await fetch('/api/financial/spending-by-category', { credentials: 'include' })
      const data = await res.json()
      if (data.success) setBreakdown(data.breakdown || {})
    } catch {}
  }

  async function loadAdvisorData() {
    // These three endpoints are not built yet — Anum's backend handoff doc
    // (shared alongside this file) specs them out. Until they exist, each
    // section below falls back to a friendly "coming soon" state instead
    // of breaking, the same pattern already used for topup/email-receipt.
    const [summaryRes, incomeRes, trendRes, utilityRes, creditRes, anomalyRes] = await Promise.allSettled([
      fetch('/api/financial/income-vs-expense', { credentials: 'include' }),
      fetch('/api/financial/income-by-source', { credentials: 'include' }),
      fetch('/api/financial/monthly-trend', { credentials: 'include' }),
      fetch('/api/financial/utility-usage', { credentials: 'include' }),
      fetch('/api/credit-score', { credentials: 'include' }),
      fetch(' /insights/anomalies' , { credentials: 'include' })
    ])

    let summary = null, summaryAvailable = false
    if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
      try {
        const d = await summaryRes.value.json()
        if (d.success) { summary = d; summaryAvailable = true }
      } catch {}
    }

    let incomeBreakdown = {}, incomeAvailable = false
    if (incomeRes.status === 'fulfilled' && incomeRes.value.ok) {
      try {
        const d = await incomeRes.value.json()
        if (d.success) { incomeBreakdown = d.income_by_source || {}; incomeAvailable = true }
      } catch {}
    }

    let monthlyTrend = [], trendAvailable = false
    if (trendRes.status === 'fulfilled' && trendRes.value.ok) {
      try {
        const d = await trendRes.value.json()
        if (d.success) {
          // Belt-and-suspenders: sort by actual calendar order using the
          // "Mon YY" label, not whatever order the backend sent — a plain
          // string sort of month names is NOT chronological (e.g. "Apr"
          // would sort before "Jan"), so parse each label properly.
          const MONTH_INDEX = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 }
          monthlyTrend = [...(d.trend || [])].sort((a, b) => {
            const [am, ay] = (a.month || '').split(' ')
            const [bm, by] = (b.month || '').split(' ')
            const aKey = Number(ay) * 12 + (MONTH_INDEX[am] ?? 0)
            const bKey = Number(by) * 12 + (MONTH_INDEX[bm] ?? 0)
            return aKey - bKey
          })
          // Keep only the most recent 5 months (chronological sort above
          // means "most recent" is the tail of the array), rather than
          // whatever slice of months the backend happened to send first.
          monthlyTrend = monthlyTrend.slice(-5)
          trendAvailable = true
        }
      } catch {}
    }

    let utilityUsage = null, utilityAvailable = false
    if (utilityRes.status === 'fulfilled' && utilityRes.value.ok) {
      try {
        const d = await utilityRes.value.json()
        if (d.success) { utilityUsage = d.usage || null; utilityAvailable = true }
      } catch {}
    }

    let subscriptions = []
    try {
      const txRes = await fetch('/api/transaction/history?limit=100', { credentials: 'include' })
      if (txRes.ok) {
        const txData = await txRes.json()
        if (txData.success) subscriptions = detectSubscriptions(txData.transactions || [])
      }
    } catch {}

    let creditScore = null, creditScoreAvailable = false
    if (creditRes.status === 'fulfilled' && creditRes.value.ok) {
      try {
        const d = await creditRes.value.json()
        if (d.success) { creditScore = d; creditScoreAvailable = true }
      } catch {}
    }

    let anomalies = [], anomaliesAvailable = false
    if (anomalyRes.status === 'fulfilled' && anomalyRes.value.ok) {
      try {
        const d = await anomalyRes.value.json()
        if (Array.isArray(d.anomalies)) { anomalies = d.anomalies; anomaliesAvailable = true }
      } catch {}
    }

    setAdvisor({ loaded: true, summary, summaryAvailable, incomeBreakdown, incomeAvailable, monthlyTrend, trendAvailable, utilityUsage, utilityAvailable, subscriptions, creditScore, creditScoreAvailable, anomalies, anomaliesAvailable })
  }

  async function loadWalletData() {
    // /api/cards/list already exists in the backend (used for the Emergency
    // gate) so cards populate for real today. /api/wallet/bank-accounts does
    // not exist yet — falls back to an empty "no accounts linked" state.
    let cards = []
    try {
      const cRes = await fetch('/api/cards/list', { credentials: 'include' })
      if (cRes.ok) {
        const cData = await cRes.json()
        if (cData.success) cards = cData.cards || []
      }
    } catch {}

    let linkedBanks = [], linkedBanksAvailable = false
    try {
      const bRes = await fetch('/api/wallet/bank-accounts', { credentials: 'include' })
      if (bRes.ok) {
        const bData = await bRes.json()
        if (bData.success) { linkedBanks = bData.accounts || []; linkedBanksAvailable = true }
      }
    } catch {}

    let otherAssets = 0, otherAssetsAvailable = false
    try {
      const aRes = await fetch('/api/wallet/other-assets', { credentials: 'include' })
      if (aRes.ok) {
        const aData = await aRes.json()
        if (aData.success) { otherAssets = aData.amount || 0; otherAssetsAvailable = true }
      }
    } catch {}

    setWallet({ loaded: true, cards, linkedBanks, linkedBanksAvailable, otherAssets, otherAssetsAvailable })
  }

  async function getDailyLimitUsage() {
    try {
      const res = await fetch('/api/transaction/history?limit=50', { credentials: 'include' })
      const data = await res.json()
      const todayStr = new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
      let used = 0
      ;(data.transactions || []).forEach(tx => { if (tx.date === todayStr && tx.amount < 0) used += Math.abs(tx.amount) })
      return { used, remaining: Math.max(DAILY_TRANSFER_LIMIT - used, 0) }
    } catch { return { used: 0, remaining: DAILY_TRANSFER_LIMIT } }
  }

  async function handleLogout() {
    setSidebarOpen(false)
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } finally { navigate('/') }
  }

  async function downloadReceipt(txId) {
    if (!txId) { setModal({ type: 'alert', title: 'Receipt Unavailable', message: 'This transaction is missing an ID.', color: 'var(--danger)' }); return }
    try {
      const res = await fetch(`/api/transaction/${txId}/receipt`, { credentials: 'include' })
      const data = await res.json()
      if (!data.success) { setModal({ type: 'alert', title: 'Error', message: data.message, color: 'var(--danger)' }); return }
      renderPrint(data.receipt)
      setTimeout(() => window.print(), 300)
    } catch { setModal({ type: 'alert', title: 'Error', message: 'Could not fetch receipt.', color: 'var(--danger)' }) }
  }

  function printTransactionHistory(startDate, endDate) {
    const inRange = transactions.filter(tx => tx.date >= startDate && tx.date <= endDate)
    if (!printRef.current) return
    const rowsHtml = inRange.length === 0
      ? `<div class="r-row"><span>No transactions in this range</span></div>`
      : inRange.map(tx => `
          <div class="r-row">
            <span>${tx.date} — ${getTransactionDisplayLabel(tx)}</span>
            <strong style="color:${tx.amount < 0 ? '#c0392b' : '#1b8a4c'}">${tx.amount < 0 ? '-' : ''}PKR ${Math.abs(tx.amount).toLocaleString('en-PK')}</strong>
          </div>`).join('')
    printRef.current.innerHTML = `
      <div class="r-header"><h2>FinBud AI — Transaction History</h2><p>${startDate} to ${endDate}</p></div>
      ${rowsHtml}
    `
    setTimeout(() => window.print(), 300)
  }

  function renderPrint(receipt) {
    if (!printRef.current) return
    const amt = Math.abs(receipt.amount).toLocaleString('en-PK')
    printRef.current.innerHTML = `
      <div class="r-header"><h2>FinBud AI — Transaction Receipt</h2><p>${receipt.date} • ${receipt.time}</p></div>
      <div class="r-row"><span>Transaction ID</span><strong>#${receipt.transaction_id}</strong></div>
      <div class="r-row"><span>Account</span><strong>${receipt.account_number}</strong></div>
      <div class="r-row"><span>Type</span><strong>${receipt.transaction_type}</strong></div>
      <div class="r-row"><span>Description</span><strong>${receipt.description}</strong></div>
      ${receipt.recipient ? `<div class="r-row"><span>Recipient</span><strong>${receipt.recipient}</strong></div>` : ''}
      ${receipt.biller ? `<div class="r-row"><span>Biller</span><strong>${receipt.biller}</strong></div>` : ''}
      <div class="r-row"><span>Amount</span><strong>PKR ${amt}</strong></div>
      <div class="r-row"><span>Status</span><strong>${receipt.status}</strong></div>
    `
  }

  async function emailReceipt(txId) {
    try {
      const res = await fetch(`/api/transaction/${txId}/email-receipt`, { method: 'POST', credentials: 'include' })
      if (res.status === 404) { setModal({ type: 'alert', title: 'Coming Soon', message: 'Email receipts are part of Phase 2. Download the PDF for now.', color: 'var(--primary-purple)' }); return }
      const data = await res.json()
      if (data.success) setModal({ type: 'alert', title: 'Receipt Sent', message: 'Receipt emailed to your registered address!', color: 'var(--income)' })
      else setModal({ type: 'alert', title: 'Error', message: data.message, color: 'var(--danger)' })
    } catch { setModal({ type: 'alert', title: 'Coming Soon', message: 'Email receipts are part of Phase 2. Download the PDF for now.', color: 'var(--primary-purple)' }) }
  }

  // ── MODALS ──────────────────────────────────────────────

  // Local mirror of the backend's fee schedule (app.py: _calc_transfer_fee),
  // used only to preview the fee on Modal 2/3 before the server confirms it.
  function estimateTransferFee(amount, method) {
    if (method === 'finbud') return 0
    return amount < 10000 ? 25 : Math.round(amount * 0.0015 * 100) / 100
  }

  // ── Modal 1: Method selection — FinBud Transfer or Bank Transfer ──────────
  function SendMoneyStep1() {
    function choose(method) {
      setPendingTransfer({ method })
      setModal({ type: 'sendMoney2' })
    }
    return (
      <div>
        <h3>{t('send_money_title')}</h3>
        {stepDots(1, 6)}
        <OptionGrid
          selected={pendingTransfer?.method}
          onSelect={choose}
          options={[
            { key: 'finbud', icon: 'fa-user', label: t('send_via_finbud') },
            { key: 'bank',   icon: 'fa-landmark', label: t('send_via_bank') },
          ]}
        />
      </div>
    )
  }

  // ── Modal 2: Recipient details — phone (FinBud) or bank + IBAN/account (Bank) ──
  function SendMoneyStep2() {
    const method = pendingTransfer?.method
    const [phone, setPhone] = useState('')
    const [bankName, setBankName] = useState('')
    const [idType, setIdType] = useState('iban')   // 'iban' | 'account_number'
    const [accountId, setAccountId] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    // IBAN and a plain account number are different things with different
    // shapes — 24-char alphanumeric IBAN vs a shorter numeric account
    // number — so each gets its own input handling and its own criteria.
    function handleIdChange(v) {
      if (idType === 'iban') setAccountId(v.toUpperCase().replace(/\s/g, '').slice(0, 24))
      else setAccountId(v.replace(/\D/g, '').slice(0, 16))
    }

    async function handleSubmit(e) {
      e.preventDefault()
      setError('')

      if (method === 'finbud') {
        if (!phone.trim()) { setError('Please enter a phone number.'); return }
        setLoading(true)
        try {
          const res = await fetch(`/api/transfer/finbud/lookup?phone=${encodeURIComponent(phone.trim())}`, { credentials: 'include' })
          const data = await res.json()
          if (!data.success) { setError(data.message || t('recipient_not_found')); setLoading(false); return }
          setPendingTransfer(pt => ({ ...pt, phone: phone.trim(), recipientName: data.name, recipientAccount: data.account_number }))
          setModal({ type: 'sendMoney3' })
        } catch { setError('Server error. Please try again.') }
        setLoading(false)
      } else {
        if (!bankName) { setError('Please select a bank.'); return }
        if (idType === 'iban' && accountId.length !== 24) { setError('IBAN must be exactly 24 characters, starting with PK.'); return }
        if (idType === 'account_number' && (accountId.length < 8 || accountId.length > 16)) { setError('Account number must be 8–16 digits.'); return }
        setPendingTransfer(pt => ({ ...pt, bankName, identifierType: idType, accountId, recipientName: bankName }))
        setModal({ type: 'sendMoney3' })
      }
    }

    return (
      <div>
        <h3>{method === 'finbud' ? t('send_via_finbud') : t('send_via_bank')}</h3>
        {stepDots(2, 6)}
        <form onSubmit={handleSubmit}>
          {method === 'finbud' ? (
            <>
              <label>{t('phone_number')}</label>
              <input type="tel" required autoFocus placeholder="e.g., 03001234567" value={phone}
                onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))} />
            </>
          ) : (
            <>
              <label>{t('bank_name')}</label>
              <select value={bankName} onChange={e => setBankName(e.target.value)} required>
                <option value="">{t('select_bank')}</option>
                {PAKISTAN_BANKS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>

              <label>Identifier type</label>
              <div className="identifier-type-toggle">
                <button type="button" className={idType === 'iban' ? 'active' : ''}
                  onClick={() => { setIdType('iban'); setAccountId('') }}>IBAN</button>
                <button type="button" className={idType === 'account_number' ? 'active' : ''}
                  onClick={() => { setIdType('account_number'); setAccountId('') }}>Account Number</button>
              </div>

              {idType === 'iban' ? (
                <>
                  <label>IBAN</label>
                  <input type="text" required placeholder="e.g., PK36SCBL0000001123456702" value={accountId}
                    maxLength={24} onChange={e => handleIdChange(e.target.value)} />
                  <div className="bank-detect-note">{accountId.length}/24 characters — must start with PK</div>
                </>
              ) : (
                <>
                  <label>Account Number</label>
                  <input type="text" inputMode="numeric" required placeholder="e.g., 001234567890" value={accountId}
                    maxLength={16} onChange={e => handleIdChange(e.target.value)} />
                  <div className="bank-detect-note">{accountId.length} digits (8–16 required) — numbers only</div>
                </>
              )}
            </>
          )}
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary" disabled={loading}>
            {loading ? t('processing') : t('btn_continue')}
          </button>
          <button type="button" className="modal-btn-secondary" onClick={() => setModal({ type: 'sendMoney1' })}>{t('btn_back')}</button>
        </form>
      </div>
    )
  }

  // ── Modal 3: Amount ─────────────────────────────────────────────────────────
  function SendMoneyStep3() {
    const [amount, setAmount] = useState('')
    const [error, setError] = useState('')
    const [usage, setUsage] = useState({ remaining: DAILY_TRANSFER_LIMIT })

    useEffect(() => { getDailyLimitUsage().then(setUsage) }, [])

    function handleSubmit(e) {
      e.preventDefault()
      const amt = parseFloat(amount)
      if (isNaN(amt) || amt <= 0) { setError('Please enter a valid positive amount.'); return }
      if (amt > usage.remaining) { setError(`Exceeds your remaining daily limit of PKR ${usage.remaining.toLocaleString('en-PK')}.`); return }
      const fee = estimateTransferFee(amt, pendingTransfer.method)
      setPendingTransfer(pt => ({ ...pt, amount: amt, fee, totalDeducted: Math.round((amt + fee) * 100) / 100 }))
      setModal({ type: 'sendMoney4' })
    }

    return (
      <div>
        <h3>{t('send_money_title')}</h3>
        {stepDots(3, 6)}
        <div className="summary-box" style={{ marginBottom: 16 }}>
          <div className="summary-row"><span>{t('transferring_to')}</span><strong>{pendingTransfer?.recipientName}</strong></div>
          {pendingTransfer?.method === 'bank' && (
            <div className="summary-row"><span>{pendingTransfer.identifierType === 'iban' ? 'IBAN' : 'Account No.'}</span><strong>{pendingTransfer.accountId}</strong></div>
          )}
        </div>
        <form onSubmit={handleSubmit}>
          <label>{t('amount_pkr')}</label>
          <input type="number" required autoFocus min="1" step="0.01" placeholder="e.g., 5000" value={amount} onChange={e => setAmount(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary">{t('btn_continue')}</button>
          <button type="button" className="modal-btn-secondary" onClick={() => setModal({ type: 'sendMoney2' })}>{t('btn_back')}</button>
        </form>
      </div>
    )
  }

  // ── Modal 4: Transaction Summary ───────────────────────────────────────────
  function SendMoneyStep4() {
    return (
      <div>
        <h3>{t('confirm_transfer_title')}</h3>
        {stepDots(4, 6)}
        <div className="summary-box">
          <div className="summary-row"><span>{t('recipient')}</span><strong>{pendingTransfer?.recipientName}</strong></div>
          {pendingTransfer?.method === 'bank' && (
            <>
              <div className="summary-row"><span>{t('bank')}</span><strong>{pendingTransfer.bankName}</strong></div>
              <div className="summary-row"><span>{pendingTransfer.identifierType === 'iban' ? 'IBAN' : 'Account No.'}</span><strong>{pendingTransfer.accountId}</strong></div>
            </>
          )}
          {pendingTransfer?.method === 'finbud' && (
            <div className="summary-row"><span>{t('phone_number')}</span><strong>{pendingTransfer.phone}</strong></div>
          )}
          <div className="summary-row"><span>{t('amount')}</span><strong>PKR {pendingTransfer?.amount?.toLocaleString('en-PK')}</strong></div>
          <div className="summary-row"><span>{t('fee')}</span><strong>{pendingTransfer?.fee > 0 ? `PKR ${pendingTransfer.fee.toLocaleString('en-PK')}` : 'Free'}</strong></div>
          <div className="summary-row"><span>{t('total_deducted')}</span><strong>PKR {pendingTransfer?.totalDeducted?.toLocaleString('en-PK')}</strong></div>
        </div>
        <button type="button" className="modal-btn-primary" onClick={() => setModal({ type: 'sendMoney5' })}>{t('btn_confirm')}</button>
        <button type="button" className="modal-btn-secondary" onClick={() => setModal({ type: 'sendMoney3' })}>{t('btn_back')}</button>
      </div>
    )
  }

  // ── Modal 5: Security Verification (5-digit PIN) ───────────────────────────
  function SendMoneyStep5() {
    const [digits, setDigits] = useState(['', '', '', '', ''])
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const inputRefs = useRef([])

    function handleDigitChange(idx, v) {
      const clean = v.replace(/\D/g, '').slice(-1)
      const next = [...digits]
      next[idx] = clean
      setDigits(next)
      if (clean && idx < 4) inputRefs.current[idx + 1]?.focus()
    }

    function handleKeyDown(idx, e) {
      if (e.key === 'Backspace' && !digits[idx] && idx > 0) inputRefs.current[idx - 1]?.focus()
    }

    async function handleSubmit(e) {
      e.preventDefault()
      const pin = digits.join('')
      if (pin.length !== 5) { setError('Please enter all 5 digits.'); return }
      setError(''); setLoading(true)
      try {
        const body = {
          method: pendingTransfer.method,
          amount: pendingTransfer.amount,
          pin,
          ...(pendingTransfer.method === 'finbud'
            ? { recipient_phone: pendingTransfer.phone }
            : { bank_name: pendingTransfer.bankName, identifier_type: pendingTransfer.identifierType, account_id: pendingTransfer.accountId })
        }
        const res = await fetch('/api/transfer/execute', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify(body)
        })
        const txData = await res.json()
        if (txData.success) {
          setUserData(u => ({ ...u, balance: txData.new_balance, points: txData.new_points }))
          loadTransactions(); loadBreakdown(); loadNotifications()
          const feeNote = txData.fee_applied ? ` (+ PKR ${txData.fee.toLocaleString('en-PK')} fee)` : ''
          showToast(`PKR ${pendingTransfer.amount.toLocaleString('en-PK')} sent to ${pendingTransfer.recipientName}${feeNote}`)
          setModal({ type: 'sendMoney6', txData })
        } else {
          setError(txData.message || t('wrong_pin'))
          setDigits(['', '', '', '', ''])
          inputRefs.current[0]?.focus()
        }
      } catch { setError('Server error. Please try again.') }
      setLoading(false)
    }

    return (
      <div>
        <h3>{t('enter_pin_title')}</h3>
        {stepDots(5, 6)}
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', margin: '20px 0' }}>
            {digits.map((d, idx) => (
              <input
                key={idx}
                ref={el => (inputRefs.current[idx] = el)}
                type="password"
                inputMode="numeric"
                maxLength={1}
                autoFocus={idx === 0}
                value={d}
                onChange={e => handleDigitChange(idx, e.target.value)}
                onKeyDown={e => handleKeyDown(idx, e)}
                style={{ width: 44, height: 52, textAlign: 'center', fontSize: 20, borderRadius: 8, border: '1px solid #d1d5db' }}
              />
            ))}
          </div>
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8, textAlign: 'center' }}>{error}</p>}
          <button type="submit" className="modal-btn-primary" disabled={loading}>{loading ? t('processing') : t('btn_verify_send')}</button>
          <button type="button" className="modal-btn-secondary" onClick={() => setModal({ type: 'sendMoney4' })}>{t('btn_back')}</button>
        </form>
      </div>
    )
  }

  // ── Modal 6: Success & Receipt ──────────────────────────────────────────────
  function SendMoneyStep6({ txData }) {
    const txId = txData?.transaction_id
    return (
      <div style={{ textAlign: 'center', padding: 10 }}>
        {stepDots(6, 6)}
        <div className="success-icon">✓</div>
        <h3 style={{ color: 'var(--income)', marginBottom: 15 }}>{t('transfer_successful')}</h3>
        <p style={{ fontSize: 16, marginBottom: 5 }}>PKR {pendingTransfer?.amount?.toLocaleString('en-PK')} sent to {pendingTransfer?.recipientName}</p>
        <p style={{ fontSize: 14, color: '#666', marginBottom: 10 }}>
          via {pendingTransfer?.method === 'finbud' ? t('send_via_finbud') : t('send_via_bank')}
        </p>
        {txData?.fee_applied && (
          <p style={{ fontSize: 13, color: 'var(--warning)', marginBottom: 10 }}>+ PKR {txData.fee?.toLocaleString('en-PK')} transfer fee — total deducted: PKR {(pendingTransfer.amount + txData.fee).toLocaleString('en-PK')}</p>
        )}
        <p style={{ fontSize: 14, color: 'var(--primary-purple)' }}>You earned {txData?.points_earned} reward points!</p>
        <div className="receipt-actions">
          <button className="modal-btn-primary" style={{ marginTop: 0 }} onClick={() => downloadReceipt(txId)}>{t('btn_download_pdf')}</button>
        </div>
        <button className="modal-btn-secondary" onClick={() => setModal(null)}>{t('btn_done')}</button>
      </div>
    )
  }

  // ── Modal 1: Bill category — icon boxes (Electricity, Gas, Internet...) ────
  // Keys must match the categories the backend's BILL_PROVIDERS dict knows
  // about (see /api/bills/providers in app.py).
  function PayBillStep1() {
    const categories = [
      { key: 'electricity', icon: CATEGORY_VISUALS.electricity.icon, color: CATEGORY_VISUALS.electricity.color, label: 'Electricity' },
      { key: 'gas', icon: CATEGORY_VISUALS.gas.icon, color: CATEGORY_VISUALS.gas.color, label: 'Gas' },
      { key: 'internet', icon: CATEGORY_VISUALS.internet.icon, color: CATEGORY_VISUALS.internet.color, label: 'Internet' },
    ]
    function choose(cat) {
      setPendingBill({ category: cat })
      setModal({ type: 'payBill2' })
    }
    return (
      <div>
        <h3>{t('pay_bill_title')}</h3>
        {stepDots(1, 6)}
        <OptionGrid selected={pendingBill?.category} onSelect={choose} options={categories} columns={3} compact />
      </div>
    )
  }

  // ── Modal 2: Service provider within the chosen category — icon boxes ─────
  function PayBillStep2() {
    const [providers, setProviders] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')

    useEffect(() => {
      let cancelled = false
      async function load() {
        setLoading(true); setError('')
        try {
          const res = await fetch(`/api/bills/providers?category=${encodeURIComponent(pendingBill.category)}`, { credentials: 'include' })
          if (res.status === 401) { setError('Your session has expired — please log in again.'); setLoading(false); return }
          const data = await res.json()
          if (!cancelled) {
            if (data.success && Array.isArray(data.providers) && data.providers.length > 0) setProviders(data.providers)
            else setError(data.message || 'Could not load providers for this category.')
          }
        } catch { if (!cancelled) setError('Could not reach the server. Check your connection and try again.') }
        if (!cancelled) setLoading(false)
      }
      load()
      return () => { cancelled = true }
    }, [])

    function choose(p) {
      setPendingBill(pb => ({ ...pb, biller: p }))
      setModal({ type: 'payBill3' })
    }

    return (
      <div>
        <h3>{t('service_provider')}</h3>
        {stepDots(2, 6)}
        {loading ? (
          <div className="option-grid-loading">Loading providers…</div>
        ) : error ? (
          <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>
        ) : (
          <OptionGrid variant="list" selected={pendingBill?.biller} onSelect={choose}
            options={providers.map(p => {
              const v = getBillerVisual(p, pendingBill?.category)
              return { key: p, icon: v.icon, color: v.color, label: p }
            })} />
        )}
        <button type="button" className="modal-btn-secondary" onClick={() => setModal({ type: 'payBill1' })}>{t('btn_back')}</button>
      </div>
    )
  }

  // ── Modal 3: Bill reference number ──────────────────────────────────────────
  function PayBillStep3({ inlineError }) {
    const [billId, setBillId] = useState(pendingBill?.billId || '')
    const [savedRef, setSavedRef] = useState(null)
    const [error, setError] = useState(inlineError || '')

    useEffect(() => {
      let cancelled = false
      async function checkSaved() {
        try {
          const res = await fetch(`/api/bills/saved-ref?provider=${encodeURIComponent(pendingBill.biller)}`, { credentials: 'include' })
          if (!res.ok) return
          const data = await res.json()
          if (!cancelled && data.success && data.has_saved_ref) setSavedRef(data.ref)
        } catch {
          // Non-critical — the saved-account prompt is a convenience, not a
          // required step, so a failure here shouldn't block bill entry.
        }
      }
      checkSaved()
      return () => { cancelled = true }
    }, [])

    function handleSubmit(e) {
      e.preventDefault()
      if (!billId.trim()) { setError('Please enter your bill reference number.'); return }
      setPendingBill(pb => ({ ...pb, billId: billId.trim() }))
      setModal({ type: 'payBill4' })
    }

    return (
      <div>
        <h3>{t('bill_reference')}</h3>
        {stepDots(3, 6)}
        <div className="summary-box" style={{ marginBottom: 16 }}>
          <div className="summary-row"><span>{t('biller')}</span><strong>{pendingBill?.biller}</strong></div>
        </div>
        <form onSubmit={handleSubmit}>
          {savedRef && (
            <div className="saved-account-prompt">
              Are you referring to your previously saved account <strong>{savedRef}</strong>?
              <div className="prompt-actions">
                <button type="button" className="yes-btn" onClick={() => setBillId(savedRef)}>Yes</button>
                <button type="button" className="no-btn" onClick={() => setSavedRef(null)}>No</button>
              </div>
            </div>
          )}
          <label>{t('bill_reference')}</label>
          <input type="text" required autoFocus placeholder="Enter reference number" value={billId} onChange={e => setBillId(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary">{t('btn_continue')}</button>
          <button type="button" className="modal-btn-secondary" onClick={() => setModal({ type: 'payBill2' })}>{t('btn_back')}</button>
        </form>
      </div>
    )
  }

  // ── Modal 4: Amount ─────────────────────────────────────────────────────────
  function PayBillStep4() {
    const [amount, setAmount] = useState(pendingBill?.amount || '')
    const [error, setError] = useState('')

    function handleSubmit(e) {
      e.preventDefault()
      const amt = parseFloat(amount)
      if (isNaN(amt) || amt <= 0) { setError('Please enter a valid positive amount.'); return }
      setPendingBill(pb => ({ ...pb, amount: amt }))
      setModal({ type: 'payBill5' })
    }

    return (
      <div>
        <h3>{t('amount_pkr')}</h3>
        {stepDots(4, 6)}
        <div className="summary-box" style={{ marginBottom: 16 }}>
          <div className="summary-row"><span>{t('biller')}</span><strong>{pendingBill?.biller}</strong></div>
          <div className="summary-row"><span>{t('reference_number')}</span><strong>{pendingBill?.billId}</strong></div>
        </div>
        <form onSubmit={handleSubmit}>
          <label>{t('amount_pkr')}</label>
          <input type="number" required autoFocus min="10" step="0.01" placeholder="e.g., 6200" value={amount} onChange={e => setAmount(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary">{t('btn_continue')}</button>
          <button type="button" className="modal-btn-secondary" onClick={() => setModal({ type: 'payBill3' })}>{t('btn_back')}</button>
        </form>
      </div>
    )
  }

  // ── Modal 5: Confirm & password ─────────────────────────────────────────────
  function PayBillStep5({ inlineError }) {
    const [digits, setDigits] = useState(['', '', '', '', ''])
    const [error, setError] = useState(inlineError || '')
    const [loading, setLoading] = useState(false)
    const inputRefs = useRef([])

    function handleDigitChange(idx, v) {
      const clean = v.replace(/\D/g, '').slice(-1)
      const next = [...digits]
      next[idx] = clean
      setDigits(next)
      if (clean && idx < 4) inputRefs.current[idx + 1]?.focus()
    }

    function handleKeyDown(idx, e) {
      if (e.key === 'Backspace' && !digits[idx] && idx > 0) inputRefs.current[idx - 1]?.focus()
    }

    async function handleSubmit(e) {
      e.preventDefault()
      const pin = digits.join('')
      if (pin.length !== 5) { setError('Please enter all 5 digits.'); return }
      setError(''); setLoading(true)
      try {
        const vRes = await fetch('/api/user/verify-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ password: pin }) })
        const vData = await vRes.json()
        if (!vData.success) {
          setError('Incorrect PIN. Please try again.')
          setDigits(['', '', '', '', ''])
          inputRefs.current[0]?.focus()
          setLoading(false)
          return
        }
        const txRes = await fetch('/api/transaction/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ type: 'bill', amount: pendingBill.amount, biller: pendingBill.biller, billId: pendingBill.billId })
        })
        const txData = await txRes.json()
        if (txData.success) {
          setUserData(u => ({ ...u, balance: txData.new_balance, points: txData.new_points }))
          loadTransactions(); loadBreakdown(); loadReminders(); loadNotifications()
          showToast(`PKR ${pendingBill.amount.toLocaleString('en-PK')} paid to ${pendingBill.biller}`)
          setModal({ type: 'payBill6', txData })
        } else { setModal({ type: 'payBill5', inlineError: txData.message || 'Payment failed.' }) }
      } catch { setError('Server error. Please try again.') }
      setLoading(false)
    }

    return (
      <div>
        <h3>{t('confirm_bill_payment')}</h3>
        {stepDots(5, 6)}
        <div className="summary-box">
          <div className="summary-row"><span>{t('biller')}</span><strong>{pendingBill?.biller}</strong></div>
          <div className="summary-row"><span>{t('reference_number')}</span><strong>{pendingBill?.billId}</strong></div>
          <div className="summary-row"><span>{t('amount')}</span><strong>PKR {pendingBill?.amount?.toLocaleString('en-PK')}</strong></div>
        </div>
        <form onSubmit={handleSubmit}>
          <label style={{ textAlign: 'center', display: 'block' }}>{t('enter_pin_title')}</label>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', margin: '14px 0 20px' }}>
            {digits.map((d, idx) => (
              <input
                key={idx}
                ref={el => (inputRefs.current[idx] = el)}
                type="password"
                inputMode="numeric"
                maxLength={1}
                autoFocus={idx === 0}
                value={d}
                onChange={e => handleDigitChange(idx, e.target.value)}
                onKeyDown={e => handleKeyDown(idx, e)}
                style={{ width: 44, height: 52, textAlign: 'center', fontSize: 20, borderRadius: 8, border: '1px solid #d1d5db' }}
              />
            ))}
          </div>
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8, textAlign: 'center' }}>{error}</p>}
          <button type="submit" className="modal-btn-primary" disabled={loading}>{loading ? t('processing') : t('btn_confirm_pay')}</button>
          <button type="button" className="modal-btn-secondary" onClick={() => setModal({ type: 'payBill4' })}>{t('btn_back')}</button>
        </form>
      </div>
    )
  }

  // ── Modal 6: Success ─────────────────────────────────────────────────────────
  function PayBillStep6({ txData }) {
    const txId = txData?.transaction_id
    return (
      <div style={{ textAlign: 'center', padding: 10 }}>
        {stepDots(6, 6)}
        <div className="success-icon">✓</div>
        <h3 style={{ color: 'var(--income)', marginBottom: 15 }}>{t('tx_successful')}</h3>
        <p style={{ fontSize: 16, marginBottom: 10 }}>Your {pendingBill?.biller} bill has been paid successfully!</p>
        <p style={{ fontSize: 14, color: '#666', marginBottom: 20 }}>{t('amount')}: <strong>PKR {pendingBill?.amount?.toLocaleString('en-PK')}</strong></p>
        <p style={{ fontSize: 14, color: 'var(--primary-purple)' }}>You earned {txData?.points_earned} reward points!</p>
        <div className="receipt-actions">
          <button className="modal-btn-primary" style={{ marginTop: 0 }} onClick={() => downloadReceipt(txId)}>{t('btn_download_pdf')}</button>
                  </div>
        <button className="modal-btn-secondary" onClick={() => setModal(null)}>{t('btn_done')}</button>
      </div>
    )
  }

  function RewardsInfo() {
    return (
      <div>
        <h3>{t('rewards_title')}</h3>
        <h4 style={{ color: 'var(--income)', margin: '20px 0' }}>{t('current_points')}: {userData.points}</h4>
        <p style={{ marginBottom: 20 }}>You earn 5 points for every PKR 1,000 spent via FinBud transfers or bill payments.</p>
        <div style={{ background: 'var(--secondary-purple)', padding: 20, borderRadius: 8, marginBottom: 20 }}>
          {Object.values(REDEMPTION_TIERS).map(tier => (
            <p key={tier.label} style={{ margin: '10px 0' }}><strong>{tier.points_cost} Points:</strong> {tier.label} — PKR {tier.pkr_value.toLocaleString('en-PK')}</p>
          ))}
        </div>
        <p style={{ fontSize: 12, color: '#777' }}>Use "Redeem Points" to convert your points into one of the rewards above.</p>
        <button className="modal-btn-primary" onClick={() => setModal(null)}>{t('btn_got_it')}</button>
      </div>
    )
  }

  function RewardsRedeem({ message, messageType }) {
    async function redeem(tierKey, productId = null) {
      try {
        const body = { tier: tierKey }
        if (productId) body.product_id = productId
        const res = await fetch('/api/rewards/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) })
        const data = await res.json()
        if (data.success) {
          setUserData(u => ({ ...u, points: data.remaining_points, balance: data.new_balance }))
          loadTransactions(); loadNotifications()
          showToast(`Redeemed: ${data.description}`)
          setModal({ type: 'redeemPoints', message: `Redeemed! ${data.description}`, messageType: 'success' })
        } else {
          setModal({ type: 'redeemPoints', message: data.message || 'Redemption failed.', messageType: 'error' })
        }
      } catch { setModal({ type: 'redeemPoints', message: 'Server error.', messageType: 'error' }) }
    }

    return (
      <div>
        <h3>{t('redeem_points_title')}</h3>
        <h4 style={{ color: 'var(--income)', margin: '20px 0' }}>{t('available_points')}: {userData.points}</h4>
        {message && <p style={{ color: messageType === 'success' ? 'var(--income)' : 'var(--danger)', fontSize: 13, marginBottom: 10 }}>{message}</p>}
        {Object.entries(REDEMPTION_TIERS).map(([key, tier]) => (
          <div key={key} className="summary-box" style={{ marginBottom: 14 }}>
            <div className="summary-row"><span>{tier.label}</span><strong>{tier.points_cost} pts</strong></div>
            <div className="summary-row"><span>{t('value')}</span><strong>PKR {tier.pkr_value.toLocaleString('en-PK')}</strong></div>
            <button className="modal-btn-primary" style={{ marginTop: 10 }}
              onClick={() => key === 'product_purchase' ? setModal({ type: 'productSelect' }) : redeem(key)}>
              {t('btn_redeem')}
            </button>
          </div>
        ))}
        <button className="modal-btn-secondary" onClick={() => setModal(null)}>{t('btn_close')}</button>
      </div>
    )
  }

  function ProductSelect() {
    async function redeem(productId) {
      try {
        const res = await fetch('/api/rewards/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ tier: 'product_purchase', product_id: productId }) })
        const data = await res.json()
        if (data.success) {
          setUserData(u => ({ ...u, points: data.remaining_points, balance: data.new_balance }))
          loadTransactions(); loadNotifications()
          showToast(`Redeemed: ${data.description}`)
          setModal({ type: 'redeemPoints', message: `Redeemed! ${data.description}`, messageType: 'success' })
        } else { setModal({ type: 'redeemPoints', message: data.message || 'Redemption failed.', messageType: 'error' }) }
      } catch { setModal({ type: 'redeemPoints', message: 'Server error.', messageType: 'error' }) }
    }
    return (
      <div>
        <h3>{t('choose_product_title')}</h3>
        <h4 style={{ color: 'var(--income)', margin: '20px 0' }}>{t('available_points')}: {userData.points}</h4>
        {Object.entries(MOCK_PRODUCT_CATALOGUE).map(([id, p]) => (
          <div key={id} className="summary-box" style={{ marginBottom: 14 }}>
            <div className="summary-row"><span>{p.name}</span><strong>PKR {p.pkr_value.toLocaleString('en-PK')}</strong></div>
            <button className="modal-btn-primary" style={{ marginTop: 10 }} onClick={() => redeem(id)}>{t('btn_confirm')}</button>
          </div>
        ))}
        <button className="modal-btn-secondary" onClick={() => setModal({ type: 'redeemPoints' })}>{t('btn_back')}</button>
      </div>
    )
  }

  function DownloadHistory() {
    const todayStr = new Date().toISOString().slice(0, 10)
    const [startDate, setStartDate] = useState('')
    const [endDate, setEndDate] = useState(todayStr)
    const [error, setError] = useState('')

    function handleSubmit(e) {
      e.preventDefault()
      if (!startDate || !endDate) { setError('Please select both a start and end date.'); return }
      if (startDate > endDate) { setError('Start date must be before the end date.'); return }
      setError('')
      printTransactionHistory(startDate, endDate)
      setModal(null)
    }

    return (
      <div>
        <h3>{t('tx_download_history')}</h3>
        <p style={{ fontSize: 12, color: '#777' }}>{t('tx_download_history_note')}</p>
        <form onSubmit={handleSubmit}>
          <label>{t('tx_start_date')}</label>
          <input type="date" required max={todayStr} value={startDate} onChange={e => setStartDate(e.target.value)} />
          <label style={{ marginTop: 10 }}>{t('tx_end_date')}</label>
          <input type="date" required max={todayStr} value={endDate} onChange={e => setEndDate(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary">{t('btn_download_pdf')}</button>
        </form>
      </div>
    )
  }

  function TopUp() {
    const [amount, setAmount] = useState('')
    const [error, setError] = useState('')

    async function handleSubmit(e) {
      e.preventDefault()
      const amt = parseFloat(amount)
      if (isNaN(amt) || amt <= 0) { setError('Please enter a valid positive amount.'); return }
      try {
        const res = await fetch('/api/user/topup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ amount: amt }) })
        if (res.status === 404) { setError('Top-up endpoint not added to the backend yet.'); return }
        const data = await res.json()
        if (data.success) {
          setUserData(u => ({ ...u, balance: data.new_balance }))
          showToast(`PKR ${amt.toLocaleString('en-PK')} added to your balance`)
          setModal({ type: 'alert', title: 'Balance Updated', message: `PKR ${amt.toLocaleString('en-PK')} added. New balance: PKR ${data.new_balance.toLocaleString('en-PK')}`, color: 'var(--income)' })
          loadTransactions(); loadNotifications()
        } else { setError(data.message || 'Top-up failed.') }
      } catch { setError('Server error. Please try again.') }
    }
    return (
      <div>
        <h3>{t('topup_title')}</h3>
        <p style={{ fontSize: 12, color: '#777' }}>{t('topup_note')}</p>
        <form onSubmit={handleSubmit}>
          <label>{t('amount_pkr')}</label>
          <input type="number" required min="1" step="0.01" autoFocus placeholder="e.g., 10000" value={amount} onChange={e => setAmount(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary">{t('btn_add_funds')}</button>
        </form>
      </div>
    )
  }

  function LogIncome() {
    const [amount, setAmount] = useState('')
    const [source, setSource] = useState('Business Sales')
    const [note, setNote] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    async function handleSubmit(e) {
      e.preventDefault()
      const amt = parseFloat(amount)
      if (isNaN(amt) || amt <= 0) { setError('Please enter a valid positive amount.'); return }
      setError(''); setLoading(true)
      try {
        const res = await fetch('/api/income/log', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ amount: amt, source, note })
        })
        if (res.status === 404) {
          setModal({ type: 'alert', title: 'Coming Soon', message: 'Income logging is part of our Phase 2 backend rollout — this screen is ready and waiting for the API.', color: 'var(--primary-purple)' })
          setLoading(false); return
        }
        const data = await res.json()
        if (data.success) {
          setUserData(u => ({ ...u, balance: data.new_balance ?? u.balance }))
          loadTransactions(); loadNotifications()
          setAdvisor(a => ({ ...a, loaded: false }))
          showToast(`PKR ${amt.toLocaleString('en-PK')} income logged — ${source}`)
          setModal({ type: 'alert', title: 'Income Logged', message: `PKR ${amt.toLocaleString('en-PK')} added from ${source}.`, color: 'var(--income)' })
        } else { setError(data.message || 'Could not log income.') }
      } catch { setError('Server error. Please try again.') }
      setLoading(false)
    }

    return (
      <div>
        <h3>Log Income</h3>
        <p style={{ fontSize: 12, color: '#777', marginTop: -8 }}>Record money coming in — sales, salary, freelance work, or remittances.</p>
        <form onSubmit={handleSubmit}>
          <label>Source</label>
          <select value={source} onChange={e => setSource(e.target.value)} required>
            <optgroup label="Active Income">
              <option>Salary</option>
              <option>Business Sales</option>
              <option>Freelance</option>
            </optgroup>
            <optgroup label="Passive Income">
              <option>Rental Income</option>
            </optgroup>
            <optgroup label="Investment Income">
              <option>Stock Market (PSX)</option>
            </optgroup>
            <optgroup label="Other">
              <option>Remittance</option>
              <option>Other</option>
            </optgroup>
          </select>
          <label>Amount (PKR)</label>
          <input type="number" required min="1" step="0.01" autoFocus placeholder="e.g., 15000" value={amount} onChange={e => setAmount(e.target.value)} />
          <label>Note (optional)</label>
          <input type="text" placeholder="e.g., Evening sales" value={note} onChange={e => setNote(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary" disabled={loading}>{loading ? 'Saving...' : 'ADD INCOME'}</button>
        </form>
      </div>
    )
  }

  function AddCard() {
    const [cardholder, setCardholder] = useState('')
    const [cardNumber, setCardNumber] = useState('')
    const [expiry, setExpiry] = useState('')
    const [nickname, setNickname] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    function formatCardNumber(v) {
      const digits = v.replace(/\D/g, '').slice(0, 16)
      return digits.replace(/(.{4})/g, '$1 ').trim()
    }
    function formatExpiry(v) {
      const digits = v.replace(/\D/g, '').slice(0, 4)
      return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits
    }

    async function handleSubmit(e) {
      e.preventDefault()
      const rawNumber = cardNumber.replace(/\s/g, '')
      if (rawNumber.length !== 16) { setError('Card number must be 16 digits.'); return }
      if (!/^\d{2}\/\d{2}$/.test(expiry)) { setError('Enter expiry as MM/YY.'); return }
      setError(''); setLoading(true)
      try {
        const res = await fetch('/api/cards/add', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ cardholder_name: cardholder, card_number: rawNumber, expiry, nickname })
        })
        if (res.status === 404) {
          setModal({ type: 'alert', title: 'Coming Soon', message: 'Card storage uses tokenization on real banking infrastructure, so this is wired up on the frontend and waiting for the backend/token-vault integration described in the handoff doc.', color: 'var(--primary-purple)' })
          setLoading(false); return
        }
        const data = await res.json()
        if (data.success) {
          setWallet(w => ({ ...w, loaded: false }))
          checkCard()
          setModal({ type: 'alert', title: 'Card Added', message: `Card ending in ${rawNumber.slice(-4)} has been added to your wallet.`, color: 'var(--income)' })
        } else { setError(data.message || 'Could not add card.') }
      } catch { setError('Server error. Please try again.') }
      setLoading(false)
    }

    return (
      <div>
        <h3>Add a Card</h3>
        <p style={{ fontSize: 12, color: '#777', marginTop: -8 }}>Add a debit/credit card from any bank to your FinBud wallet.</p>
        <form onSubmit={handleSubmit}>
          <label>Cardholder Name</label>
          <input type="text" required placeholder="Name on card" value={cardholder} onChange={e => setCardholder(e.target.value)} />
          <label>Card Number</label>
          <input type="text" required inputMode="numeric" placeholder="1234 5678 9012 3456" value={cardNumber} onChange={e => setCardNumber(formatCardNumber(e.target.value))} />
          <label>Expiry (MM/YY)</label>
          <input type="text" required inputMode="numeric" placeholder="MM/YY" value={expiry} onChange={e => setExpiry(formatExpiry(e.target.value))} maxLength={5} />
          <label>Nickname (optional)</label>
          <input type="text" placeholder="e.g., HBL Debit" value={nickname} onChange={e => setNickname(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary" disabled={loading}>{loading ? 'Adding...' : 'ADD CARD'}</button>
        </form>
        <p style={{ fontSize: 11, color: '#6b7280', marginTop: 12 }}>Card details are tokenized — FinBud never stores your raw card number.</p>
      </div>
    )
  }

  function LinkBankAccount() {
    const [bank, setBank] = useState('')
    const [iban, setIban] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    function handleIbanChange(v) {
      setIban(v.toUpperCase().replace(/\s/g, '').slice(0, 24))
    }

    const detectedBank = iban.length === 24 ? detectBankFromIBAN(iban) : null

    async function handleSubmit(e) {
      e.preventDefault()
      if (!bank) { setError('Please select your bank.'); return }
      if (iban.length !== 24) { setError('IBAN must be exactly 24 characters.'); return }
      setError(''); setLoading(true)
      try {
        const res = await fetch('/api/wallet/link-bank', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ bank, iban })
        })
        if (res.status === 404) {
          setModal({ type: 'alert', title: 'Coming Soon', message: "Real account linking needs each bank's consent under SBP's Open Banking framework (or a 1LINK Open API integration) — this screen is ready and waiting for that connection. See the research doc for details.", color: 'var(--primary-purple)' })
          setLoading(false); return
        }
        const data = await res.json()
        if (data.success) {
          setWallet(w => ({ ...w, loaded: false }))
          setModal({ type: 'alert', title: 'Request Sent', message: `A consent request has been sent to link your ${bank} account.`, color: 'var(--income)' })
        } else { setError(data.message || 'Could not link account.') }
      } catch { setError('Server error. Please try again.') }
      setLoading(false)
    }

    return (
      <div>
        <h3>Link a Bank Account</h3>
        <p style={{ fontSize: 12, color: '#777', marginTop: -8 }}>Connect any Pakistani bank account to view its balance and transactions inside FinBud.</p>
        <form onSubmit={handleSubmit}>
          <label>Bank</label>
          <select value={bank} onChange={e => setBank(e.target.value)} required>
            <option value="">Select bank...</option>
            {PAKISTAN_BANKS.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <label>IBAN</label>
          <input type="text" required placeholder="e.g., PK36SCBL0000001123456702" value={iban} maxLength={24} onChange={e => handleIbanChange(e.target.value)} />
          <div className="bank-detect-note">
            {iban.length === 24
              ? (detectedBank ? `Matches: ${detectedBank}` : 'Bank code not recognized — double-check the IBAN.')
              : `${iban.length}/24 characters`}
          </div>
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary" disabled={loading}>{loading ? 'Sending Request...' : 'SEND LINK REQUEST'}</button>
        </form>
        <p style={{ fontSize: 11, color: '#6b7280', marginTop: 12 }}>You'll be asked to verify with your bank via OTP before the account is linked — FinBud never sees or stores your online banking password.</p>
      </div>
    )
  }

  function EditOtherAssets() {
    const [amount, setAmount] = useState(wallet.otherAssets || '')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    async function handleSubmit(e) {
      e.preventDefault()
      const amt = parseFloat(amount)
      if (isNaN(amt) || amt < 0) { setError('Please enter a valid amount (0 or more).'); return }
      setError(''); setLoading(true)
      try {
        const res = await fetch('/api/wallet/other-assets', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ amount: amt })
        })
        if (res.status === 404) {
          setWallet(w => ({ ...w, otherAssets: amt }))
          setModal({ type: 'alert', title: 'Saved Locally', message: 'This total will show for this session. Once the backend endpoint is live, it\'ll persist across logins — see the handoff doc.', color: 'var(--primary-purple)' })
          setLoading(false); return
        }
        const data = await res.json()
        if (data.success) {
          setWallet(w => ({ ...w, otherAssets: amt, otherAssetsAvailable: true }))
          setModal(null)
        } else { setError(data.message || 'Could not save.') }
      } catch { setError('Server error. Please try again.') }
      setLoading(false)
    }

    return (
      <div>
        <h3>Other Assets</h3>
        <p style={{ fontSize: 12, color: '#777', marginTop: -8 }}>Savings elsewhere, cash on hand, or anything else you want counted toward your net worth.</p>
        <form onSubmit={handleSubmit}>
          <label>Total Amount (PKR)</label>
          <input type="number" required min="0" step="0.01" autoFocus placeholder="e.g., 50000" value={amount} onChange={e => setAmount(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary" disabled={loading}>{loading ? 'Saving...' : 'SAVE'}</button>
        </form>
      </div>
    )
  }

  function VerifyBalance() {
    const [pw, setPw] = useState('')
    const [error, setError] = useState('')
    async function handleSubmit(e) {
      e.preventDefault()
      try {
        const res = await fetch('/api/user/verify-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ password: pw }) })
        const data = await res.json()
        if (data.success) { setUserData(u => ({ ...u, isMasked: false })); setModal(null) }
        else { setError('Incorrect password. Please try again.'); setPw('') }
      } catch { setError('Server error.') }
    }
    return (
      <div>
        <h3>Verify Your Password</h3>
        <p>Please enter your password to view your balance.</p>
        <form onSubmit={handleSubmit}>
          <label>Password</label>
          <input type="password" required autoFocus placeholder="Enter your password" value={pw} onChange={e => setPw(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary">VERIFY</button>
        </form>
      </div>
    )
  }

  function ChangePassword() {
    const [cur, setCur] = useState(''); const [nw, setNw] = useState(''); const [conf, setConf] = useState(''); const [error, setError] = useState('')
    async function handleSubmit(e) {
      e.preventDefault()
      if (nw !== conf) { setError('New passwords do not match.'); return }
      try {
        const res = await fetch('/api/user/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ currentPassword: cur, newPassword: nw }) })
        const data = await res.json()
        if (data.success) setModal({ type: 'alert', title: 'Password Updated!', message: 'Your password has been successfully changed.', color: 'var(--income)' })
        else { setError(data.message || 'Password change failed.') }
      } catch { setError('Server error.') }
    }
    return (
      <div>
        <h3>Change Password</h3>
        <form onSubmit={handleSubmit}>
          <label>Current Password</label><input type="password" required value={cur} onChange={e => setCur(e.target.value)} />
          <label>New Password</label><input type="password" required minLength={4} value={nw} onChange={e => setNw(e.target.value)} />
          <label>Confirm New Password</label><input type="password" required value={conf} onChange={e => setConf(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary">UPDATE PASSWORD</button>
        </form>
      </div>
    )
  }

  // ── HELPERS ──────────────────────────────────────────────
  // One-tap plain-language explainer for jargon terms (Module F). Tap the
  // "?" to see a short sentence, tap again (or elsewhere) to close it.
  // Reusable "pick one" control for the Send Money / Pay Bill step flows.
  // options: [{ key, icon (fa class or emoji), label, sub? }]
  // variant: 'grid' (icon boxes) | 'list' (full-width rows)
  // columns: grid columns when variant === 'grid'
  // compact: smaller boxes — for grids with 3+ options that don't need as
  // much visual weight as a top-level "which flow" choice
  function OptionGrid({ options, selected, onSelect, variant = 'grid', columns = 2, compact = false }) {
    if (variant === 'list') {
      return (
        <div className="option-list">
          {options.map(opt => (
            <div
              key={opt.key}
              className={`option-list-item ${selected === opt.key ? 'selected' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(opt.key)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(opt.key) }}
            >
              <div className="option-list-icon" style={opt.color ? { background: opt.color } : undefined}>
                {opt.icon.startsWith('fa-') ? <i className={`fas ${opt.icon}`} /> : opt.icon}
              </div>
              <div className="option-list-label">{opt.label}</div>
              <i className="fas fa-chevron-right option-list-chevron" />
            </div>
          ))}
        </div>
      )
    }
    return (
      <div className={`option-grid ${compact ? 'compact' : ''}`} style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {options.map(opt => (
          <div
            key={opt.key}
            className={`option-card ${selected === opt.key ? 'selected' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(opt.key)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(opt.key) }}
          >
            <div className="option-card-icon" style={opt.color ? { background: opt.color } : undefined}>
              {opt.icon.startsWith('fa-') ? <i className={`fas ${opt.icon}`} /> : opt.icon}
            </div>
            <div className="option-card-label">{opt.label}</div>
            {opt.sub && <div className="option-card-sub">{opt.sub}</div>}
          </div>
        ))}
      </div>
    )
  }

  function stepDots(current, total) {
    return (
      <div className="step-indicator">
        {Array.from({ length: total }, (_, i) => i + 1).map((n, idx) => (
          <>
            {idx > 0 && <div key={`line-${n}`} className="step-line" />}
            <div key={n} className={`step-dot ${n < current ? 'done' : n === current ? 'current' : ''}`}>{n}</div>
          </>
        ))}
      </div>
    )
  }

  function renderModalContent() {
    if (!modal) return null
    switch (modal.type) {
      case 'sendMoney1': return <SendMoneyStep1 />
      case 'sendMoney2': return <SendMoneyStep2 />
      case 'sendMoney3': return <SendMoneyStep3 />
      case 'sendMoney4': return <SendMoneyStep4 />
      case 'sendMoney5': return <SendMoneyStep5 />
      case 'sendMoney6': return <SendMoneyStep6 txData={modal.txData} />
      case 'payBill1':   return <PayBillStep1 />
      case 'payBill2':   return <PayBillStep2 />
      case 'payBill3':   return <PayBillStep3 inlineError={modal.inlineError} />
      case 'payBill4':   return <PayBillStep4 inlineError={modal.inlineError} />
      case 'payBill5':   return <PayBillStep5 inlineError={modal.inlineError} />
      case 'payBill6':   return <PayBillStep6 txData={modal.txData} />
      case 'rewards':    return <RewardsInfo />
      case 'redeemPoints': return <RewardsRedeem message={modal.message} messageType={modal.messageType} />
      case 'productSelect': return <ProductSelect />
      case 'topup':      return <TopUp />
      case 'downloadHistory': return <DownloadHistory />
      case 'logIncome':  return <LogIncome />
      case 'addCard':    return <AddCard />
      case 'linkBank':   return <LinkBankAccount />
      case 'editAssets': return <EditOtherAssets />
      case 'verifyBalance': return <VerifyBalance />
      case 'changePassword': return <ChangePassword />
      case 'profileOverview': return (
        <div>
          <h3>Profile Overview</h3>
          <div style={{ background: 'var(--secondary-purple)', padding: 20, borderRadius: 8, margin: '20px 0' }}>
            <p><strong>Name:</strong> {userData.name}</p>
            <p><strong>User ID:</strong> {userData.userId}</p>
            <p><strong>Balance:</strong> PKR {userData.balance.toLocaleString('en-PK')}</p>
            <p><strong>Reward Points:</strong> {userData.points}</p>
          </div>
          <button className="modal-btn-primary" onClick={() => setModal(null)}>CLOSE</button>
        </div>
      )
      case 'settings': return (
        <div>
          <h3>Settings</h3>
          <div style={{ padding: 15, borderBottom: '1px solid var(--secondary-purple)', cursor: 'pointer' }} onClick={() => setModal({ type: 'accessibilitySettings' })}>
            <strong>Display &amp; Accessibility</strong>
            <p style={{ fontSize: 13, color: '#666', margin: '5px 0 0' }}>High contrast, simple mode</p>
          </div>
          {['Notifications', 'Language & Region', 'Linked Accounts', 'Privacy Settings'].map(s => (
            <div key={s} style={{ padding: 15, borderBottom: '1px solid var(--secondary-purple)', cursor: 'pointer' }} onClick={() => alert('Feature coming soon!')}>
              <strong>{s}</strong>
            </div>
          ))}
          <button className="modal-btn-primary" onClick={() => setModal(null)}>CLOSE</button>
        </div>
      )
      case 'accessibilitySettings': return (
        <div>
          <h3>Display &amp; Accessibility</h3>
          <p style={{ fontSize: 12, color: '#777', marginTop: -8, marginBottom: 20 }}>
            These settings apply everywhere in FinBud, including chat, and are remembered on this device.
          </p>

          <div className="a11y-toggle-row">
            <div>
              <strong>High Contrast Mode</strong>
              <p style={{ fontSize: 12, color: '#777', margin: '4px 0 0' }}>Stronger colors, easier to read in bright light or for low vision.</p>
            </div>
            <button
              type="button"
              className={`toggle-switch ${highContrast ? 'on' : ''}`}
              role="switch"
              aria-checked={highContrast}
              aria-label="Toggle high contrast mode"
              onClick={() => setHighContrast(v => !v)}
            >
              <span className="toggle-knob" />
            </button>
          </div>

          <div className="a11y-toggle-row">
            <div>
              <strong>Simple Mode</strong>
              <p style={{ fontSize: 12, color: '#777', margin: '4px 0 0' }}>Bigger buttons and fewer things on screen at once.</p>
            </div>
            <button
              type="button"
              className={`toggle-switch ${simpleMode ? 'on' : ''}`}
              role="switch"
              aria-checked={simpleMode}
              aria-label="Toggle simple mode"
              onClick={() => setSimpleMode(v => !v)}
            >
              <span className="toggle-knob" />
            </button>
          </div>

          <p style={{ fontSize: 12, color: '#777', marginTop: 20 }}>
            Text size can be changed any time from the <strong>A- / A / A+</strong> buttons in the left sidebar.
          </p>
          <button className="modal-btn-primary" onClick={() => setModal(null)}>DONE</button>
        </div>
      )
      case 'security': return (
        <div>
          <h3>Security Center</h3>
          <div style={{ padding: 15, borderBottom: '1px solid var(--secondary-purple)', cursor: 'pointer' }} onClick={() => setModal({ type: 'changePassword' })}>
            <strong>Change Password</strong><p style={{ fontSize: 13, color: '#666', margin: '5px 0 0' }}>Update your account password</p>
          </div>
          {['Two-Factor Authentication', 'Login History', 'Trusted Devices'].map(s => (
            <div key={s} style={{ padding: 15, borderBottom: '1px solid var(--secondary-purple)', cursor: 'pointer' }} onClick={() => alert('Feature coming soon!')}>
              <strong>{s}</strong>
            </div>
          ))}
          <button className="modal-btn-primary" onClick={() => setModal(null)}>CLOSE</button>
        </div>
      )
      case 'financialReports': return <FinancialReports />
      case 'alert': return (
        <div>
          <h3 style={{ color: modal.color }}>{modal.title}</h3>
          <p>{modal.message}</p>
          <button className="modal-btn-primary" onClick={() => setModal(null)}>OK</button>
        </div>
      )
      default: return null
    }
  }

  function FinancialReports() {
    const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1])
    const total = entries.reduce((s, [, v]) => s + v, 0)
    return (
      <div>
        <h3>Financial Reports</h3>
        <h4 style={{ color: 'var(--primary-purple)', marginBottom: 15 }}>Spending by Category</h4>
        {entries.length === 0
          ? <p style={{ textAlign: 'center', color: '#999' }}>No spending data available</p>
          : entries.map(([cat, amt]) => (
            <div key={cat} style={{ padding: '10px 0', borderBottom: '1px solid var(--secondary-purple)', display: 'flex', justifyContent: 'space-between' }}>
              <strong>{cat}</strong>
              <span>PKR {amt.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({total > 0 ? ((amt / total) * 100).toFixed(1) : '0.0'}%)</span>
            </div>
          ))}
        <button className="modal-btn-primary" onClick={() => setModal(null)}>CLOSE</button>
      </div>
    )
  }

  const breakdownEntries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const breakdownTotal = breakdownEntries.reduce((s, [, v]) => s + v, 0)
  const formattedBalance = new Intl.NumberFormat('en-PK').format(userData.balance)

  return (
    <>
      <style>{`
        :root {
          --primary-purple: #5c2d91;
          --secondary-purple: #f2f2f2;
          --text-dark: #111;
          --text-light: #fff;
          --bg: #f2f2f2;
          --card: #ffffff;
          --danger: #b91c1c;
          --income: #10b981;
          --expense: #ef4444;
          --warning: #f59e0b;
          /* Locks form controls to light theming. Without this, mobile
             browsers with auto-dark-mode on (default on most Android Chrome)
             re-theme inputs independently of our CSS — background stays the
             #fff we set below, but the browser injects its own light text
             color for "dark mode", producing invisible white-on-white text
             in Send Money / Pay Bill / every modal form. */
          color-scheme: light;
        }
        html, body { margin:0; padding:0; width:100%; min-height:100vh; overflow-x:hidden; }
        #root { width:100%; min-height:100vh; display:block; }
        * { box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui; }
        body { background: var(--bg); color: var(--text-dark); }
        .app-shell { display:flex; min-height:100vh; width:100%; }
        .left-nav { width:220px; flex-shrink:0; background:var(--card); border-right:1px solid rgba(0,0,0,0.05); display:flex; flex-direction:column; padding:24px 0; position:sticky; top:0; height:100vh; }
        .left-nav-brand { display:flex; align-items:center; gap:10px; padding:0 24px 24px; }
        .left-nav-brand-text { font-size:22px; font-weight:700; color:var(--primary-purple); }
        .left-nav-list { list-style:none; margin:0; padding:8px 12px; display:flex; flex-direction:column; gap:4px; }
        .left-nav-list li { display:flex; align-items:center; gap:14px; padding:13px 16px; border-radius:8px; font-weight:600; font-size:15px; color:var(--text-dark); cursor:pointer; transition:background 0.2s, color 0.2s; }
        .left-nav-list li i { width:18px; text-align:center; font-size:16px; color:var(--primary-purple); }
        .left-nav-list li:hover { background:var(--secondary-purple); }
        .left-nav-list li.active { background:var(--primary-purple); color:#fff; }
        .left-nav-list li.active i { color:#fff; }
        .main-content { flex-grow:1; min-width:0; }
        .topbar { display:flex; justify-content:space-between; align-items:center; padding:15px 40px; background:var(--card); border-bottom:1px solid rgba(0,0,0,0.05); position:sticky; top:0; z-index:10; }
        .topbar-title { font-size:22px; font-weight:700; color:var(--primary-purple); margin:0; }
        .logo-circle { width:36px; height:36px; border-radius:50%; background:var(--primary-purple); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:14px; flex-shrink:0; }
        .topbar-right { display:flex; align-items:center; gap:20px; }
        .bell-container { position:relative; cursor:pointer; padding:8px; }
        .bell-container i { font-size:22px; color:var(--primary-purple); }
        .activity-badge { background:var(--income); }
        .activity-dropdown { right:100px; }
        .activity-item { border-left-color:var(--primary-purple); background:rgba(92,45,145,0.06); padding:10px 14px; margin-bottom:8px; text-align:left; }
        .activity-item.activity-unread { border-left-color:var(--income); background:rgba(16,185,129,0.08); }
        .activity-msg { font-size:13px; line-height:1.4; color:var(--text-dark); text-align:left; }
        .activity-item.activity-unread .activity-msg { font-weight:700; }
        .activity-time { font-size:10.5px; color:#8a8a8a; margin-top:3px; text-align:left; }

        /* Toast notification (transaction confirmations) */
        .toast-notification {
          position:fixed; top:80px; right:40px; z-index:400;
          display:flex; align-items:center; gap:10px;
          background:#1a1a1a; color:#fff; padding:14px 18px; border-radius:10px;
          font-size:13.5px; font-weight:600; box-shadow:0 8px 24px rgba(0,0,0,0.25);
          max-width:360px; animation:toastIn 0.25s ease;
        }
        .toast-notification.toast-success i { color:var(--income); }
        .toast-notification button { background:none; border:none; color:#aaa; font-size:18px; cursor:pointer; margin-left:auto; padding:0 0 0 6px; line-height:1; }
        @keyframes toastIn { from { transform:translateY(-10px); opacity:0; } to { transform:translateY(0); opacity:1; } }
        @media(max-width:900px) {
          .toast-notification { right:16px; left:16px; max-width:none; top:70px; }
          .activity-dropdown { right:16px; }
        }
        .reminder-badge { position:absolute; top:5px; right:5px; background:var(--danger); color:#fff; border-radius:50%; width:18px; height:18px; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; }
        .reminders-dropdown { position:absolute; top:60px; right:40px; width:350px; max-height:400px; overflow-y:auto; background:var(--card); border-radius:12px; box-shadow:0 8px 20px rgba(0,0,0,0.15); z-index:1000; padding:20px; }
        .dropdown-backdrop { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.15); backdrop-filter:blur(3px); -webkit-backdrop-filter:blur(3px); z-index:500; }
        .reminders-dropdown h3 { color:var(--primary-purple); font-weight:700; margin:0 0 15px; font-size:18px; }
        .reminder-item { padding:12px; margin-bottom:10px; border-radius:8px; border-left:4px solid var(--warning); background:rgba(245,158,11,0.1); font-size:14px; text-align:left; }
        .reminder-item.due-today { border-left-color:var(--expense); background:rgba(239,68,68,0.1); }
        .reminder-item.overdue { border-left-color:var(--danger); background:rgba(185,28,28,0.1); }
        .profile-area { display:flex; align-items:center; gap:10px; font-weight:600; color:var(--primary-purple); cursor:pointer; }
        .profile-avatar { width:40px; height:40px; border-radius:50%; background:var(--primary-purple); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:16px; }
        .dashboard-grid { display:grid; grid-template-columns:1.7fr 1fr; gap:20px; padding:40px; max-width:1150px; margin:0 auto; }
        .card { background:var(--card); padding:30px; border-radius:12px; box-shadow:0 4px 10px rgba(0,0,0,0.05); color:var(--primary-purple); }
        .column-left { display:flex; flex-direction:column; gap:20px; }
        .column-right { display:flex; flex-direction:column; gap:20px; }
        .main-balance-card { background:var(--card); padding:40px; border-radius:12px; box-shadow:0 4px 10px rgba(0,0,0,0.05); }
        .main-balance-card h2 { font-size:32px; font-weight:700; margin:0 0 10px; color:var(--primary-purple); text-align:left; }
        .balance-label { font-size:14px; font-weight:600; margin-bottom:5px; color:var(--primary-purple); text-align:left; }
        .balance-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
        .currency { font-size:28px; font-weight:700; color:var(--text-dark); }
        .balance-value { font-size:28px; font-weight:700; color:var(--text-dark); }
        .sign-up-btn { background:#fff; color:var(--primary-purple); border:2px solid var(--primary-purple); padding:8px 20px; border-radius:8px; cursor:pointer; font-weight:700; text-transform:uppercase; margin-left:auto; }
        .topup-btn { background:var(--primary-purple); color:#fff; border:none; padding:8px 18px; border-radius:8px; cursor:pointer; font-weight:700; text-transform:uppercase; font-size:13px; }
        .quick-actions-grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
        .quick-actions-grid .action-btn { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; }
        .quick-actions-grid .action-btn i { font-size:24px; }
        .action-btn { background:var(--primary-purple); color:#fff; padding:30px 20px; border:none; border-radius:12px; cursor:pointer; font-weight:600; font-size:16px; text-transform:uppercase; text-align:center; transition:transform 0.15s, box-shadow 0.15s; }
        .action-btn:hover { transform:translateY(-3px); box-shadow:0 5px 15px rgba(0,0,0,0.2); }
        .action-btn.full-width { grid-column:1/-1; }
        .action-btn.danger { background:var(--danger); }
        .chat-card { background:var(--primary-purple); color:#fff; display:flex; justify-content:space-between; align-items:center; padding:20px 30px; cursor:pointer; border:none; border-radius:12px; box-shadow:0 4px 10px rgba(0,0,0,0.05); transition:opacity 0.2s; width:100%; }
        .chat-card:hover { opacity:0.9; }
        .chat-text { font-weight:600; font-size:20px; line-height:1.3; }
        .transactions-card { background:var(--card); padding:20px 22px; border-radius:12px; box-shadow:0 4px 10px rgba(0,0,0,0.05); max-width:420px; }
        .transactions-card h3 { color:var(--primary-purple); font-weight:700; margin:0; font-size:16px; }
        .tx-card-header { display:flex; align-items:center; justify-content:space-between; gap:10px; }
        .tx-download-btn { background:none; border:none; color:var(--primary-purple); font-size:16px; cursor:pointer; padding:6px 8px; border-radius:6px; flex-shrink:0; }
        .tx-download-btn:hover { background:var(--secondary-purple); }
        .tx-table { width:100%; table-layout:fixed; border-collapse:collapse; margin-top:15px; color:var(--text-dark); }
        .tx-table th, .tx-table td { padding:12px 0; border-bottom:1px solid rgba(92,45,145,0.1); font-size:13px; text-align:left; overflow:hidden; }
        .tx-table th:nth-child(1), .tx-table td:nth-child(1) { white-space:nowrap; padding-right:8px; }
        .tx-table th { color:var(--primary-purple); font-weight:600; text-transform:uppercase; font-size:11px; }
        .tx-desc-cell { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding-right:8px; }
        .tx-table th:nth-child(3), .tx-table td:nth-child(3) { text-align:right; font-weight:600; white-space:nowrap; }
        .income-text { color:var(--income); }
        .expense-text { color:var(--expense); }
        .breakdown-card { background:var(--card); padding:20px 30px; border-radius:12px; box-shadow:0 4px 10px rgba(0,0,0,0.05); }
        .breakdown-row { margin-bottom:14px; }
        .breakdown-label-row { display:flex; justify-content:space-between; gap:8px; font-size:13px; margin-bottom:6px; }
        .breakdown-label-row > span:first-child { min-width:0; overflow-wrap:break-word; word-break:break-word; }
        .breakdown-label-row > strong { flex-shrink:0; }
        .breakdown-bar-track { width:100%; height:8px; background:var(--secondary-purple); border-radius:4px; overflow:hidden; }
        .breakdown-bar-fill { height:100%; background:var(--primary-purple); border-radius:4px; transition:width 0.4s; }
        .income-bar-fill { background:var(--income); }
        .advisor-wrap { max-width:1150px; margin:0 auto; padding:40px; }
        .advisor-header { display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:16px; margin-bottom:24px; }
        .advisor-title { font-size:26px; font-weight:700; color:var(--primary-purple); margin:0 0 6px; }
        .advisor-subtitle { font-size:14px; color:#6b7280; margin:0; }
        .advisor-grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
        .advisor-grid .card { min-width:0; }
        .grow-money-grid { display:grid; grid-template-columns:1fr; gap:20px; }
        .grow-money-header { justify-content:center; text-align:center; }
        .advisor-summary-card { grid-column:1/-1; }
        .advisor-summary-row { display:flex; gap:30px; flex-wrap:wrap; margin-top:10px; }
        .advisor-stat { display:flex; flex-direction:column; gap:6px; }
        .advisor-stat-label { font-size:13px; font-weight:600; color:#6b7280; text-transform:uppercase; }
        .advisor-stat-value { font-size:24px; font-weight:700; }
        .advisor-empty { font-size:13px; color:#999; text-align:center; padding:20px 0; }
        .advisor-insights-card { grid-column:1/-1; }
        .preview-tag { font-size:10px; font-weight:700; background:var(--secondary-purple); color:var(--primary-purple); padding:3px 8px; border-radius:20px; text-transform:uppercase; margin-left:8px; vertical-align:middle; }
        .insight-item { background:var(--secondary-purple); padding:14px 16px; border-radius:8px; font-size:13px; color:var(--text-dark); margin-top:10px; line-height:1.5; }
        .trend-chart { display:flex; align-items:flex-end; gap:14px; height:180px; margin-top:10px; padding-top:20px; }
        .trend-col { display:flex; flex-direction:column; align-items:center; gap:8px; flex:1; height:100%; }
        .trend-bars { display:flex; align-items:flex-end; gap:3px; height:100%; width:100%; justify-content:center; }
        .trend-bar-wrap { display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; }
        .trend-bar-value { font-size:10px; font-weight:700; margin-bottom:3px; white-space:nowrap; }
        .trend-bar { width:10px; border-radius:3px 3px 0 0; min-height:2px; }
        .trend-bar.income-bar { background:var(--income); }
        .trend-bar.expense-bar { background:var(--expense); }
        .trend-label { font-size:11px; color:#6b7280; font-weight:600; }
        .bank-detect-note { font-size:12px; color:var(--primary-purple); background:var(--secondary-purple); padding:8px 12px; border-radius:6px; margin-top:6px; }
        .advisor-footnote { font-size:12px; color:#6b7280; margin:12px 0 0; line-height:1.5; }

        /* Credit Score card */
        .credit-score-row { display:flex; align-items:center; gap:20px; flex-wrap:wrap; margin-bottom:16px; }
        .credit-score-value { font-size:48px; font-weight:800; line-height:1; }
        .credit-score-pill { display:inline-block; padding:4px 14px; border-radius:20px; color:#fff; font-size:12px; font-weight:700; text-transform:uppercase; }
        /* Flex children default to min-width:auto, which stops them shrinking
           below their content's natural width — the advice text would rather
           push the row past the screen edge than wrap. min-width:0 lets it
           shrink and wrap like normal text. */
        .credit-score-row > div { min-width:0; }
        .credit-breakdown-list { padding-top:14px; border-top:1px solid var(--secondary-purple); }
        .credit-breakdown-row { display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--secondary-purple); }
        .credit-breakdown-row:last-child { border-bottom:none; }
        .credit-breakdown-row strong { font-size:15px; color:var(--primary-purple); }

        /* Anomaly Alerts card */
        .anomaly-item { display:flex; gap:12px; align-items:flex-start; padding:12px; margin-bottom:10px; border-radius:8px; border-left:4px solid var(--secondary-purple); background:var(--secondary-purple); }
        .anomaly-item:last-child { margin-bottom:0; }
        .anomaly-icon { font-size:18px; flex-shrink:0; }
        /* Same min-width:0 fix as the credit score row above — without it the
           anomaly message refuses to wrap and overflows the card sideways
           instead of shrinking to fit. */
        .anomaly-item > div { min-width:0; flex:1; overflow-wrap:break-word; word-break:break-word; }
        .anomaly-item.anomaly-info { border-left-color:var(--primary-purple); background:rgba(92,45,145,0.06); }
        .anomaly-item.anomaly-warning { border-left-color:var(--warning); background:rgba(245,158,11,0.1); }
        .anomaly-item.anomaly-danger { border-left-color:var(--danger); background:rgba(185,28,28,0.08); }

        .wallet-card-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
        .wallet-row { display:flex; justify-content:space-between; align-items:center; padding:14px 0; border-bottom:1px solid var(--secondary-purple); gap:12px; }
        .wallet-row:last-child { border-bottom:none; }
        /* Description column shrinks/wraps; the PKR amount on the right
           keeps its natural width instead of getting squeezed. */
        .wallet-row > div:first-child { min-width:0; flex:1; overflow-wrap:break-word; word-break:break-word; }
        .wallet-row > span { flex-shrink:0; }
        .wallet-status-pill { font-size:11px; font-weight:700; text-transform:uppercase; padding:4px 10px; border-radius:20px; background:rgba(16,185,129,0.12); color:var(--income); }
        .wallet-status-pill.locked { background:rgba(185,28,28,0.12); color:var(--danger); }
        .pace-compare-row { display:flex; gap:20px; margin-bottom:18px; flex-wrap:wrap; }
        .pace-compare-stat { flex:1; min-width:140px; background:var(--secondary-purple); border-radius:8px; padding:12px 14px; }
        .pace-compare-label { display:block; font-size:11px; font-weight:600; color:#6b7280; text-transform:uppercase; margin-bottom:6px; }
        .pace-compare-value { font-size:18px; color:var(--primary-purple); }
        .pace-row { margin-bottom:16px; }
        .pace-label-row { display:flex; justify-content:space-between; font-size:13px; margin-bottom:6px; }
        .pace-bar-warning { background:var(--warning) !important; }
        .pace-warning-text { color:var(--warning); font-weight:600; }
        .pace-good-text { color:var(--income); font-weight:600; }
        .edit-assets-link { background:none; border:none; color:var(--primary-purple); font-size:11px; font-weight:700; text-transform:uppercase; text-decoration:underline; cursor:pointer; padding:2px 0; margin-top:2px; align-self:flex-start; }
        .sidebar-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:transparent; z-index:150; display:none; }
        .sidebar-overlay.visible { display:block; }
        .sidebar { position:fixed; top:0; right:0; width:min(300px,90vw); height:100%; background:var(--card); z-index:200; box-shadow:-5px 0 15px rgba(0,0,0,0.2); transform:translateX(100%); transition:transform 0.3s; display:flex; flex-direction:column; }
        .sidebar.open { transform:translateX(0); }
        .sidebar-header { display:flex; flex-direction:column; align-items:center; padding:30px 20px 20px; border-bottom:1px solid var(--secondary-purple); }
        .sidebar-header .profile-avatar { width:60px; height:60px; font-size:20px; margin-bottom:10px; }
        .profile-name-large { font-size:20px; font-weight:700; color:var(--primary-purple); margin-bottom:5px; }
        .user-id { font-size:12px; color:#777; word-break:break-all; text-align:center; }
        .sidebar-nav { flex-grow:1; padding:20px 0; list-style:none; margin:0; }
        .sidebar-nav a { display:flex; align-items:center; padding:15px 30px; text-decoration:none; color:var(--text-dark); font-weight:600; transition:background 0.2s; cursor:pointer; }
        .sidebar-nav a:hover { background:var(--secondary-purple); color:var(--primary-purple); }
        .sidebar-nav a i { margin-right:15px; font-size:16px; width:20px; text-align:center; }
        .sidebar-footer { padding:20px; border-top:1px solid var(--secondary-purple); }
        .logout-btn { width:100%; background:var(--danger); color:#fff; padding:12px; border:none; border-radius:8px; cursor:pointer; font-weight:700; }
        .blurred { filter:blur(5px); transform:scale(0.98); pointer-events:none; }
        .modal-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); backdrop-filter:blur(5px); display:flex; justify-content:center; align-items:center; z-index:300; }
        .modal-box { background:var(--card); padding:30px; border-radius:12px; width:min(90%,450px); position:relative; box-shadow:0 10px 30px rgba(0,0,0,0.2); max-height:85vh; overflow-y:auto; }
        .modal-close { position:absolute; top:10px; right:10px; background:none; border:none; font-size:24px; cursor:pointer; color:var(--primary-purple); }
        .modal-box h3 { margin-top:0; color:var(--primary-purple); font-size:22px; text-align:center; }
        .modal-box label { display:block; margin-top:15px; font-size:14px; font-weight:600; color:var(--primary-purple); text-align:left; }
        .modal-box input, .modal-box select { width:100%; padding:10px; margin-top:5px; border:1px solid rgba(92,45,145,0.3); border-radius:6px; font-size:14px; background:#fff; color:var(--text-dark); }
        .modal-btn-primary { width:100%; padding:12px; margin-top:25px; background:var(--primary-purple); color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:700; text-transform:uppercase; font-size:14px; }
        .modal-btn-primary:disabled { opacity:0.6; cursor:not-allowed; }
        .modal-btn-secondary { width:100%; padding:12px; margin-top:10px; background:transparent; color:var(--primary-purple); border:2px solid var(--primary-purple); border-radius:6px; cursor:pointer; font-weight:700; text-transform:uppercase; font-size:14px; }

        /* Icon-choice grid — used for the "pick one" steps of the Send
           Money and Pay Bill modal flows (method, bill category, provider) */
        .option-grid { display:grid; gap:12px; margin-top:6px; }
        .option-card { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; padding:20px 10px; background:var(--secondary-purple); border:2px solid transparent; border-radius:12px; cursor:pointer; text-align:center; transition:border-color .15s, transform .1s; }
        .option-card:hover { border-color:var(--primary-purple); }
        .option-card:active { transform:scale(0.98); }
        .option-card.selected { border-color:var(--primary-purple); background:#fff; box-shadow:0 2px 10px rgba(92,45,145,0.15); }
        .option-card-icon { width:44px; height:44px; border-radius:50%; background:var(--primary-purple); color:#fff; display:flex; align-items:center; justify-content:center; font-size:19px; }
        .option-card-label { font-weight:700; font-size:14px; color:var(--text-dark); }
        .option-card-sub { font-size:11px; color:#6b7280; margin-top:-4px; }
        /* Compact variant — for grids of 3+ options (e.g. bill category)
           that don't need the same visual weight as a top-level choice */
        .option-grid.compact { gap:8px; }
        .option-grid.compact .option-card { padding:12px 4px; gap:6px; border-radius:10px; }
        .option-grid.compact .option-card-icon { width:32px; height:32px; font-size:14px; }
        .option-grid.compact .option-card-label { font-size:12px; }
        /* List variant — full-width rows, used for provider selection so
           a category with many providers doesn't turn into a wall of boxes */
        .option-list { display:flex; flex-direction:column; gap:8px; margin-top:6px; max-height:320px; overflow-y:auto; }
        .option-list-item { display:flex; align-items:center; gap:12px; padding:12px 14px; background:var(--secondary-purple); border:2px solid transparent; border-radius:10px; cursor:pointer; transition:border-color .15s; }
        .option-list-item:hover { border-color:var(--primary-purple); }
        .option-list-item.selected { border-color:var(--primary-purple); background:#fff; box-shadow:0 2px 10px rgba(92,45,145,0.15); }
        .option-list-icon { width:34px; height:34px; border-radius:50%; background:var(--primary-purple); color:#fff; display:flex; align-items:center; justify-content:center; font-size:14px; flex-shrink:0; }
        .option-list-label { flex:1; text-align:left; font-weight:700; font-size:14px; color:var(--text-dark); }
        .option-list-chevron { color:var(--primary-purple); opacity:0.55; font-size:12px; }
        .identifier-type-toggle { display:flex; gap:8px; margin-top:6px; margin-bottom:4px; }
        .identifier-type-toggle button { flex:1; padding:9px; border-radius:6px; border:2px solid var(--primary-purple); background:transparent; color:var(--primary-purple); font-weight:700; font-size:12.5px; cursor:pointer; text-transform:uppercase; }
        .identifier-type-toggle button.active { background:var(--primary-purple); color:#fff; }
        .option-grid-loading { text-align:center; padding:30px 0; color:#6b7280; font-size:13px; }
        @media (max-width:420px) {
          .option-grid.compact { gap:6px; }
          .option-grid.compact .option-card { padding:10px 2px; }
          .option-grid.compact .option-card-icon { width:28px; height:28px; font-size:12px; }
          .option-grid.compact .option-card-label { font-size:10.5px; }
        }
        .step-indicator { display:flex; align-items:center; gap:8px; margin:4px 0 20px; }
        .step-dot { width:26px; height:26px; border-radius:50%; background:var(--secondary-purple); color:var(--primary-purple); display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; }
        .step-dot.done { background:var(--income); color:#fff; }
        .step-dot.current { background:var(--primary-purple); color:#fff; }
        .step-line { flex-grow:1; height:2px; background:var(--secondary-purple); }
        .summary-box { background:var(--secondary-purple); padding:16px; border-radius:8px; margin:16px 0; }
        .summary-row { display:flex; justify-content:space-between; font-size:13px; padding:4px 0; }
        .summary-row strong { color:var(--primary-purple); }
        .limit-note { background:var(--secondary-purple); padding:10px 14px; border-radius:8px; font-size:12px; color:var(--primary-purple); margin-top:16px; }
        .receipt-actions { display:flex; gap:10px; margin-top:10px; }
        .receipt-actions button { flex:1; }
        .success-icon { width:80px; height:80px; border-radius:50%; background:var(--primary-purple); color:#fff; display:flex; align-items:center; justify-content:center; margin:0 auto 20px; font-size:40px; }
        .saved-account-prompt { background:rgba(92,45,145,0.08); border:1px solid rgba(92,45,145,0.25); border-radius:8px; padding:12px 14px; margin-top:14px; font-size:13px; }
        .prompt-actions { display:flex; gap:8px; margin-top:10px; }
        .yes-btn { flex:1; padding:8px; border-radius:6px; border:none; cursor:pointer; font-weight:600; background:var(--primary-purple); color:#fff; }
        .no-btn { flex:1; padding:8px; border-radius:6px; cursor:pointer; font-weight:600; background:#fff; color:var(--primary-purple); border:1px solid var(--primary-purple); }
        .profile-switch-toggle { width:100%; background:var(--secondary-purple); border:none; border-radius:8px; padding:10px; font-size:12px; font-weight:700; color:var(--primary-purple); cursor:pointer; text-transform:uppercase; margin-top:16px; }
        .receipt-print { display:none; }
        @media print { body * { visibility:hidden; } .receipt-print, .receipt-print * { visibility:visible; } .receipt-print { display:block !important; position:absolute; top:0; left:0; width:100%; padding:30px; } }
        .receipt-print .r-header { text-align:center; margin-bottom:20px; }
        .receipt-print .r-header h2 { color:#5c2d91; margin:0; }
        .receipt-print .r-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #eee; font-size:14px; }

        /* ══════════ ACCESSIBILITY (Module F) ══════════ */

        /* Sidebar text-size control */
        .text-size-control { padding:16px 24px 4px; margin-top:12px; border-top:1px solid var(--secondary-purple); }
        .text-size-label { font-size:11px; font-weight:700; color:#9aa0ab; text-transform:uppercase; letter-spacing:0.5px; display:block; margin-bottom:8px; }
        .text-size-btns { display:flex; gap:6px; }
        .text-size-btn { flex:1; padding:8px 0; border-radius:8px; border:1.5px solid rgba(92,45,145,0.25); background:#fff; color:var(--primary-purple); font-weight:700; cursor:pointer; font-size:13px; }
        .text-size-btn.active { background:var(--primary-purple); color:#fff; border-color:var(--primary-purple); }

        /* Settings toggle switches */
        .a11y-toggle-row { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:14px 0; border-bottom:1px solid var(--secondary-purple); }
        .toggle-switch { width:46px; height:26px; border-radius:20px; background:#d1d5db; border:none; cursor:pointer; position:relative; flex-shrink:0; transition:background 0.2s; }
        .toggle-switch.on { background:var(--primary-purple); }
        .toggle-knob { position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#fff; transition:transform 0.2s; box-shadow:0 1px 3px rgba(0,0,0,0.3); }
        .toggle-switch.on .toggle-knob { transform:translateX(20px); }

        /* One-tap jargon explainer */
        .info-tip-wrap { position:relative; display:inline-block; }
        .info-tip-btn { width:16px; height:16px; border-radius:50%; border:1px solid #9aa0ab; background:#fff; color:#6b7280; font-size:10px; font-weight:700; line-height:1; cursor:pointer; padding:0; display:inline-flex; align-items:center; justify-content:center; vertical-align:middle; margin-left:4px; }
        .info-tip-bubble { position:absolute; bottom:calc(100% + 8px); left:50%; transform:translateX(-50%); width:220px; background:#1a1a1a; color:#fff; font-size:12px; font-weight:400; text-transform:none; letter-spacing:normal; line-height:1.5; padding:10px 12px; border-radius:8px; z-index:60; }

        /* Read-aloud button */
        .card-header-row { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
        .read-aloud-btn { background:var(--secondary-purple); color:var(--primary-purple); border:none; border-radius:20px; padding:6px 14px; font-size:12px; font-weight:700; cursor:pointer; }

        /* Simple Mode collapse toggle */
        .more-insights-btn { width:100%; background:none; border:1.5px dashed rgba(92,45,145,0.3); border-radius:8px; padding:18px; color:var(--primary-purple); font-weight:700; font-size:13px; cursor:pointer; }

        /* ── High contrast override ── */
        html[data-contrast="high"] {
          --primary-purple: #3d1a66;
          --secondary-purple: #e8e8e8;
          --text-dark: #000000;
          --bg: #ffffff;
          --card: #ffffff;
          --income: #067a4f;
          --expense: #c0231a;
          --warning: #a35a00;
        }
        html[data-contrast="high"] .card,
        html[data-contrast="high"] .main-balance-card,
        html[data-contrast="high"] .transactions-card,
        html[data-contrast="high"] .modal-box { border:1.5px solid #000; }
        html[data-contrast="high"] .left-nav { border-right:2px solid #000; }
        html[data-contrast="high"] .action-btn { border:2px solid #000; }

        /* ── Text size override (applies to the numbers/labels people rely on most) ── */
        html[data-font-size="large"] .balance-value,
        html[data-font-size="large"] .currency { font-size:36px; }
        html[data-font-size="large"] .action-btn { font-size:18px; padding:34px 20px; }
        html[data-font-size="large"] .advisor-stat-value { font-size:30px; }
        html[data-font-size="large"] .advisor-stat-label { font-size:14px; }
        html[data-font-size="large"] .tx-table { font-size:16px; }
        html[data-font-size="large"] .card h3, html[data-font-size="large"] .advisor-title { font-size:1.25em; }
        html[data-font-size="large"] .modal-box label,
        html[data-font-size="large"] .modal-box input,
        html[data-font-size="large"] .modal-box select { font-size:16px; }
        html[data-font-size="large"] .left-nav-list li { font-size:17px; padding:16px; }

        html[data-font-size="small"] .balance-value,
        html[data-font-size="small"] .currency { font-size:22px; }
        html[data-font-size="small"] .action-btn { font-size:14px; padding:22px 16px; }
        html[data-font-size="small"] .advisor-stat-value { font-size:19px; }
        html[data-font-size="small"] .tx-table { font-size:12px; }

        /* ── Simple Mode: bigger, calmer quick actions on Home ── */
        html[data-simple-mode="true"] .action-btn { padding:38px 20px; font-size:17px; }
        html[data-simple-mode="true"] .preview-tag { display:none; }

        @media(max-width:900px) {
          .app-shell { flex-direction:column; }
          .left-nav { width:100%; height:auto; position:sticky; top:0; z-index:20; flex-direction:row; align-items:center; padding:10px 16px; overflow-x:auto; }
          .left-nav-brand { padding:0 16px 0 0; }
          .left-nav-list { flex-direction:row; padding:0; }
          .left-nav-list li span { display:none; }
          .left-nav-list li { padding:10px 14px; }
          .text-size-control { padding:0 0 0 12px; margin-top:0; border-left:1px solid var(--secondary-purple); }
          .text-size-label { display:none; }
          .text-size-btns { gap:4px; }
          .text-size-btn { padding:6px 8px; font-size:11px; }
          .topbar{padding:15px 20px;}
          .dashboard-grid{grid-template-columns:1fr;padding:20px;}
          .quick-actions-grid{grid-template-columns:1fr;}
          .transactions-card{max-width:100%;}
          .advisor-wrap{padding:20px;}
          .advisor-grid{grid-template-columns:1fr;}
          .goals-list{grid-template-columns:1fr;}
        }

        /* ── Grow My Money (check-in, savings goals, investing) ── */
        .checkin-card { grid-column:1/-1; }
        .checkin-question { font-size:15px; font-weight:600; color:var(--text-dark); margin:0 0 14px; line-height:1.5; }
        .checkin-options { display:flex; flex-direction:column; gap:10px; }
        .checkin-option-btn { text-align:left; background:var(--secondary-purple); border:1.5px solid transparent; border-radius:8px; padding:14px 16px; font-size:14px; font-weight:600; color:var(--primary-purple); cursor:pointer; transition:border-color 0.15s, background 0.15s; }
        .checkin-option-btn:hover { border-color:var(--primary-purple); }
        .checkin-option-btn:disabled { opacity:0.6; cursor:default; }
        .checkin-back-btn { margin-top:14px; background:none; border:none; color:#6b7280; font-size:13px; font-weight:600; cursor:pointer; padding:6px 0; }

        .goals-list { display:grid; grid-template-columns:repeat(3, 1fr); gap:14px; margin-bottom:18px; }
        .goal-item { background:var(--secondary-purple); border-radius:10px; padding:14px 16px; }
        .goal-item-header { display:flex; justify-content:space-between; align-items:center; font-weight:700; color:var(--primary-purple); font-size:14px; margin-bottom:8px; }
        .goal-remove-btn { background:none; border:none; color:#9ca3af; font-size:18px; line-height:1; cursor:pointer; padding:2px 6px; }
        .goal-remove-btn:hover { color:var(--danger); }
        .goal-progress-track { background:rgba(92,45,145,0.12); border-radius:20px; height:8px; overflow:hidden; }
        .goal-progress-fill { background:var(--primary-purple); height:100%; border-radius:20px; transition:width 0.3s; }
        .goal-add-btn { margin-top:8px; background:#fff; border:1.5px solid var(--primary-purple); color:var(--primary-purple); border-radius:6px; padding:6px 12px; font-size:12px; font-weight:700; cursor:pointer; }
        .goal-withdraw-btn { border-color:#9ca3af; color:#4b5563; }
        .goal-plan-btn { background:#fff; border:1.5px solid var(--secondary-purple); color:var(--primary-purple); }
        .goal-inline-form { margin-top:10px; padding:12px; background:#fff; border:1.5px dashed var(--secondary-purple); border-radius:8px; text-align:left; }
        .goal-inline-row { display:flex; gap:8px; margin-top:8px; }
        .goal-inline-row select, .goal-inline-row input { flex:1; padding:8px 10px; border-radius:6px; border:1.5px solid var(--secondary-purple); font-size:13px; font-family:inherit; color:var(--text-dark); background:#fff; }
        .goal-inline-row select:focus, .goal-inline-row input:focus { outline:none; border-color:var(--primary-purple); }
        .goal-type-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; }
        .goal-type-btn { display:flex; flex-direction:column; align-items:center; gap:8px; background:var(--secondary-purple); border:1.5px solid transparent; border-radius:10px; padding:16px 8px; font-size:12px; font-weight:600; color:var(--primary-purple); cursor:pointer; }
        .goal-type-btn:hover { border-color:var(--primary-purple); }
        .goal-type-btn i { font-size:20px; }
        .goal-form { display:flex; flex-direction:column; gap:14px; }
        .goal-form label { display:flex; flex-direction:column; gap:6px; font-size:13px; font-weight:600; color:var(--primary-purple); text-align:left; }
        .goal-form input { padding:10px 12px; border-radius:8px; border:1.5px solid var(--secondary-purple); font-size:14px; font-family:inherit; color:var(--text-dark); background:#fff; }
        .goal-form input:focus { outline:none; border-color:var(--primary-purple); }

        .invest-type-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; }
        .invest-type-btn { display:flex; flex-direction:column; align-items:center; gap:8px; background:var(--secondary-purple); border:1.5px solid transparent; border-radius:10px; padding:16px 8px; font-size:12px; font-weight:600; color:var(--primary-purple); cursor:pointer; text-align:center; }
        .invest-type-btn:hover { border-color:var(--primary-purple); }
        .invest-type-btn i { font-size:20px; }
        .invest-guide-card { grid-column:1/-1; text-align:left; }
        .invest-guide-text p { font-size:14px; color:var(--text-dark); line-height:1.7; margin:0 0 12px; }

        html[data-simple-mode="true"] .goal-type-grid { grid-template-columns:repeat(2, 1fr); }

        /* ── Fin: the floating advisor chat trigger + docked side panel ── */
        .advisor-chat-bubble-btn { position:fixed; bottom:28px; right:28px; width:60px; height:60px; border-radius:50%; background:linear-gradient(135deg, var(--primary-purple), #8a5cd6); color:#fff; border:none; box-shadow:0 8px 20px rgba(92,45,145,0.35); font-size:22px; cursor:pointer; z-index:901; display:flex; align-items:center; justify-content:center; }
        .advisor-chat-bubble-btn:hover { transform:scale(1.05); }
        .advisor-chat-bubble-btn svg { color:#fff; --fin-face-color:var(--primary-purple); }
        .advisor-greeting-bubble { position:fixed; bottom:34px; right:100px; max-width:260px; background:#fff; border-radius:16px 16px 4px 16px; box-shadow:0 8px 24px rgba(0,0,0,0.18); padding:12px 32px 12px 14px; font-size:13px; color:var(--text-dark); text-align:left; display:flex; align-items:flex-start; gap:8px; border:none; cursor:pointer; z-index:900; line-height:1.5; }
        .advisor-greeting-bubble:hover { box-shadow:0 10px 28px rgba(0,0,0,0.24); }
        .advisor-greeting-icon { flex-shrink:0; width:26px; height:26px; border-radius:50%; background:var(--primary-purple); display:flex; align-items:center; justify-content:center; }
        .advisor-greeting-icon svg { color:#fff; --fin-face-color:var(--primary-purple); }
        .advisor-greeting-close { position:absolute; top:8px; right:10px; color:#9ca3af; font-size:12px; cursor:pointer; padding:4px; }
        .advisor-greeting-close:hover { color:var(--text-dark); }

        /* Docked side panel — anchored to the right edge of the screen,
           full height, so the rest of the advisor page stays visible/scrollable
           behind it rather than being covered by a small floating box. */
        .advisor-chat-sidepanel { position:fixed; top:0; right:0; bottom:0; width:360px; max-width:88vw; background:var(--card); box-shadow:-8px 0 30px rgba(0,0,0,0.18); display:flex; flex-direction:column; overflow:hidden; z-index:900; }
        .advisor-chat-popup-header { padding:16px 18px; background:var(--primary-purple); color:#fff; display:flex; align-items:center; justify-content:space-between; }
        .advisor-chat-popup-header-title { display:flex; align-items:center; gap:8px; }
        .advisor-chat-popup-avatar { width:30px; height:30px; border-radius:50%; background:#fff; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .advisor-chat-popup-avatar svg { color:var(--primary-purple); }
        .advisor-chat-popup-header strong { font-size:15px; }
        .advisor-chat-popup-header button { background:none; border:none; color:#fff; font-size:16px; cursor:pointer; padding:4px; opacity:0.85; }
        .advisor-chat-popup-header button:hover { opacity:1; }
        .advisor-chat-popup-messages { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
        .advisor-chat-disclaimer { background:#f7f5fb; border:1px solid var(--secondary-purple); border-radius:10px; padding:14px; font-size:12.5px; color:#6b7280; line-height:1.6; text-align:left; margin-bottom:6px; }
        .advisor-chat-bubble-msg { max-width:85%; padding:10px 13px; border-radius:12px; font-size:13px; line-height:1.5; text-align:left; }
        .advisor-chat-bubble-msg.ai { background:var(--secondary-purple); color:var(--text-dark); align-self:flex-start; border-bottom-left-radius:2px; }
        .advisor-chat-bubble-msg.user { background:var(--primary-purple); color:#fff; align-self:flex-end; border-bottom-right-radius:2px; }
        .advisor-chat-popup-input-row { display:flex; gap:8px; padding:14px; border-top:1px solid var(--secondary-purple); }
        .advisor-chat-popup-input-row input { flex:1; padding:11px 14px; border-radius:24px; border:1.5px solid var(--primary-purple); font-size:13px; font-family:inherit; }
        .advisor-chat-popup-input-row input:focus { outline:none; box-shadow:0 0 0 3px rgba(92,45,145,0.15); }
        .advisor-chat-popup-input-row button { width:38px; height:38px; border-radius:50%; background:var(--primary-purple); color:#fff; border:none; cursor:pointer; flex-shrink:0; }
        .advisor-chat-popup-input-row button:disabled { opacity:0.5; cursor:default; }
        /* Hands-free voice states for Fin's mic toggle: idle (on, not yet active) / listening (pulsing red) / processing (spinner) / speaking (waveform) */
        .advisor-mic-btn { background:var(--secondary-purple); color:var(--primary-purple); font-size:13px; }
        .advisor-mic-btn.idle { background:var(--primary-purple); color:#fff; }
        .advisor-mic-btn.listening { background:var(--danger, #b91c1c); color:#fff; animation:advisorMicPulse 1.5s infinite; }
        .advisor-mic-btn.processing { background:var(--primary-purple); color:#fff; }
        .advisor-mic-btn.speaking { background:#15803d; color:#fff; animation:advisorMicSpeak 1.2s infinite; }
        @keyframes advisorMicPulse { 0%{box-shadow:0 0 0 0 rgba(185,28,28,0.6)} 70%{box-shadow:0 0 0 8px rgba(185,28,28,0)} 100%{box-shadow:0 0 0 0 rgba(185,28,28,0)} }
        @keyframes advisorMicSpeak { 0%{box-shadow:0 0 0 0 rgba(21,128,61,0.5)} 70%{box-shadow:0 0 0 8px rgba(21,128,61,0)} 100%{box-shadow:0 0 0 0 rgba(21,128,61,0)} }

        @media(max-width:900px) {
          .goal-type-grid{grid-template-columns:repeat(3, 1fr);}
          .invest-type-grid{grid-template-columns:repeat(2, 1fr);}
          .advisor-greeting-bubble{right:16px; bottom:96px; max-width:calc(100vw - 100px);}
          .advisor-chat-sidepanel{width:100vw; max-width:100vw;}
          .advisor-chat-bubble-btn{right:16px; bottom:16px;}
        }

        /* When the bottom tab bar is present (mobile-shell only), the Fin
           bubble needs to sit above it rather than at bottom:16px, or it
           overlaps the Wallet tab. .mobile-shell adds specificity so this
           wins over the 900px rule above regardless of viewport width. */
        .mobile-shell .advisor-chat-bubble-btn { bottom:92px; right:16px; }
        .mobile-shell .advisor-greeting-bubble { bottom:172px; right:16px; max-width:calc(100vw - 48px); }
        .mobile-shell .advisor-chat-sidepanel { bottom:76px; }
        /* ══════════════════════════════════════════════════════════
           MOBILE SHELL — a genuinely different structure for phones,
           not the desktop layout squeezed narrower. Same colors, fonts,
           icons, and .card/.action-btn/.chat-card etc. building blocks
           as desktop (untouched above), just reassembled with a bottom
           tab bar and mobile-appropriate spacing/touch targets.
           ══════════════════════════════════════════════════════════ */
        .mobile-shell { display:flex; flex-direction:column; min-height:100vh; width:100%; background:var(--bg); padding-bottom:76px; }

        .mobile-topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:14px 16px; background:var(--card); border-bottom:1px solid rgba(0,0,0,0.06); position:sticky; top:0; z-index:30; }
        .mobile-topbar-brand { display:flex; align-items:center; gap:8px; }
        .mobile-topbar-brand-text { font-size:18px; font-weight:700; color:var(--primary-purple); }
        .mobile-topbar-actions { display:flex; align-items:center; gap:6px; }
        .mobile-topbar-actions .bell-container { padding:6px; }
        .mobile-topbar-actions .bell-container i { font-size:20px; }
        .mobile-profile-avatar { width:34px; height:34px; font-size:13px; margin-left:4px; cursor:pointer; }

        .lang-switcher { position:relative; }
        .lang-switcher-btn { background:none; border:1.5px solid var(--primary-purple); color:var(--primary-purple); border-radius:20px; padding:6px 10px; font-size:11px; font-weight:700; display:flex; align-items:center; gap:5px; cursor:pointer; }
        .lang-switcher-btn i { font-size:12px; }
        .lang-switcher-menu { position:absolute; top:38px; right:0; background:var(--card); border-radius:10px; box-shadow:0 8px 20px rgba(0,0,0,0.15); z-index:1000; overflow:hidden; min-width:140px; }
        .lang-switcher-menu button { display:block; width:100%; text-align:left; background:none; border:none; padding:12px 16px; font-size:14px; font-weight:600; color:var(--text-dark); cursor:pointer; }
        .lang-switcher-menu button:hover { background:var(--secondary-purple); }
        .lang-switcher-menu button.active { color:var(--primary-purple); background:rgba(92,45,145,0.08); }

        /* Urdu script needs a Nastaliq-capable font — Inter has no Arabic-
           script glyphs at all. Applied only when language==='ur'; layout
           direction (flex/grid order) is left as-is, only the text font and
           paragraph alignment shift — a full RTL mirror is a bigger,
           separate change. */
        .lang-ur, .lang-ur input, .lang-ur select, .lang-ur button {
          font-family: 'Noto Nastaliq Urdu', Inter, ui-sans-serif, system-ui;
        }
        .lang-ur p, .lang-ur .advisor-empty, .lang-ur .advisor-footnote, .lang-ur label {
          text-align: right;
          line-height: 2;
        }

        .mobile-main { flex:1; width:100%; padding:16px 16px calc(84px + env(safe-area-inset-bottom, 0)) 16px; max-width:600px; margin:0 auto; box-sizing:border-box; }

        /* Home */
        .mobile-home-stack { display:flex; flex-direction:column; gap:16px; }
        .mobile-main-balance-card { padding:22px 20px; }
        .mobile-main-balance-card h2 { font-size:20px; margin-bottom:14px; }
        .mobile-main-balance-card .balance-row { gap:12px; }
        .balance-eye-btn { background:none; border:none; color:var(--primary-purple); font-size:22px; cursor:pointer; padding:4px 8px; line-height:1; }
        .mobile-topup-btn { margin-left:auto; padding:8px 14px; font-size:12px; }
        .mobile-quick-actions-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
        .mobile-quick-actions-grid .action-btn { padding:22px 10px; font-size:13px; border-radius:14px; display:flex; flex-direction:column; align-items:center; gap:8px; }
        .mobile-quick-actions-grid .action-btn i { font-size:20px; }
        .mobile-chat-card { padding:18px 20px; border-radius:14px; }
        .mobile-chat-card .chat-text { font-size:17px; }
        .mobile-transactions-card { max-width:100%; padding:18px 16px; border-radius:14px; }
        .mobile-transactions-card .tx-table { font-size:12.5px; }
        .mobile-transactions-card .tx-table th, .mobile-transactions-card .tx-table td { padding:10px 0; }

        /* Analytics / Financial Advisor / Wallet reuse .advisor-wrap and
           .advisor-grid — collapse to one column with phone-sized padding */
        .mobile-main .advisor-wrap { padding:0; max-width:none; }
        .mobile-main .advisor-grid { grid-template-columns:1fr; gap:10px; }
        /* Grid items default to min-width:auto, which lets a card refuse to
           shrink below the intrinsic width of its content and push past the
           screen edge (the "half the card is cut off" bug). min-width:0 +
           width:100% forces every card to obey the single 1fr track instead. */
        .mobile-main .advisor-grid .card { min-width:0; width:100%; box-sizing:border-box; }
        .mobile-main .advisor-grid .card:not(.advisor-summary-card) { padding:14px 12px; }
        .mobile-main .advisor-grid .card h3 { font-size:14px; text-align:left; }
        .mobile-main .advisor-grid .advisor-stat-value { font-size:18px; }
        .mobile-main .advisor-grid .advisor-stat-label { font-size:11px; }

        /* Anomaly Alerts — smaller, tighter cards that fit the phone width
           instead of the desktop-sized padding/icons/text. */
        .mobile-main .anomaly-item { padding:10px; gap:8px; margin-bottom:8px; text-align:left; }
        .mobile-main .anomaly-icon { font-size:14px; }
        .mobile-main .anomaly-icon svg { width:14px; height:14px; }
        .mobile-main .anomaly-item strong { font-size:12.5px; }
        .mobile-main .anomaly-item p { font-size:11.5px; line-height:1.4; }

        /* Subscriptions (and any other wallet-row list) — compact rows with
           the description left-aligned and the amount right-aligned, sized
           to actually fit on a phone instead of desktop-sized type. */
        .mobile-main .wallet-row { padding:10px 0; gap:8px; }
        .mobile-main .wallet-row > div:first-child { text-align:left; }
        .mobile-main .wallet-row > div:first-child strong { font-size:13px; }
        .mobile-main .wallet-row > div:first-child > div { font-size:10.5px; }
        .mobile-main .wallet-row > span { font-size:13px; font-weight:700; text-align:right; white-space:nowrap; }
        .mobile-main .grow-money-grid { grid-template-columns:1fr; gap:14px; }
        .mobile-main .goals-list { grid-template-columns:1fr; }
        .mobile-main .advisor-header { flex-direction:column; align-items:stretch; gap:10px; }
        .mobile-main .grow-money-header { justify-content:flex-start; text-align:left; }
        .mobile-main .advisor-header .topup-btn { align-self:flex-start; }
        .mobile-main .card { padding:18px 16px; border-radius:14px; }
        .mobile-main .pace-compare-row { flex-direction:column; gap:10px; }

        /* Card captions/labels/footnotes use a lighter gray on desktop for a
           softer look, but that low contrast is hard to read on phone
           screens — bump them up to the standard dark text on mobile only. */
        .mobile-main .advisor-stat-label,
        .mobile-main .advisor-empty,
        .mobile-main .advisor-footnote,
        .mobile-main .trend-label,
        .mobile-main .pace-compare-label,
        .mobile-main .checkin-back-btn,
        .mobile-main .goal-withdraw-btn {
          color: var(--text-dark);
        }

        /* Savings goal / investing type pickers — 4 compact boxes per row
           on mobile instead of 2 oversized ones. */
        .mobile-main .goal-type-grid,
        .mobile-main .invest-type-grid {
          grid-template-columns: repeat(4, 1fr);
          gap: 8px;
        }
        .mobile-main .goal-type-btn,
        .mobile-main .invest-type-btn {
          padding: 12px 4px;
          font-size: 10.5px;
          gap: 6px;
        }
        .mobile-main .goal-type-btn i,
        .mobile-main .invest-type-btn i {
          font-size: 16px;
        }

        /* Bottom tab bar — thumb-reachable, replaces the left-nav sidebar */
        .bottom-nav { position:fixed; bottom:0; left:0; right:0; display:flex; background:var(--card); border-top:1px solid rgba(0,0,0,0.08); box-shadow:0 -2px 12px rgba(0,0,0,0.06); z-index:250; padding-bottom:env(safe-area-inset-bottom, 0); }
        .bottom-nav-btn { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; background:none; border:none; padding:9px 4px 8px; color:#9aa0ab; font-size:10.5px; font-weight:600; cursor:pointer; }
        .bottom-nav-btn i { font-size:19px; }
        .bottom-nav-btn.active { color:var(--primary-purple); }

        /* Full-width dropdowns/sheets on phone screens instead of a fixed
           350px box anchored near the edge (which can overflow the viewport) */
        @media (max-width:520px) {
          .reminders-dropdown { left:12px; right:12px; width:auto; top:64px; }
          .toast-notification { left:12px; right:12px; max-width:none; top:64px; }
        }

        /* Modal on phones — kept centered on screen (matches desktop), just
           sized to the viewport instead of docked as a bottom sheet */
        @media (max-width:520px) {
          .modal-overlay { align-items:center; padding:16px; box-sizing:border-box; }
          .modal-box { width:100%; max-width:420px; border-radius:16px; max-height:85vh; padding:22px 18px 24px; }
        }
      `}</style>

      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400;700&display=swap" />

      <div ref={printRef} className="receipt-print" />

      {isMobile ? MobileShell() : DesktopShell()}

      <div className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`} onClick={() => setSidebarOpen(false)} />

      <div className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="profile-avatar" style={{ width: 60, height: 60, fontSize: 20 }}>{userData.initials}</div>
          <span className="profile-name-large">{userData.name}</span>
          <span className="user-id">{t('sidebar_user_id')}: {userData.userId}</span>
          <button className="profile-switch-toggle" onClick={() => alert('Multi-profile support is on our roadmap.')}>{t('sidebar_switch_profile')} <i className="fas fa-chevron-down" /></button>
        </div>
        <ul className="sidebar-nav">
          <li><a onClick={() => { setSidebarOpen(false); setModal({ type: 'profileOverview' }) }}><i className="fas fa-user-circle" /> {t('sidebar_profile')}</a></li>
          <li><a onClick={() => { setSidebarOpen(false); setModal({ type: 'settings' }) }}><i className="fas fa-cog" /> {t('sidebar_settings')}</a></li>
          <li><a onClick={() => { setSidebarOpen(false); setModal({ type: 'security' }) }}><i className="fas fa-shield-alt" /> {t('sidebar_security')}</a></li>
          <li><a onClick={() => { setSidebarOpen(false); setModal({ type: 'financialReports' }) }}><i className="fas fa-chart-line" /> {t('sidebar_reports')}</a></li>
        </ul>
        {isMobile && (
          // Text size control lives in the desktop left-nav sidebar, which
          // doesn't render on mobile — surfaced here instead so the a11y
          // feature stays reachable rather than silently disappearing.
          <div className="text-size-control" style={{ borderTop: '1px solid var(--secondary-purple)', marginTop: 0 }}>
            <span className="text-size-label">{t('text_size')}</span>
            <div className="text-size-btns" role="group" aria-label="Adjust text size">
              <button type="button" className={`text-size-btn ${fontSize === 'small' ? 'active' : ''}`}
                aria-label="Small text" onClick={() => setFontSize('small')}>A-</button>
              <button type="button" className={`text-size-btn ${fontSize === 'default' ? 'active' : ''}`}
                aria-label="Default text size" onClick={() => setFontSize('default')}>A</button>
              <button type="button" className={`text-size-btn ${fontSize === 'large' ? 'active' : ''}`}
                aria-label="Large text" onClick={() => setFontSize('large')}>A+</button>
            </div>
          </div>
        )}
        <div className="sidebar-footer">
          <button className="logout-btn" onClick={handleLogout}>{t('sidebar_logout')}</button>
        </div>
      </div>

      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <button className="modal-close" aria-label="Close dialog" onClick={() => setModal(null)}>×</button>
            {renderModalContent()}
          </div>
        </div>
      )}
    </>
  )

  // ── DESKTOP SHELL (unchanged layout/behavior) ────────────
  function DesktopShell() {
    return (
    <div className={`app-shell ${language === 'ur' ? 'lang-ur' : ''}`}>
        <nav className="left-nav">
          <div className="left-nav-brand">
            <span className="logo-circle">AI</span>
            <span className="left-nav-brand-text">FinBud</span>
          </div>
          <ul className="left-nav-list">
            <li className={activeView === 'home' ? 'active' : ''} onClick={() => { setActiveView('home'); setRemindersOpen(false); setTxNotifOpen(false) }}>
              <i className="fas fa-home" /> <span>{t('nav_home')}</span>
            </li>
            <li className={activeView === 'advisor' ? 'active' : ''} onClick={() => { setActiveView('advisor'); setRemindersOpen(false); setTxNotifOpen(false) }}>
              <i className="fas fa-chart-pie" /> <span>{t('nav_your_analytics')}</span>
            </li>
            <li className={activeView === 'growmymoney' ? 'active' : ''} onClick={() => { setActiveView('growmymoney'); setRemindersOpen(false); setTxNotifOpen(false) }}>
              <i className="fas fa-piggy-bank" /> <span>{t('nav_financial_advisor')}</span>
            </li>
            <li className={activeView === 'wallet' ? 'active' : ''} onClick={() => { setActiveView('wallet'); setRemindersOpen(false); setTxNotifOpen(false) }}>
              <i className="fas fa-wallet" /> <span>{t('nav_wallet')}</span>
            </li>
          </ul>

          <div className="text-size-control">
            <span className="text-size-label">{t('text_size')}</span>
            <div className="text-size-btns" role="group" aria-label="Adjust text size">
              <button type="button" className={`text-size-btn ${fontSize === 'small' ? 'active' : ''}`}
                aria-label="Small text" onClick={() => setFontSize('small')}>A-</button>
              <button type="button" className={`text-size-btn ${fontSize === 'default' ? 'active' : ''}`}
                aria-label="Default text size" onClick={() => setFontSize('default')}>A</button>
              <button type="button" className={`text-size-btn ${fontSize === 'large' ? 'active' : ''}`}
                aria-label="Large text" onClick={() => setFontSize('large')}>A+</button>
            </div>
          </div>
        </nav>

        <div className="main-content">
          <div className={modal || sidebarOpen ? 'blurred' : ''} style={{ minHeight: '100vh' }}>
            <header className="topbar">
              <h1 className="topbar-title">{activeView === 'home' ? 'Dashboard' : activeView === 'advisor' ? 'Your Analytics' : activeView === 'growmymoney' ? 'Financial Advisor' : 'Wallet'}</h1>
              <div className="topbar-right">
                <div className="lang-switcher">
                  <button type="button" className="lang-switcher-btn" aria-label={t('language')} onClick={() => setLangMenuOpen(o => !o)}>
                    <i className="fas fa-globe" /> {{ en: 'EN', ur: 'اردو', roman: 'Roman' }[language]}
                  </button>
                  {langMenuOpen && (
                    <div className="lang-switcher-menu" onClick={e => e.stopPropagation()}>
                      <button type="button" className={language === 'en' ? 'active' : ''} onClick={() => { setLanguage('en'); setLangMenuOpen(false) }}>English</button>
                      <button type="button" className={language === 'ur' ? 'active' : ''} onClick={() => { setLanguage('ur'); setLangMenuOpen(false) }}>اردو</button>
                      <button type="button" className={language === 'roman' ? 'active' : ''} onClick={() => { setLanguage('roman'); setLangMenuOpen(false) }}>Roman Urdu</button>
                    </div>
                  )}
                </div>
                <div className="bell-container" role="button" tabIndex={0} aria-label={`${notifUnreadCount} unread notifications`} onClick={openNotifications}>
                  <i className="fas fa-receipt" />
                  {notifUnreadCount > 0 && <span className="reminder-badge activity-badge">{notifUnreadCount}</span>}
                </div>
                <div className="bell-container" role="button" tabIndex={0} aria-label={`Bill reminders, ${reminders.length} pending`} onClick={() => setRemindersOpen(o => !o)}>
                  <i className="fas fa-bell" />
                  {reminders.length > 0 && <span className="reminder-badge">{reminders.length}</span>}
                </div>
                <div className="profile-area" role="button" tabIndex={0} aria-label="Open account menu" onClick={() => setSidebarOpen(true)}>
                  <span>{userData.name}</span>
                  <div className="profile-avatar">{userData.initials}</div>
                </div>
              </div>
            </header>

            {(txNotifOpen || remindersOpen) && (
              <div className="dropdown-backdrop" onClick={() => { setTxNotifOpen(false); setRemindersOpen(false) }} />
            )}

            {txNotifOpen && (
              <div className="reminders-dropdown activity-dropdown" onClick={e => e.stopPropagation()}>
                <h3><i className="fas fa-receipt" /> {t('bell_activity')}</h3>
                {notifications.length === 0
                  ? <p style={{ fontSize: 13, color: '#999', textAlign: 'center', padding: '10px 0' }}>{t('bell_no_activity')}</p>
                  : notifications.map(n => (
                    <div key={n.id} className={`reminder-item activity-item ${n.is_read ? '' : 'activity-unread'}`}>
                      <div className="activity-msg">{getActivitySummary(n.message)}</div>
                      <div className="activity-time">{new Date(n.created_at).toLocaleString('en-PK', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
                    </div>
                  ))}
              </div>
            )}

            {remindersOpen && (
              <div className="reminders-dropdown" onClick={e => e.stopPropagation()}>
                <h3><i className="fas fa-bell" /> {t('bell_bill_reminders')}</h3>
                {reminders.map((r, i) => {
                  const daysText = r.days_left === 0 ? 'Due Today' : r.days_left < 0 ? `${Math.abs(r.days_left)} days overdue` : `Due in ${r.days_left} day${r.days_left > 1 ? 's' : ''}`
                  return (
                    <div key={i} className={`reminder-item ${r.kind}`}>
                      <div style={{ fontWeight: 600 }}>{r.biller}</div>
                      <div style={{ fontWeight: 700, color: 'var(--primary-purple)' }}>PKR {r.amount.toLocaleString('en-PK')}</div>
                      <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>{daysText} ({r.due_date})</div>
                    </div>
                  )
                })}
              </div>
            )}

            {toast && (
              <div className={`toast-notification toast-${toast.type}`} role="status">
                <i className="fas fa-check-circle" />
                <span>{toast.message}</span>
                <button type="button" aria-label="Dismiss notification" onClick={() => setToast(null)}>×</button>
              </div>
            )}

            {activeView === 'home' ? (
              <main className="dashboard-grid" onClick={() => { setRemindersOpen(false); setTxNotifOpen(false); setOpenMenuId(null) }}>
                <section className="column-left">
                  <div className="main-balance-card">
                    <h2>{t('home_hello')}, {userData.name}!</h2>
                    <p className="balance-label">{t('home_your_balance')}</p>
                    <div className="balance-row">
                      <span className="currency">PKR</span>
                      <strong className="balance-value">{userData.isMasked ? '*****' : formattedBalance}</strong>
                      <button
                        className="balance-eye-btn"
                        aria-label={userData.isMasked ? t('home_show_balance') : t('home_hide_balance')}
                        title={userData.isMasked ? t('home_show_balance') : t('home_hide_balance')}
                        onClick={() => setUserData(u => ({ ...u, isMasked: !u.isMasked }))}
                      >
                        <i className={`fas ${userData.isMasked ? 'fa-eye' : 'fa-eye-slash'}`} />
                      </button>
                      <button className="topup-btn" onClick={() => setModal({ type: 'topup' })}>{t('home_topup')}</button>
                    </div>
                  </div>

                  <div className="quick-actions-grid">
                    <button className="action-btn" onClick={() => { setPendingTransfer(null); setModal({ type: 'sendMoney1' }) }}><i className="fas fa-paper-plane" /><span>{t('action_send_money')}</span></button>
                    <button className="action-btn" onClick={() => { setPendingBill(null); setModal({ type: 'payBill1' }) }}><i className="fas fa-file-invoice-dollar" /><span>{t('action_pay_bill')}</span></button>
                    <button className="action-btn" onClick={() => setModal({ type: 'rewards' })}><i className="fas fa-gift" /><span>{t('action_rewards')}</span></button>
                    <button className="action-btn" onClick={() => setModal({ type: 'redeemPoints' })}><i className="fas fa-coins" /><span>{t('action_redeem_points')}</span></button>
                  </div>
                </section>

                <section className="column-right">
                  <button className="chat-card" onClick={() => navigate('/chat')}>
                    <div className="chat-text">{t('chat_line1')} <br /> {t('chat_line2')}</div>
                    <span style={{ fontSize: 30, fontWeight: 900 }}>→</span>
                  </button>

                  <div className="transactions-card">
                    <div className="tx-card-header">
                      <h3>{t('tx_recent')} <i className="fas fa-chevron-down" style={{ fontSize: 18, marginLeft: 5 }} /></h3>
                      <button className="tx-download-btn" aria-label={t('tx_download_history')} title={t('tx_download_history')} onClick={() => setModal({ type: 'downloadHistory' })}>
                        <i className="fas fa-download" />
                      </button>
                    </div>
                    <table className="tx-table">
                      <colgroup>
                        <col style={{ width: '28%' }} />
                        <col style={{ width: '44%' }} />
                        <col style={{ width: '28%' }} />
                      </colgroup>
                      <thead><tr><th>{t('tx_date')}</th><th>{t('tx_type')}</th><th>{t('tx_amount')}</th></tr></thead>
                      <tbody>
                        {transactions.length === 0
                          ? <tr><td colSpan={3} style={{ textAlign: 'center', color: '#999' }}>{t('tx_empty')}</td></tr>
                          : transactions.map((tx, i) => {
                            const menuId = tx.id ?? `idx-${i}`
                            return (
                              <tr key={menuId}>
                                <td>{tx.date}</td>
                                <td className="tx-desc-cell" title={getTransactionDisplayLabel(tx)}>{getTransactionDisplayLabel(tx)}</td>
                                <td className={tx.amount < 0 ? 'expense-text' : 'income-text'}>PKR {Math.abs(tx.amount).toLocaleString('en-PK')}</td>
                              </tr>
                            )
                          })}
                      </tbody>
                    </table>
                  </div>
                </section>
              </main>
            ) : activeView === 'advisor' ? (
              <main onClick={() => { setRemindersOpen(false); setTxNotifOpen(false); setOpenMenuId(null) }}>
                <AnalyticsView t={t} advisor={advisor} reminders={reminders} breakdownEntries={breakdownEntries} breakdownTotal={breakdownTotal} isMobile={isMobile} simpleMode={simpleMode} speak={speak} setModal={setModal} />
              </main>
            ) : activeView === 'growmymoney' ? (
              <main onClick={() => { setRemindersOpen(false); setTxNotifOpen(false); setOpenMenuId(null) }}>
                <div className="advisor-wrap">
                  <GrowMyMoneySection />
                </div>
              </main>
            ) : (
              <main onClick={() => { setRemindersOpen(false); setTxNotifOpen(false); setOpenMenuId(null) }}>
                <WalletView t={t} wallet={wallet} userData={userData} isMobile={isMobile} speak={speak} setModal={setModal} />
              </main>
            )}
          </div>
        </div>
    </div>
    )
  }

  // ── MOBILE SHELL ──────────────────────────────────────────
  // Structurally different from desktop: sticky compact topbar, bottom
  // tab bar instead of a left sidebar, and single-column stacked cards.
  // Reuses the same sub-view components (AnalyticsView and WalletView,
  // imported from ../components/dashboard/) and the
  // same shared state/handlers as the desktop
  // shell — only the arrangement differs, so Send Money, Pay Bill, and
  // every other action behave identically on either shell.
  function MobileShell() {
    const viewTitle = activeView === 'home' ? t('topbar_dashboard') : activeView === 'advisor' ? t('nav_your_analytics') : activeView === 'growmymoney' ? t('nav_financial_advisor') : t('nav_wallet')
    const LANG_LABELS = { en: 'EN', ur: 'اردو', roman: 'Roman' }
    return (
      <div className={`mobile-shell ${language === 'ur' ? 'lang-ur' : ''}`}>
        <header className="mobile-topbar">
          <div className="mobile-topbar-brand">
            <span className="logo-circle">AI</span>
            <span className="mobile-topbar-brand-text">{activeView === 'home' ? 'FinBud' : viewTitle}</span>
          </div>
          <div className="mobile-topbar-actions">
            <div className="lang-switcher">
              <button type="button" className="lang-switcher-btn" aria-label={t('language')} onClick={() => setLangMenuOpen(o => !o)}>
                <i className="fas fa-globe" /> {LANG_LABELS[language]}
              </button>
              {langMenuOpen && (
                <div className="lang-switcher-menu" onClick={e => e.stopPropagation()}>
                  <button type="button" className={language === 'en' ? 'active' : ''} onClick={() => { setLanguage('en'); setLangMenuOpen(false) }}>English</button>
                  <button type="button" className={language === 'ur' ? 'active' : ''} onClick={() => { setLanguage('ur'); setLangMenuOpen(false) }}>اردو</button>
                  <button type="button" className={language === 'roman' ? 'active' : ''} onClick={() => { setLanguage('roman'); setLangMenuOpen(false) }}>Roman Urdu</button>
                </div>
              )}
            </div>
            <div className="bell-container" role="button" tabIndex={0} aria-label={`${notifUnreadCount} unread notifications`} onClick={openNotifications}>
              <i className="fas fa-receipt" />
              {notifUnreadCount > 0 && <span className="reminder-badge activity-badge">{notifUnreadCount}</span>}
            </div>
            <div className="bell-container" role="button" tabIndex={0} aria-label={`Bill reminders, ${reminders.length} pending`} onClick={() => setRemindersOpen(o => !o)}>
              <i className="fas fa-bell" />
              {reminders.length > 0 && <span className="reminder-badge">{reminders.length}</span>}
            </div>
            <div className="profile-avatar mobile-profile-avatar" role="button" tabIndex={0} aria-label="Open account menu" onClick={() => setSidebarOpen(true)}>
              {userData.initials}
            </div>
          </div>
        </header>

        {(txNotifOpen || remindersOpen) && (
          <div className="dropdown-backdrop" onClick={() => { setTxNotifOpen(false); setRemindersOpen(false) }} />
        )}

        {txNotifOpen && (
          <div className="reminders-dropdown activity-dropdown" onClick={e => e.stopPropagation()}>
            <h3><i className="fas fa-receipt" /> {t('bell_activity')}</h3>
            {notifications.length === 0
              ? <p style={{ fontSize: 13, color: '#999', textAlign: 'center', padding: '10px 0' }}>{t('bell_no_activity')}</p>
              : notifications.map(n => (
                <div key={n.id} className={`reminder-item activity-item ${n.is_read ? '' : 'activity-unread'}`}>
                  <div className="activity-msg">{getActivitySummary(n.message)}</div>
                  <div className="activity-time">{new Date(n.created_at).toLocaleString('en-PK', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
                </div>
              ))}
          </div>
        )}

        {remindersOpen && (
          <div className="reminders-dropdown" onClick={e => e.stopPropagation()}>
            <h3><i className="fas fa-bell" /> {t('bell_bill_reminders')}</h3>
            {reminders.length === 0
              ? <p style={{ fontSize: 13, color: '#999', textAlign: 'center', padding: '10px 0' }}>{t('bell_no_bills')}</p>
              : reminders.map((r, i) => {
                const daysText = r.days_left === 0 ? 'Due Today' : r.days_left < 0 ? `${Math.abs(r.days_left)} days overdue` : `Due in ${r.days_left} day${r.days_left > 1 ? 's' : ''}`
                return (
                  <div key={i} className={`reminder-item ${r.kind}`}>
                    <div style={{ fontWeight: 600 }}>{r.biller}</div>
                    <div style={{ fontWeight: 700, color: 'var(--primary-purple)' }}>PKR {r.amount.toLocaleString('en-PK')}</div>
                    <div style={{ fontSize: 12, marginTop: 4 }}>{daysText}</div>
                  </div>
                )
              })}
          </div>
        )}

        <main className="mobile-main" onClick={() => { setRemindersOpen(false); setTxNotifOpen(false); setOpenMenuId(null) }}>
          {activeView === 'home' ? (
            <div className="mobile-home-stack">
              <div className="main-balance-card mobile-main-balance-card">
                <h2>{t('home_hello')}, {userData.name}!</h2>
                <p className="balance-label">{t('home_your_balance')}</p>
                <div className="balance-row">
                  <span className="currency">PKR</span>
                  <strong className="balance-value">{userData.isMasked ? '*****' : formattedBalance}</strong>
                  <button
                    className="balance-eye-btn"
                    aria-label={userData.isMasked ? 'Show balance' : 'Hide balance'}
                    onClick={() => setUserData(u => ({ ...u, isMasked: !u.isMasked }))}
                  >
                    <i className={`fas ${userData.isMasked ? 'fa-eye' : 'fa-eye-slash'}`} />
                  </button>
                  <button className="topup-btn mobile-topup-btn" onClick={() => setModal({ type: 'topup' })}>{t('home_topup')}</button>
                </div>
              </div>

              <div className="mobile-quick-actions-grid">
                <button className="action-btn" onClick={() => { setPendingTransfer(null); setModal({ type: 'sendMoney1' }) }}><i className="fas fa-paper-plane" /><span>{t('action_send_money')}</span></button>
                <button className="action-btn" onClick={() => { setPendingBill(null); setModal({ type: 'payBill1' }) }}><i className="fas fa-file-invoice-dollar" /><span>{t('action_pay_bill')}</span></button>
                <button className="action-btn" onClick={() => setModal({ type: 'rewards' })}><i className="fas fa-gift" /><span>{t('action_rewards')}</span></button>
                <button className="action-btn" onClick={() => setModal({ type: 'redeemPoints' })}><i className="fas fa-coins" /><span>{t('action_redeem_points')}</span></button>
              </div>

              <button className="chat-card mobile-chat-card" onClick={() => navigate('/chat')}>
                <div className="chat-text">{t('chat_line1')} <br /> {t('chat_line2')}</div>
                <span style={{ fontSize: 26, fontWeight: 900 }}>→</span>
              </button>

              <div className="transactions-card mobile-transactions-card">
                <div className="tx-card-header">
                  <h3>{t('tx_recent')} <i className="fas fa-chevron-down" style={{ fontSize: 16, marginLeft: 5 }} /></h3>
                  <button className="tx-download-btn" aria-label={t('tx_download_history')} title={t('tx_download_history')} onClick={() => setModal({ type: 'downloadHistory' })}>
                    <i className="fas fa-download" />
                  </button>
                </div>
                <table className="tx-table">
                  <colgroup>
                    <col style={{ width: '28%' }} />
                    <col style={{ width: '44%' }} />
                    <col style={{ width: '28%' }} />
                  </colgroup>
                  <thead><tr><th>{t('tx_date')}</th><th>{t('tx_type')}</th><th>{t('tx_amount')}</th></tr></thead>
                  <tbody>
                    {transactions.length === 0
                      ? <tr><td colSpan={3} style={{ textAlign: 'center', color: '#999' }}>{t('tx_empty')}</td></tr>
                      : transactions.map((tx, i) => {
                        const menuId = tx.id ?? `idx-${i}`
                        return (
                          <tr key={menuId}>
                            <td>{tx.date}</td>
                            <td className="tx-desc-cell" title={getTransactionDisplayLabel(tx)}>{getTransactionDisplayLabel(tx)}</td>
                            <td className={tx.amount < 0 ? 'expense-text' : 'income-text'}>PKR {Math.abs(tx.amount).toLocaleString('en-PK')}</td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : activeView === 'advisor' ? (
            <AnalyticsView t={t} advisor={advisor} reminders={reminders} breakdownEntries={breakdownEntries} breakdownTotal={breakdownTotal} isMobile={isMobile} simpleMode={simpleMode} speak={speak} setModal={setModal} />
          ) : activeView === 'growmymoney' ? (
            <div className="advisor-wrap">
              <GrowMyMoneySection />
            </div>
          ) : (
            <WalletView t={t} wallet={wallet} userData={userData} isMobile={isMobile} speak={speak} setModal={setModal} />
          )}
        </main>

        <nav className="bottom-nav">
          <button className={`bottom-nav-btn ${activeView === 'home' ? 'active' : ''}`} onClick={() => { setActiveView('home'); setRemindersOpen(false); setTxNotifOpen(false) }}>
            <i className="fas fa-home" /><span>{t('nav_home')}</span>
          </button>
          <button className={`bottom-nav-btn ${activeView === 'advisor' ? 'active' : ''}`} onClick={() => { setActiveView('advisor'); setRemindersOpen(false); setTxNotifOpen(false) }}>
            <i className="fas fa-chart-pie" /><span>{t('nav_analytics')}</span>
          </button>
          <button className={`bottom-nav-btn ${activeView === 'growmymoney' ? 'active' : ''}`} onClick={() => { setActiveView('growmymoney'); setRemindersOpen(false); setTxNotifOpen(false) }}>
            <i className="fas fa-piggy-bank" /><span>{t('nav_advisor')}</span>
          </button>
          <button className={`bottom-nav-btn ${activeView === 'wallet' ? 'active' : ''}`} onClick={() => { setActiveView('wallet'); setRemindersOpen(false); setTxNotifOpen(false) }}>
            <i className="fas fa-wallet" /><span>{t('nav_wallet')}</span>
          </button>
        </nav>
      </div>
    )
  }
}