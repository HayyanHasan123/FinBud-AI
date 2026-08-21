import { useState, useEffect } from 'react'

// Fixed list mirrors backend/advisor_chat.py's INVESTMENT_TYPES — kept as a
// local fallback so the cards render even before /api/advisor/investing/types
// responds (or if that endpoint isn't live yet).
const FALLBACK_TYPES = [
  { value: 'stocks', label: 'Stocks', icon: 'fa-chart-line' },
  { value: 'mutual_funds', label: 'Mutual Funds', icon: 'fa-layer-group' },
  { value: 'government_bonds', label: 'Government Bonds & Savings', icon: 'fa-landmark' },
  { value: 'gold', label: 'Gold', icon: 'fa-coins' },
  { value: 'fixed_deposits', label: 'Fixed Deposits', icon: 'fa-piggy-bank' },
  { value: 'crypto', label: 'Crypto', icon: 'fa-bitcoin-sign' },
]

const LANGUAGES = [
  { value: 'en', label: 'English', dir: 'ltr' },
  { value: 'ur_roman', label: 'Roman Urdu', dir: 'ltr' },
  { value: 'ur', label: 'اردو', dir: 'rtl' },
]

// Risk-level -> badge color tokens.
const RISK_STYLES = {
  Low: { bg: '#ECFDF5', text: '#047857', ring: '#A7F3D0' },
  Medium: { bg: '#FFFBEB', text: '#B45309', ring: '#FDE68A' },
  'Medium-High': { bg: '#FFF7ED', text: '#C2410C', ring: '#FED7AA' },
  High: { bg: '#FEF2F2', text: '#B91C1C', ring: '#FECACA' },
}

// Core brand colors, matched to the app's existing Savings/Goals section.
const PURPLE = 'var(--primary-purple)'
const GRAY_BG = '#F3F4F6'
const GRAY_BG_SOFT = '#F9FAFB'
const GRAY_TEXT = '#6B7280'
const GRAY_TEXT_DARK = '#374151'
const GRAY_LABEL = '#9CA3AF'

// ---------------------------------------------------------------------------
// Hardcoded, formatted investing guides — replaces the removed
// /api/advisor/investing/guide/:type backend endpoint.
//
// Written in plain, everyday language: no "dividends," "capital gains,"
// "equity," "tenor," "KYC," etc. left unexplained. "How to Start" walks
// through the whole process from someone who has never invested before to
// having their first investment set up. "Risk" is written as a short
// explanation, not just a one-word label.
// ---------------------------------------------------------------------------
const INVESTMENT_GUIDES = {
  stocks: {
    en: {
      overview:
        "When you buy a stock, you're buying a small piece of a real company. If the company does well, your piece becomes worth more — and some companies also pay you a little extra cash now and then, just for holding on to it.",
      howToStart: [
        "Get your CNIC ready — you'll need it to prove who you are",
        'Choose a bank or investment app that lets you buy stocks (several big banks and apps in Pakistan offer this)',
        'Fill out a simple form with your basic details and CNIC to open the account — approval usually takes a day or two',
        'Transfer some money from your regular bank account into this new investment account',
        'Look through a list of companies, pick one or two well-known ones to start with, and place your first buy order — the app will walk you through it step by step',
        "Check in on your app every so often to see how it's doing — you don't need to check it every day",
      ],
      risk: {
        level: 'Medium-High',
        note:
          "This means the value of your money can go up and down quite a bit — sometimes even within the same week. If the company does well, you could earn good money; if it struggles, you could lose some of what you put in. It's best used for money you won't need for at least a few years, so you have time to ride out the ups and downs.",
      },
      minCapital: 'You can start with as little as PKR 5,000–10,000',
    },
    ur_roman: {
      overview:
        "Jab aap stock khareedte hain, to aap kisi asli company ka aik chhota hissa khareed rahe hote hain. Agar company acha perform kare, to aapka hissa ziada qeemti ho jata hai — aur kuch companies sirf shares rakhne par bhi thora extra paisa dete hain.",
      howToStart: [
        'Apni CNIC tayyar rakhein — apni pehchan sabit karne ke liye zaroorat paray gi',
        'Koi bank ya investment app chunein jo stocks khareedne dete hain (Pakistan mein kaee baray banks aur apps yeh offer karte hain)',
        'Apni basic details aur CNIC ke sath aik simple form bhar kar account kholain — approve hone mein aam tor par aik do din lagte hain',
        'Apne regular bank account se is nayi investment account mein kuch paisay transfer karein',
        'Companies ki list dekhein, shuru mein aik ya do mashhoor companies chunein, aur apna pehla khareed order dein — app aapko step by step guide karega',
        'Uske baad, bas kabhi kabhi apni app check kar lein ke aapka paisa kaisa perform kar raha hai — roz check karne ki zaroorat nahi',
      ],
      risk: {
        level: 'Medium-High',
        note:
          'Iska matlab hai ke aapki investment ki qeemat kaafi upar neechay ja sakti hai — kabhi kabhi to usi hafte mein. Agar company acha perform kare to aap acha paisa kama sakte hain; agar mushkil mein ho to aap apni lagai hui raqam ka kuch hissa kho sakte hain. Yeh us paisay ke liye behtar hai jo aapko kam az kam kuch saal tak zaroorat na ho, taake aapke pas ups and downs jhelnay ka waqt ho.',
      },
      minCapital: 'Aap sirf PKR 5,000–10,000 se shuru kar sakte hain',
    },
    ur: {
      overview:
        'جب آپ اسٹاک خریدتے ہیں تو آپ کسی حقیقی کمپنی کا ایک چھوٹا سا حصہ خریدتے ہیں۔ اگر کمپنی اچھی کارکردگی دکھائے تو آپ کا حصہ زیادہ قیمتی ہو جاتا ہے — اور بعض کمپنیاں صرف حصص رکھنے پر بھی تھوڑا اضافی پیسہ دیتی ہیں۔',
      howToStart: [
        'اپنا شناختی کارڈ تیار رکھیں — اپنی شناخت ثابت کرنے کے لیے ضرورت پڑے گی',
        'کوئی بینک یا انویسٹمنٹ ایپ چنیں جو اسٹاکس خریدنے دیتی ہے (پاکستان میں کئی بڑے بینک اور ایپس یہ سہولت دیتے ہیں)',
        'اپنی بنیادی تفصیلات اور شناختی کارڈ کے ساتھ ایک آسان فارم بھر کر اکاؤنٹ کھولیں — منظوری میں عام طور پر ایک دو دن لگتے ہیں',
        'اپنے عام بینک اکاؤنٹ سے اس نئے انویسٹمنٹ اکاؤنٹ میں کچھ رقم منتقل کریں',
        'کمپنیوں کی فہرست دیکھیں، شروع میں ایک یا دو مشہور کمپنیاں چنیں، اور اپنا پہلا خریداری آرڈر دیں — ایپ آپ کو مرحلہ وار رہنمائی دے گی',
        'اس کے بعد، بس کبھی کبھار اپنی ایپ چیک کر لیں کہ آپ کا پیسہ کیسی کارکردگی دکھا رہا ہے — روزانہ چیک کرنے کی ضرورت نہیں',
      ],
      risk: {
        level: 'Medium-High',
        note:
          'اس کا مطلب ہے کہ آپ کی سرمایہ کاری کی قیمت کافی اوپر نیچے جا سکتی ہے — کبھی کبھی تو اسی ہفتے میں۔ اگر کمپنی اچھی کارکردگی دکھائے تو آپ اچھا پیسہ کما سکتے ہیں؛ اگر مشکل میں ہو تو آپ اپنی لگائی ہوئی رقم کا کچھ حصہ کھو سکتے ہیں۔ یہ اس رقم کے لیے بہتر ہے جس کی آپ کو کم از کم چند سال تک ضرورت نہ ہو، تاکہ آپ کے پاس اتار چڑھاؤ برداشت کرنے کا وقت ہو۔',
      },
      minCapital: 'آپ صرف PKR 5,000 سے 10,000 سے شروع کر سکتے ہیں',
    },
  },

  mutual_funds: {
    en: {
      overview:
        "Instead of picking companies yourself, you give your money to a professional team who spreads it across many different options for you — so your money isn't all sitting in one place.",
      howToStart: [
        'Decide roughly how comfortable you are with risk — safer and steady, or open to more ups and downs for potentially more growth',
        'Pick an investment company or app that offers this option and matches the risk level you chose',
        'Open an account with your CNIC and basic bank details — most of this can be done online now',
        'Choose whether you want to put in one lump sum now, or a small fixed amount automatically every month',
        'Confirm your first payment — after that, the professional team decides where your money actually goes',
        "Check in every few months to see how it's growing; you don't need to manage it day to day",
      ],
      risk: {
        level: 'Medium',
        note:
          'The risk depends on which option you pick. Safer choices barely move and are close to guaranteed; growth-focused choices can go up and down more, similar to stocks — but your money is spread across many companies instead of just one, which makes it steadier overall.',
      },
      minCapital: 'Many let you start with just PKR 5,000, or around PKR 1,000 a month',
    },
    ur_roman: {
      overview:
        "Khud companies chunne ki bajaye, aap apni raqam aik professional team ko dete hain jo usay kaee mukhtalif jaghon par lagati hai — is tarah aapki poori raqam aik hi jaga nahi hoti.",
      howToStart: [
        'Pehle yeh tay karein ke aap kitna risk lena comfortable hain — mehfooz aur steady, ya zyada ups and downs ke sath zyada growth ka mauka',
        'Koi investment company ya app chunein jo yeh option offer karti ho aur aapke chunay huay risk level se match kare',
        'Apni CNIC aur basic bank details ke sath account kholain — ab aksar yeh sab online ho sakta hai',
        'Faisla karein ke aap aik hi baar mein lump sum dalain, ya har mahina choti fixed raqam automatic dalain',
        'Apni pehli payment confirm karein — uske baad, professional team ye tay karti hai ke aapka paisa asal mein kahan lagaya jaye',
        'Chand mahinon baad apna account check karein ke yeh kaisa barh raha hai; roz manage karne ki zaroorat nahi',
      ],
      risk: {
        level: 'Medium',
        note:
          'Risk is baat par depend karta hai ke aap kaunsa option chunte hain. Mehfooz options mushkil se hilte hain aur taqreeban guaranteed hote hain; growth-focused options stocks ki tarah zyada upar neechay ja sakte hain — lekin aapka paisa kaee companies mein baant diya jata hai na ke sirf aik mein, jo overall isay zyada steady bana deta hai.',
      },
      minCapital: 'Kaee options sirf PKR 5,000 se shuru hone dete hain, ya taqreeban PKR 1,000 mahana se',
    },
    ur: {
      overview:
        'خود کمپنیاں چننے کے بجائے، آپ اپنی رقم ایک ماہر ٹیم کو دیتے ہیں جو اسے کئی مختلف جگہوں پر لگاتی ہے — اس طرح آپ کی پوری رقم ایک ہی جگہ نہیں ہوتی۔',
      howToStart: [
        'پہلے یہ طے کریں کہ آپ کتنا رسک لینے میں آرام دہ ہیں — محفوظ اور مستحکم، یا زیادہ اتار چڑھاؤ کے ساتھ زیادہ ترقی کا موقع',
        'کوئی انویسٹمنٹ کمپنی یا ایپ چنیں جو یہ آپشن پیش کرتی ہو اور آپ کے چنے ہوئے رسک لیول سے میل کھاتی ہو',
        'اپنے شناختی کارڈ اور بنیادی بینک تفصیلات کے ساتھ اکاؤنٹ کھولیں — اب اکثر یہ سب آن لائن ہو سکتا ہے',
        'فیصلہ کریں کہ آپ ایک ہی بار میں یک مشت رقم لگائیں، یا ہر ماہ چھوٹی مقررہ رقم خودکار طریقے سے لگائیں',
        'اپنی پہلی ادائیگی کی تصدیق کریں — اس کے بعد، ماہر ٹیم یہ طے کرتی ہے کہ آپ کا پیسہ اصل میں کہاں لگایا جائے',
        'چند ماہ بعد اپنا اکاؤنٹ چیک کریں کہ یہ کیسے بڑھ رہا ہے؛ روزانہ مینیج کرنے کی ضرورت نہیں',
      ],
      risk: {
        level: 'Medium',
        note:
          'رسک اس بات پر منحصر ہے کہ آپ کون سا آپشن چنتے ہیں۔ محفوظ آپشنز مشکل سے حرکت کرتے ہیں اور تقریباً یقینی ہوتے ہیں؛ ترقی پر مرکوز آپشنز اسٹاکس کی طرح زیادہ اوپر نیچے جا سکتے ہیں — لیکن آپ کا پیسہ کئی کمپنیوں میں بٹا ہوتا ہے نہ کہ صرف ایک میں، جو مجموعی طور پر اسے زیادہ مستحکم بنا دیتا ہے۔',
      },
      minCapital: 'کئی آپشنز صرف PKR 5,000 سے شروع ہونے دیتے ہیں، یا تقریباً PKR 1,000 ماہانہ سے',
    },
  },

  government_bonds: {
    en: {
      overview:
        'You lend your money to the Government of Pakistan for a set amount of time. In return, they pay it back with a little extra on top — one of the safest ways to grow savings.',
      howToStart: [
        "Decide how long you're comfortable keeping your money untouched — a few months, a year, or longer",
        'Take your CNIC to a National Savings Centre or any authorized bank near you',
        "Ask the staff which certificate matches how long you want to save for — they'll walk you through the exact paperwork",
        'Fill out the form and hand over the amount you want to save',
        "Keep the certificate they give you safe — it's proof of your savings",
        "On the date they tell you, go back to collect your extra money, or let it continue if you'd rather keep saving",
      ],
      risk: {
        level: 'Low',
        note:
          "This is about as safe as investing gets in Pakistan, since the government itself is promising to pay you back. The only real risk is that if you need your money back early, you might lose some of the extra amount you would've earned by waiting it out.",
      },
      minCapital: 'You can start with as little as PKR 500–5,000',
    },
    ur_roman: {
      overview:
        'Aap apni raqam aik muqarrarah waqt ke liye Hakoomat-e-Pakistan ko udhaar dete hain. Badle mein wo aapko waapis thora extra paisa ke sath dete hain — savings barhane ka aik sab se mehfooz tareeqa.',
      howToStart: [
        'Tay karein ke aap kitne arsay ke liye apni raqam bagair chhue rakhna chahte hain — chand mahinay, aik saal, ya usse zyada',
        'Apni CNIC lekar apne qareeb ke National Savings Centre ya kisi authorized bank jayein',
        'Staff se poochein ke kaunsa certificate aapke chunay huay arsay se match karta hai — wo aapko poora paperwork samjha denge',
        'Form bharein aur jo raqam save karna chahte hain wo jama karwayein',
        'Jo certificate wo aapko dein usay mehfooz rakhein — yeh aapki saving ka saboot hai',
        'Jo tareekh wo batayein, us din waapis ja kar apni extra raqam le lein, ya agar aap chahein to isay aagay bhi chalne dein',
      ],
      risk: {
        level: 'Low',
        note:
          'Yeh Pakistan mein invest karne ka taqreeban sab se mehfooz tareeqa hai, kyunke khud hakoomat aapko waapis paisa dene ka waada karti hai. Sirf aik risk yeh hai ke agar aapko apni raqam jaldi wapis chahiye ho, to ho sakta hai aapko wo extra raqam na mile jo poora intezaar karne par milti.',
      },
      minCapital: 'Aap sirf PKR 500–5,000 se shuru kar sakte hain',
    },
    ur: {
      overview:
        'آپ اپنی رقم ایک مقررہ وقت کے لیے حکومتِ پاکستان کو ادھار دیتے ہیں۔ بدلے میں وہ آپ کو تھوڑی اضافی رقم کے ساتھ واپس کرتی ہے — بچت بڑھانے کا ایک محفوظ ترین طریقہ۔',
      howToStart: [
        'طے کریں کہ آپ کتنے عرصے کے لیے اپنی رقم بغیر چھوئے رکھنا چاہتے ہیں — چند ماہ، ایک سال، یا اس سے زیادہ',
        'اپنا شناختی کارڈ لے کر اپنے قریبی نیشنل سیونگز سینٹر یا کسی مجاز بینک جائیں',
        'عملے سے پوچھیں کہ کون سا سرٹیفکیٹ آپ کے چنے ہوئے عرصے سے میل کھاتا ہے — وہ آپ کو پورا طریقہ کار سمجھا دیں گے',
        'فارم بھریں اور جو رقم بچانا چاہتے ہیں وہ جمع کروائیں',
        'جو سرٹیفکیٹ وہ آپ کو دیں اسے محفوظ رکھیں — یہ آپ کی بچت کا ثبوت ہے',
        'جو تاریخ وہ بتائیں، اس دن واپس جا کر اپنی اضافی رقم لے لیں، یا اگر چاہیں تو اسے آگے بھی جاری رہنے دیں',
      ],
      risk: {
        level: 'Low',
        note:
          'یہ پاکستان میں سرمایہ کاری کرنے کا تقریباً سب سے محفوظ طریقہ ہے، کیونکہ خود حکومت آپ کو رقم واپس کرنے کا وعدہ کرتی ہے۔ صرف ایک خطرہ یہ ہے کہ اگر آپ کو اپنی رقم جلدی واپس چاہیے ہو، تو ممکن ہے آپ کو وہ اضافی رقم نہ ملے جو پورا انتظار کرنے پر ملتی۔',
      },
      minCapital: 'آپ صرف PKR 500 سے 5,000 سے شروع کر سکتے ہیں',
    },
  },

  gold: {
    en: {
      overview:
        'Gold has held its value in Pakistan for generations. You can own real gold — jewelry, coins, or bars — or buy small amounts of digital gold through an app, without needing to store anything yourself.',
      howToStart: [
        'Decide if you want real gold you can hold, or a smaller digital amount through an app',
        'If buying real gold: find a trusted jeweler or bank that gives you a proper certificate',
        'If buying digital gold: download the app, verify your identity, and add money to buy however much you want',
        "Check that day's gold price before buying, so you know exactly what you're paying for",
        "If it's real gold, store it somewhere safe like a bank locker rather than at home",
        "Whenever you want your money back, sell it back at the jeweler, bank, or app — you'll get whatever the price is that day",
      ],
      risk: {
        level: 'Medium',
        note:
          "Gold usually doesn't crash suddenly, but its price does move up and down with world markets and the rupee's value against the dollar. It's generally seen as a safer choice than stocks, but it's not guaranteed to always go up, and there can be slow stretches where the price barely moves.",
      },
      minCapital: "Digital gold can start from just a few thousand rupees; physical gold costs whatever 1 gram is priced at that day",
    },
    ur_roman: {
      overview:
        'Sona Pakistan mein naslon se apni qeemat rakhta aaya hai. Aap asli sona — zevraat, sikkay, ya bars — rakh sakte hain, ya app ke zariye chota sa digital sona khareed sakte hain, bagair kuch physically sambhalay.',
      howToStart: [
        'Tay karein ke aap asli sona chahte hain jise haath mein pakar sakein, ya app ke zariye chota digital amount',
        'Agar asli sona khareedna hai: koi bharosemand jeweler ya bank dhoondein jo sahi certificate de',
        'Agar digital gold khareedna hai: app download karein, apni pehchan verify karein, aur jitna chahein utna khareedne ke liye paisay dalain',
        'Khareedne se pehle us din ki sona qeemat check kar lein, taake pata ho aap kya qeemat de rahe hain',
        'Agar asli sona hai, to usay ghar ki bajaye bank locker jaisi mehfooz jaga par rakhein',
        'Jab bhi apna paisa waapis chahiye, usay jeweler, bank, ya app par waapis bech dein — us din ki qeemat par jo bhi ho',
      ],
      risk: {
        level: 'Medium',
        note:
          'Sona aksar achanak crash nahi hota, lekin iski qeemat world markets aur rupee ki dollar ke muqable value ke sath upar neechay hoti rehti hai. Yeh aam tor par stocks se zyada mehfooz mana jata hai, lekin hamesha upar jane ki guarantee nahi hoti, aur kabhi kabhi lambay arsay tak qeemat mushkil se harkat karti hai.',
      },
      minCapital: 'Digital gold chand hazar rupay se shuru ho sakta hai; physical sona us din ki 1 gram qeemat ke barabar hoga',
    },
    ur: {
      overview:
        'سونا پاکستان میں نسلوں سے اپنی قدر برقرار رکھے ہوئے ہے۔ آپ اصلی سونا — زیورات، سکے، یا بارز — رکھ سکتے ہیں، یا ایپ کے ذریعے تھوڑا سا ڈیجیٹل سونا خرید سکتے ہیں، بغیر کچھ خود سنبھالے۔',
      howToStart: [
        'طے کریں کہ آپ اصلی سونا چاہتے ہیں جسے ہاتھ میں پکڑ سکیں، یا ایپ کے ذریعے تھوڑی ڈیجیٹل مقدار',
        'اگر اصلی سونا خریدنا ہے: کوئی قابلِ اعتماد جیولر یا بینک ڈھونڈیں جو صحیح سرٹیفکیٹ دے',
        'اگر ڈیجیٹل گولڈ خریدنا ہے: ایپ ڈاؤن لوڈ کریں، اپنی شناخت ثابت کریں، اور جتنا چاہیں اتنا خریدنے کے لیے رقم ڈالیں',
        'خریدنے سے پہلے اس دن کی سونے کی قیمت چیک کر لیں، تاکہ پتا ہو آپ کیا قیمت دے رہے ہیں',
        'اگر اصلی سونا ہے، تو اسے گھر کی بجائے بینک لاکر جیسی محفوظ جگہ پر رکھیں',
        'جب بھی اپنا پیسہ واپس چاہیے، اسے جیولر، بینک، یا ایپ پر واپس بیچ دیں — اس دن کی قیمت پر جو بھی ہو',
      ],
      risk: {
        level: 'Medium',
        note:
          'سونا اکثر اچانک کریش نہیں ہوتا، لیکن اس کی قیمت عالمی مارکیٹس اور روپے کی ڈالر کے مقابلے قدر کے ساتھ اوپر نیچے ہوتی رہتی ہے۔ یہ عام طور پر اسٹاکس سے زیادہ محفوظ سمجھا جاتا ہے، لیکن ہمیشہ اوپر جانے کی ضمانت نہیں ہوتی، اور کبھی کبھار لمبے عرصے تک قیمت مشکل سے حرکت کرتی ہے۔',
      },
      minCapital: 'ڈیجیٹل گولڈ چند ہزار روپے سے شروع ہو سکتا ہے؛ فزیکل سونے کی قیمت اس دن کے 1 گرام کے برابر ہوگی',
    },
  },

  fixed_deposits: {
    en: {
      overview:
        'You give the bank a set amount of money for a fixed period, and they promise to pay it back with a little extra on top — simple, predictable, and low-effort.',
      howToStart: [
        'Decide how much money you can set aside without needing to touch it for a while',
        'Visit your bank, or open one through their app if they offer it',
        'Choose how long you want to lock it in for — anywhere from 1 month to 5 years',
        "Ask what extra amount they'll pay you for each option, and pick the one that suits you best",
        'Deposit your money and keep the certificate or receipt they give you safe',
        'On the date it matures, collect your money plus the extra amount — or roll it into a new deposit if you want to keep saving',
      ],
      risk: {
        level: 'Low',
        note:
          "This is one of the safest ways to grow your money, since the bank agrees upfront exactly how much extra you'll get and doesn't change it later. The main downside is that if you need your money out early, you may lose some or all of the extra amount you would have earned.",
      },
      minCapital: 'Most banks let you start with PKR 10,000–50,000',
    },
    ur_roman: {
      overview:
        'Aap bank ko aik muqarrarah muddat ke liye aik fixed raqam dete hain, aur wo waada karte hain ke usay thora extra paisa ke sath waapis karenge — simple, predictable, aur bagair mehnat ke.',
      howToStart: [
        'Tay karein ke kitni raqam aap bagair chhue kuch arsay ke liye alag rakh sakte hain',
        'Apne bank jayein, ya agar wo offer karte hain to unki app ke zariye kholain',
        'Chunein ke kitne arsay ke liye lock karna chahte hain — 1 mahina se 5 saal tak kuch bhi',
        'Poochein ke har option par wo kitni extra raqam denge, aur jo aapko suit kare wo chunein',
        'Apni raqam jama karwayein aur jo certificate ya receipt mile usay mehfooz rakhein',
        'Jab yeh maturity par pohanche, apni raqam extra amount samait le lein — ya agar aap saving jari rakhna chahte hain to isay dobara invest kar dein',
      ],
      risk: {
        level: 'Low',
        note:
          'Yeh apna paisa barhane ke sab se mehfooz tareeqon mein se aik hai, kyunke bank pehle hi tay kar leta hai ke aapko kitni extra raqam milegi aur baad mein isay badalta nahi. Sabse bari mushkil yeh hai ke agar aapko jaldi paisa nikalna paray, to ho sakta hai aap kuch ya sari extra raqam kho dein jo aapko poora intezaar karne par milti.',
      },
      minCapital: 'Zyada tar banks PKR 10,000–50,000 se shuru karne dete hain',
    },
    ur: {
      overview:
        'آپ بینک کو ایک مقررہ مدت کے لیے ایک فکسڈ رقم دیتے ہیں، اور وہ وعدہ کرتے ہیں کہ اسے تھوڑی اضافی رقم کے ساتھ واپس کریں گے — آسان، قابلِ پیش گوئی، اور بغیر کسی محنت کے۔',
      howToStart: [
        'طے کریں کہ کتنی رقم آپ بغیر چھوئے کچھ عرصے کے لیے الگ رکھ سکتے ہیں',
        'اپنے بینک جائیں، یا اگر وہ پیش کرتے ہیں تو ان کی ایپ کے ذریعے کھولیں',
        'طے کریں کہ کتنے عرصے کے لیے لاک کرنا چاہتے ہیں — 1 ماہ سے 5 سال تک کچھ بھی',
        'پوچھیں کہ ہر آپشن پر وہ کتنی اضافی رقم دیں گے، اور جو آپ کو موزوں لگے وہ چنیں',
        'اپنی رقم جمع کروائیں اور جو سرٹیفکیٹ یا رسید ملے اسے محفوظ رکھیں',
        'جب یہ میعاد مکمل ہو، اپنی رقم اضافی رقم سمیت لے لیں — یا اگر آپ بچت جاری رکھنا چاہتے ہیں تو اسے دوبارہ لگا دیں',
      ],
      risk: {
        level: 'Low',
        note:
          'یہ اپنا پیسہ بڑھانے کے سب سے محفوظ طریقوں میں سے ایک ہے، کیونکہ بینک پہلے ہی طے کر لیتا ہے کہ آپ کو کتنی اضافی رقم ملے گی اور بعد میں اسے بدلتا نہیں۔ سب سے بڑی مشکل یہ ہے کہ اگر آپ کو جلدی پیسہ نکالنا پڑے، تو ممکن ہے آپ کچھ یا ساری اضافی رقم کھو دیں جو آپ کو پورا انتظار کرنے پر ملتی۔',
      },
      minCapital: 'زیادہ تر بینک PKR 10,000 سے 50,000 سے شروع کرنے دیتے ہیں',
    },
  },

  crypto: {
    en: {
      overview:
        "Crypto (like Bitcoin) is digital money that isn't controlled by any bank or government. Pakistan recently introduced new rules and a watchdog body to keep an eye on crypto companies — but it's still very new and can be confusing.",
      howToStart: [
        "Understand this is a high-risk option — only continue if you're comfortable with that",
        "Check which platforms are officially approved under Pakistan's new crypto rules before choosing one",
        'Sign up and complete their identity verification process',
        "Start with a very small amount you're fully okay losing, just to understand how it works",
        'Turn on extra security features like two-step verification right away',
        'Keep a close eye on price changes, since crypto can move a lot in a single day — never invest money you need for daily expenses',
      ],
      risk: {
        level: 'High',
        note:
          "This is the riskiest option here by far. Prices can jump up or crash down by a large amount in a single day, sometimes with little warning. Pakistan's rules around crypto are also still being finalized, so there's uncertainty beyond just the price. Only ever use money you could fully afford to lose.",
      },
      minCapital: "There's no fixed minimum — but only put in money you're fully prepared to lose",
    },
    ur_roman: {
      overview:
        "Crypto (jaise Bitcoin) aik digital paisa hai jo kisi bank ya hakoomat ke control mein nahi hota. Pakistan ne hal hi mein naye rules aur crypto companies par nazar rakhne wala aik idara banaya hai — lekin yeh abhi bhi bohat naya aur confusing ho sakta hai.",
      howToStart: [
        'Samjhein ke yeh aik high-risk option hai — sirf tab aagay barhein agar aap is se comfortable hain',
        'Koi platform chunne se pehle check karein ke wo Pakistan ke naye crypto rules ke tehat officially approved hai',
        'Sign up karein aur unka identity verification process complete karein',
        'Bohat choti raqam se shuru karein jise kho kar bhi aap poori tarah theek hon, sirf yeh samajhne ke liye ke yeh kaise kaam karta hai',
        'Turant extra security features (jaise two-step verification) on kar dein',
        'Qeematon par nazar rakhein, kyunke crypto aik hi din mein kaafi badal sakta hai — kabhi bhi wo paisa invest na karein jo aapko rozana kharch ke liye chahiye',
      ],
      risk: {
        level: 'High',
        note:
          'Yeh yahan sab se zyada risky option hai. Qeematain aik hi din mein bohat zyada upar ja sakti hain ya crash ho sakti hain, kabhi kabhi bina zyada warning ke. Pakistan mein crypto ke rules bhi abhi tay ho rahe hain, is liye sirf qeemat hi nahi balke aur bhi uncertainty hai. Sirf wahi paisa istemal karein jise kho kar bhi aap poori tarah theek hon.',
      },
      minCapital: 'Koi fixed minimum nahi hai — lekin sirf itni raqam dalain jo aap poori tarah kho sakte hain',
    },
    ur: {
      overview:
        'کرپٹو (جیسے بٹ کوائن) ایک ڈیجیٹل رقم ہے جو کسی بینک یا حکومت کے کنٹرول میں نہیں ہوتی۔ پاکستان نے حال ہی میں نئے قوانین اور کرپٹو کمپنیوں پر نظر رکھنے والا ایک ادارہ بنایا ہے — لیکن یہ ابھی بھی بہت نیا اور الجھا ہوا ہو سکتا ہے۔',
      howToStart: [
        'سمجھیں کہ یہ ایک ہائی رسک آپشن ہے — صرف تب آگے بڑھیں اگر آپ اس سے آرام دہ ہیں',
        'کوئی پلیٹ فارم چننے سے پہلے چیک کریں کہ وہ پاکستان کے نئے کرپٹو قوانین کے تحت باقاعدہ منظور شدہ ہے',
        'سائن اپ کریں اور ان کا شناختی تصدیقی عمل مکمل کریں',
        'بہت چھوٹی رقم سے شروعات کریں جسے کھو کر بھی آپ مکمل طور پر ٹھیک ہوں، صرف یہ سمجھنے کے لیے کہ یہ کیسے کام کرتا ہے',
        'فوراً اضافی سیکیورٹی فیچرز (جیسے ٹو اسٹیپ ویریفیکیشن) آن کر دیں',
        'قیمتوں پر نظر رکھیں، کیونکہ کرپٹو ایک ہی دن میں کافی بدل سکتا ہے — کبھی بھی وہ رقم سرمایہ کاری نہ کریں جو آپ کو روزانہ خرچ کے لیے چاہیے',
      ],
      risk: {
        level: 'High',
        note:
          'یہ یہاں سب سے زیادہ خطرناک آپشن ہے۔ قیمتیں ایک ہی دن میں بہت زیادہ اوپر جا سکتی ہیں یا کریش ہو سکتی ہیں، کبھی کبھی بغیر زیادہ وارننگ کے۔ پاکستان میں کرپٹو کے قوانین بھی ابھی طے ہو رہے ہیں، اس لیے صرف قیمت ہی نہیں بلکہ اور بھی غیر یقینی صورتحال ہے۔ صرف وہی رقم استعمال کریں جسے کھو کر بھی آپ مکمل طور پر ٹھیک ہوں۔',
      },
      minCapital: 'کوئی مقررہ کم از کم رقم نہیں — لیکن صرف اتنی رقم لگائیں جسے آپ مکمل طور پر کھو سکتے ہیں',
    },
  },
}

const SECTION_LABELS = {
  en: { overview: 'What is it?', howToStart: 'How to Start in Pakistan', risk: 'Risk Level', minCapital: 'Minimum Amount' },
  ur_roman: { overview: 'Yeh Kya Hai?', howToStart: 'Pakistan Mein Kaise Shuru Karein', risk: 'Risk Level', minCapital: 'Kam Az Kam Raqam' },
  ur: { overview: 'یہ کیا ہے؟', howToStart: 'پاکستان میں کیسے شروع کریں', risk: 'خطرے کی سطح', minCapital: 'کم از کم رقم' },
}

const DISCLAIMER = {
  en: 'This is educational information, not formal financial advice.',
  ur_roman: 'Yeh sirf maloomat ke liye hai, koi rasmi financial advice nahi.',
  ur: 'یہ صرف تعلیمی معلومات ہیں، کوئی باقاعدہ مالی مشورہ نہیں۔',
}

function fmt(n) {
  return `PKR ${Math.round(n || 0).toLocaleString('en-PK')}`
}

// ---------------------------------------------------------------------------
// Inline style objects. Using plain inline styles (instead of Tailwind
// classNames) here on purpose — it guarantees this component renders
// correctly regardless of whether Tailwind's build is scanning this file,
// and it lets us match the app's existing Savings/Goals section exactly.
// ---------------------------------------------------------------------------
const S = {
  outer: {
    width: '100%',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: '24px',
    padding: '32px',
    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
  },
  headingWrap: {
    textAlign: 'center',
    marginBottom: '24px',
  },
  heading: {
    fontSize: '24px',
    fontWeight: 700,
    color: PURPLE,
    margin: 0,
  },
  subtitle: {
    fontSize: '14px',
    color: GRAY_TEXT,
    marginTop: '8px',
    maxWidth: '440px',
    marginLeft: 'auto',
    marginRight: 'auto',
    lineHeight: 1.5,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
    gap: '16px',
  },
  typeCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    backgroundColor: GRAY_BG,
    borderRadius: '12px',
    padding: '22px 12px',
    minHeight: '96px',
    textAlign: 'center',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  typeCardIcon: {
    fontSize: '20px',
    color: PURPLE,
  },
  typeCardLabel: {
    fontSize: '14px',
    fontWeight: 600,
    color: PURPLE,
  },
  skeleton: {
    height: '96px',
    borderRadius: '12px',
    backgroundColor: GRAY_BG,
  },
  footNote: {
    textAlign: 'center',
    fontSize: '12px',
    color: GRAY_LABEL,
    marginTop: '20px',
  },
  backButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '14px',
    fontWeight: 500,
    color: GRAY_TEXT,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    marginBottom: '20px',
    padding: 0,
    fontFamily: 'inherit',
  },
  detailHeaderWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    marginBottom: '20px',
  },
  detailIconCircle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '56px',
    height: '56px',
    borderRadius: '16px',
    backgroundColor: GRAY_BG,
    color: PURPLE,
    fontSize: '22px',
    marginBottom: '12px',
  },
  detailTitle: {
    fontSize: '20px',
    fontWeight: 700,
    color: PURPLE,
    margin: 0,
  },
  langSwitchWrap: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: '24px',
  },
  langSwitch: {
    display: 'inline-flex',
    padding: '4px',
    borderRadius: '999px',
    backgroundColor: GRAY_BG,
  },
  langButton: (active) => ({
    padding: '7px 16px',
    borderRadius: '999px',
    fontSize: '13px',
    fontWeight: 500,
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    backgroundColor: active ? '#fff' : 'transparent',
    color: active ? PURPLE : GRAY_TEXT,
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
  }),
  section: {
    backgroundColor: GRAY_BG_SOFT,
    borderRadius: '16px',
    padding: '20px',
    marginBottom: '14px',
  },
  sectionLabel: {
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: GRAY_LABEL,
    marginBottom: '10px',
  },
  sectionLabelRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '10px',
  },
  bodyText: {
    color: GRAY_TEXT_DARK,
    lineHeight: 1.65,
    margin: 0,
    fontSize: '14.5px',
  },
  stepList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  stepRow: (rtl) => ({
    display: 'flex',
    flexDirection: rtl ? 'row-reverse' : 'row',
    alignItems: 'flex-start',
    gap: '12px',
  }),
  stepNumber: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    borderRadius: '999px',
    backgroundColor: PURPLE,
    color: '#fff',
    fontSize: '11px',
    fontWeight: 700,
    marginTop: '2px',
  },
  stepText: {
    color: GRAY_TEXT_DARK,
    lineHeight: 1.6,
    fontSize: '14.5px',
  },
  minCapitalText: {
    color: GRAY_TEXT_DARK,
    fontWeight: 600,
    lineHeight: 1.5,
    margin: 0,
    fontSize: '14.5px',
  },
  disclaimer: {
    textAlign: 'center',
    fontSize: '12px',
    color: GRAY_LABEL,
    marginTop: '4px',
  },
}

function riskBadgeStyle(level) {
  const style = RISK_STYLES[level] || RISK_STYLES.Medium
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '4px 12px',
    borderRadius: '999px',
    fontSize: '13px',
    fontWeight: 600,
    backgroundColor: style.bg,
    color: style.text,
    border: `1px solid ${style.ring}`,
  }
}

function LanguageSwitch({ value, onChange }) {
  return (
    <div style={S.langSwitch}>
      {LANGUAGES.map((lang) => (
        <button
          key={lang.value}
          type="button"
          onClick={() => onChange(lang.value)}
          aria-pressed={lang.value === value}
          style={S.langButton(lang.value === value)}
        >
          {lang.label}
        </button>
      ))}
    </div>
  )
}

function GuideDetailView({ type, onClose }) {
  const [language, setLanguage] = useState('en')

  const guideSet = INVESTMENT_GUIDES[type.value]
  const guide = guideSet?.[language]
  const labels = SECTION_LABELS[language]
  const dir = LANGUAGES.find((l) => l.value === language)?.dir || 'ltr'
  const isRtl = dir === 'rtl'

  if (!guide) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 0' }}>
        <p style={{ color: GRAY_TEXT }}>No guide is available for this category yet.</p>
        <button onClick={onClose} style={{ ...S.backButton, justifyContent: 'center', margin: '16px auto 0' }}>
          &larr; Back
        </button>
      </div>
    )
  }

  return (
    <div>
      <button type="button" onClick={onClose} style={S.backButton}>
        <i className="fa-solid fa-arrow-left" aria-hidden="true" />
        Back
      </button>

      <div style={S.detailHeaderWrap}>
        <span style={S.detailIconCircle}>
          <i className={`fa-solid ${type.icon}`} aria-hidden="true" />
        </span>
        <h2 style={S.detailTitle}>{type.label}</h2>
      </div>

      <div style={S.langSwitchWrap}>
        <LanguageSwitch value={language} onChange={setLanguage} />
      </div>

      <div dir={dir} lang={language === 'ur' ? 'ur' : 'en'} style={{ textAlign: isRtl ? 'right' : 'left' }}>
        {/* What is it? */}
        <section style={S.section}>
          <h3 style={S.sectionLabel}>{labels.overview}</h3>
          <p style={S.bodyText}>{guide.overview}</p>
        </section>

        {/* How to Start */}
        <section style={S.section}>
          <h3 style={S.sectionLabel}>{labels.howToStart}</h3>
          <ol style={S.stepList}>
            {guide.howToStart.map((step, i) => (
              <li key={i} style={S.stepRow(isRtl)}>
                <span style={S.stepNumber}>{i + 1}</span>
                <span style={S.stepText}>{step}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* Risk */}
        <section style={S.section}>
          <div style={{ ...S.sectionLabelRow, flexDirection: isRtl ? 'row-reverse' : 'row' }}>
            <h3 style={{ ...S.sectionLabel, marginBottom: 0 }}>{labels.risk}</h3>
            <span style={riskBadgeStyle(guide.risk.level)}>{guide.risk.level}</span>
          </div>
          <p style={{ ...S.bodyText, marginTop: '10px' }}>{guide.risk.note}</p>
        </section>

        {/* Minimum Amount */}
        <section style={{ ...S.section, marginBottom: '20px' }}>
          <h3 style={S.sectionLabel}>{labels.minCapital}</h3>
          <p style={S.minCapitalText}>{guide.minCapital}</p>
        </section>

        <p style={S.disclaimer}>{DISCLAIMER[language]}</p>
      </div>
    </div>
  )
}

export default function InvestingPanel() {
  const [loaded, setLoaded] = useState(false)
  const [available, setAvailable] = useState(true)
  const [amount, setAmount] = useState(0)
  const [types, setTypes] = useState(FALLBACK_TYPES)
  const [selectedType, setSelectedType] = useState(null)

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/advisor/investing/suggestion', { credentials: 'include' })
        if (res.ok) {
          const data = await res.json()
          if (data.success) setAmount(data.recommended_monthly_amount || 0)
        }
      } catch {
        // Suggested amount is a nice-to-have — panel still works without it.
      }

      try {
        const typesRes = await fetch('/api/advisor/investing/types', { credentials: 'include' })
        if (typesRes.ok) {
          const typesData = await typesRes.json()
          if (typesData.success && Array.isArray(typesData.types)) {
            setTypes(typesData.types.map(t => ({
              ...t,
              icon: FALLBACK_TYPES.find(f => f.value === t.value)?.icon || 'fa-circle-info'
            })))
          }
        }
        setAvailable(true)
      } catch {
        setAvailable(true)
      } finally {
        setLoaded(true)
      }
    })()
  }, [])

  function openGuide(type) {
    setSelectedType(type)
  }

  function closeGuide() {
    setSelectedType(null)
  }

  return (
    <div style={S.outer}>
      {/*
        Optional: if your project doesn't already load an Urdu-capable
        typeface globally, add a font like Noto Nastaliq Urdu via your
        index.html <head> for a nicer Urdu render — not required, the
        default system font will still display Urdu correctly.
      */}
      <div style={S.card}>
        {!selectedType ? (
          <>
            <div style={S.headingWrap}>
              <h1 style={S.heading}>Investing</h1>
              <p style={S.subtitle}>
                FinBud doesn't invest on your behalf — pick a topic below for a complete, plain-language guide on how you could get started.
              </p>
            </div>

            {!loaded ? (
              <div style={S.grid}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} style={S.skeleton} />
                ))}
              </div>
            ) : (
              <div style={S.grid}>
                {types.map((type) => {
                  // Prefer our short label (e.g. "Stocks") over whatever the
                  // live /api/advisor/investing/types endpoint returns (which
                  // may be a long description) — keeps every card the same
                  // short height, matching the Savings/Goals card style.
                  const shortLabel = FALLBACK_TYPES.find((f) => f.value === type.value)?.label || type.label
                  return (
                    <button key={type.value} type="button" onClick={() => openGuide(type)} style={S.typeCard}>
                      <i className={`fa-solid ${type.icon}`} style={S.typeCardIcon} aria-hidden="true" />
                      <span style={S.typeCardLabel}>{shortLabel}</span>
                    </button>
                  )
                })}
              </div>
            )}

            <p style={S.footNote}>{DISCLAIMER.en}</p>

            {!available && (
              <p style={S.footNote}>Some personalization features are unavailable right now, but guides work offline.</p>
            )}

          
          </>
        ) : (
          <GuideDetailView type={selectedType} onClose={closeGuide} />
        )}
      </div>
    </div>
  )
}