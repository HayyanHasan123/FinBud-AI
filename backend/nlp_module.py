"""
BankAI - Pure AI Conversation Engine
UPDATED VERSION with conversation state tracking for multi-step flows
"""

import re
from typing import Dict, Optional, Tuple


class BankAIConversation:
    """
    Pure NLP engine for banking conversations
    Handles multilingual understanding (Urdu, English, Roman Urdu)
    Supports multi-step conversation flows
    """
    
    def __init__(self):
        # Intent detection patterns
        self.intent_patterns = {
            'check_balance': [
                r'(balance|kitna|kitni|baki|remaining)',
                r'(mere|mera|my)\s*(account|khata)',
                r'(show|dekha|batao|check)\s*(balance|paisa)',
            ],
            
            'transfer_money': [
                r'(send|bhej|transfer|payment)',
                r'(pay|bhejo)\s*.*\s*to',
                r'paisa\s*bhejo',
                r'transfer\s*karo',
                r'money\s*(send|transfer)',
            ],
            
            'pay_bill': [
                r'(bill|bijli|pani|gas|sui\s*gas)',
                r'(electricity|k-electric|lesco|ptcl)',
                r'bill\s*(pay|karo|karna|ada)',
                r'(bijli|sui\s*gas|pani)\s*ka\s*bill',
                r'(k-electric|lesco|ptcl|gas)\s*(ka\s*)?(bill)',
                r'pay\s*(my)?\s*bill',
            ],
            
            'transaction_history': [
                r'(history|transactions|statement)',
                r'(last|pichle)\s*transaction',
            ],
            
            'check_rewards': [
                r'(reward|points)',
                r'(mere|my)\s*points',
                r'kitne\s*points',
            ],
            
            'redeem_points': [
                r'redeem\s*(points|rewards)',
                r'(use|exchange)\s*points',
                r'points\s*(redeem|use)',
            ],
            
            'bill_reminders': [
                r'(reminder|yaad)',
                r'(upcoming|pending|baki)\s*bills?',
                r'show.*bills?',
                r'batao.*bills?',
            ],
            
            'emergency': [
                r'(block|lock|band)\s*(card|my\s*card)',
                r'card\s*(block|lock|band)\s*karo',
                r'mere\s*card\s*(block|lock|band)',
                r'emergency',
            ],
            
            'human_agent': [
                r'(human|person|agent)',
                r'kisi\s*se\s*baat',
            ],
        }
        
        # Enhanced slang mapping
        self.slang_mapping = {
            'bijli': 'electricity',
            'bjili': 'electricity',
            'pani': 'water',
            'sui gas': 'gas',
            'gas': 'gas',
            'bhejo': 'send',
            'kitna': 'how much',
            'kitne': 'how many',
            'mere': 'my',
            'mera': 'my',
            'paisa': 'money',
            'rupay': 'rupees',
            'rupaye': 'rupees',
            'khata': 'account',
            'yaad': 'reminder',
            'baki': 'remaining',
            'karo': 'do',
            'karna': 'do',
            'batao': 'tell',
            'band': 'lock',
            'ada': 'pay',
        }
        
        # Response templates
        self.responses = {
            'greeting': {
                'en': "Hello! I'm BankAI. How can I help you today?",
                'ur': "السلام علیکم! میں BankAI ہوں۔ میں آپ کی کیسے مدد کر سکتا ہوں؟",
                'ru': "Assalam-o-Alaikum! Main BankAI hoon. Aap ki kaise madad kar sakta hoon?"
            },
            'unknown': {
                'en': "I didn't understand that. Try:\n• Check balance\n• Send money\n• Pay bills",
                'ur': "معذرت، میں سمجھ نہیں سکا",
                'ru': "Maafi, main samajh nahi saka. Try karein:\n• Balance check karein\n• Paisa bhejein\n• Bill pay karein"
            },
            'check_balance': {
                'en': "Your balance is RS {balance:,}",
                'ur': "آپ کا بیلنس RS {balance:,} ہے",
                'ru': "Aap ka balance RS {balance:,} hai"
            },
            'transfer_ask_amount': {
                'en': "Aap kitni raqam transfer karna chahte hain?",
                'ur': "💰 آپ کتنی رقم منتقل کرنا چاہتے ہیں؟",
                'ru': "How much would you like to transfer?"
            },
            'transfer_ask_recipient_name': {
                'en': "👤 Who would you like to send RS {amount:,} to? Please provide their name.",
                'ur': "👤 آپ RS {amount:,} کسے بھیجنا چاہتے ہیں؟ براۓ کرم ان کا نام فراہم کریں۔",
                'ru': "👤 Aap RS {amount:,} kise bhejna chahte hain? Unka naam provide karein."
            },
            'transfer_ask_account': {
                'en': "Please provide the account number for {recipient}.",
                'ur': "🔢 براۓ کرم {recipient} کا اکاؤنٹ نمبر فراہم کریں۔",
                'ru': "{recipient} ka account number provide karein."
            },
            'transfer_invalid_account': {
                'en': "❌ Invalid account number. Please provide a valid account number(eg; ABC12345678).",
                'ur': "❌ غلط اکاؤنٹ نمبر۔ براۓ کرم ایک درست اکاؤنٹ نمبر فراہم کریں۔",
                'ru': "❌ Ghalat account number. Brahe karam ek durust account number provide karein(maslan; ABC12345678)."
            },
            'transfer_password_request': {
                'en': "🔒 Please enter your password to confirm the transfer of RS {amount:,} to {recipient}.",
                'ur': "🔒 براۓ کرم اپنا پاس ورڈ درج کریں تاکہ {recipient} کو RS {amount:,} کی منتقلی کی تصدیق ہو سکے۔",
                'ru': "🔒 Apna password enter karein taake {recipient} ko RS {amount:,} ki transfer confirm ho sake."
            },
            'transfer_success': {
                'en': "✅ Transfer successful! RS {amount:,} sent to {recipient}.\n💰 New balance: RS {balance:,}\n⭐ You earned {points} reward points!",
                'ur': "✅ ٹرانسفر کامیاب! RS {amount:,} {recipient} کو بھیجا گیا۔\n💰 نیا بیلنس: RS {balance:,}\n⭐ آپ نے {points} انعامی پوائنٹس حاصل کیے!",
                'ru': "✅ Transfer kamyab! RS {amount:,} {recipient} ko bheja gaya.\n💰 Naya balance: RS {balance:,}\n⭐ Aap ne {points} reward points hasil kiye!"
            },
            'bill_ask_type': {
                'en': "Which bill would you like to pay?\n• Electricity\n• Gas\n• Internet\n• Water",
                'ur': "📋 آپ کون سا بل ادا کرنا چاہتے ہیں؟\n• بجلی\n• گیس\n• انٹرنیٹ\n• پانی",
                'ru': "Aap konsa bill ada karna chahte hain?\n• Electricity\n• Gas\n• Internet\n• Water"
            },
            'bill_ask_reference': {
                'en': " Please provide your {bill_type} bill reference number.",
                'ur': "🔢 براۓ کرم اپنا {bill_type} بل ریفرنس نمبر فراہم کریں۔",
                'ru': " Apna {bill_type} bill reference number provide karein."
            },
            'bill_ask_amount': {
                'en': "How much is your {bill_type} bill amount?",
                'ur': "💵 آپ کا {bill_type} بل کتنا ہے؟",
                'ru': "Aap ka {bill_type} bill kitna hai?"
            },
            'bill_payment_password_request': {
                'en': "🔒 Please enter your password to confirm the {bill_type} bill payment of RS {amount:,}.",
                'ur': "🔒 براۓ کرم اپنا پاس ورڈ درج کریں تاکہ {bill_type} بل RS {amount:,} کی ادائیگی کی تصدیق ہو سکے۔",
                'ru': "🔒 Apna password enter karein taake {bill_type} bill RS {amount:,} ki payment confirm ho sake."
            },
            'bill_payment_success': {
                'en': "✅ Bill payment successful! {bill_type} bill of RS {amount:,} paid.\n💰 New balance: RS {balance:,}\n⭐ You earned {points} reward points!",
                'ur': "✅ بل ادائیگی کامیاب! {bill_type} بل RS {amount:,} ادا کیا گیا۔\n💰 نیا بیلنس: RS {balance:,}\n⭐ آپ نے {points} انعامی پوائنٹس حاصل کیے!",
                'ru': "✅ Bill payment kamyab! {bill_type} bill RS {amount:,} ada kiya gaya.\n💰 Naya balance: RS {balance:,}\n⭐ Aap ne {points} reward points hasil kiye!"
            },
            'check_rewards': {
                'en': "You have {points} reward points",
                'ur': "آپ کے پاس {points} انعامی پوائنٹس ہیں",
                'ru': "Aap ke paas {points} reward points hain"
            },
            'redeem_password_request': {
                'en': "🔒 Please enter your password to confirm points redemption.",
                'ur': "🔒 براۓ کرم اپنا پاس ورڈ درج کریں تاکہ پوائنٹس ریڈیمپشن کی تصدیق ہو سکے۔",
                'ru': "🔒 Apna password enter karein taake points redemption confirm ho sake."
            },
            'redeem_success': {
                'en': "✅ Redemption successful! {points_used} points redeemed for RS {reward_value}.\n💰 New balance: RS {balance:,}\n⭐ Remaining points: {remaining_points}",
                'ur': "✅ ریڈیمپشن کامیاب! {points_used} پوائنٹس RS {reward_value} کے لیے استعمال کیے گئے۔\n💰 نیا بیلنس: RS {balance:,}\n⭐ باقی پوائنٹس: {remaining_points}",
                'ru': "✅ Redemption kamyab! {points_used} points RS {reward_value} ke liye use kiye gaye.\n💰 Naya balance: RS {balance:,}\n⭐ Baqi points: {remaining_points}"
            },
            'bill_reminders': {
                'en': "Your pending bills",
                'ur': "آپ کے التواء میں بل",
                'ru': "Aap ke pending bills"
            },
            'transaction_history': {
                'en': "Your recent transactions",
                'ur': "آپ کے حالیہ لین دین",
                'ru': "Aap ke recent transactions"
            },
            'clarify_redemption_option': {
                'en': "Which reward would you like to redeem?\n1. PKR 500 Cash Voucher (1,000 Points)\n2. PKR 250 Bill Discount (500 Points)",
                'ur': "آپ کون سا انعام حاصل کرنا چاہتے ہیں؟\n1. PKR 500 کیش واؤچر (1,000 پوائنٹس)\n2. PKR 250 بل ڈسکاؤنٹ (500 پوائنٹس)",
                'ru': "Aap konsa reward lena chahte hain?\n1. PKR 500 Cash Voucher (1,000 Points)\n2. PKR 250 Bill Discount (500 Points)"
            },
            'emergency_password_request': {
                'en': "⚠️ SECURITY CHECK: Please enter your password to confirm card blocking.",
                'ur': "⚠️ سیکیورٹی چیک: براۓ کرم اپنا پاس ورڈ درج کریں تاکہ کارڈ بلاک کرنے کی تصدیق ہو سکے۔",
                'ru': "⚠️ SECURITY CHECK: Apna password enter karein taake card block confirm ho sake."
            },
            'emergency_password_incorrect': {
                'en': "❌ Incorrect password. You have {attempts} attempt(s) remaining. Please try again.",
                'ur': "❌ غلط پاس ورڈ۔ آپ کے پاس {attempts} کوشش(یں) باقی ہیں۔ براۓ کرم دوبارہ کوشش کریں۔",
                'ru': "❌ Ghalat password. Aap ke paas {attempts} koshish(ain) baqi hain. Dobara koshish karein."
            },
            'emergency_failed': {
                'en': "❌ Emergency mode failed. Too many incorrect password attempts. Please contact customer support.",
                'ur': "❌ ایمرجنسی موڈ ناکام۔ بہت زیادہ غلط پاس ورڈ کی کوششیں۔ براۓ کرم کسٹمر سپورٹ سے رابطہ کریں۔",
                'ru': "❌ Emergency mode nakam. Bahut zyada ghalat password ki koshishain. Customer support se rabta karein."
            },
            'emergency_confirm': {
                'en': "🚨 EMERGENCY ACTIVATED: All cards are now locked. Fraud team has been alerted. Please call customer support to verify your identity.",
                'ur': "🚨 ایمرجنسی فعال: تمام کارڈز اب بند ہیں۔ فراڈ ٹیم کو الرٹ کر دیا گیا ہے۔ براۓ کرم کسٹمر سپورٹ کو کال کریں۔",
                'ru': "🚨 EMERGENCY ACTIVATED: Saare cards ab locked hain. Fraud team ko alert kar diya gaya hai. Customer support ko call karein."
            },
            'password_incorrect': {
                'en': "❌ Incorrect password. Transaction cancelled.",
                'ur': "❌ غلط پاس ورڈ۔ ٹرانزیکشن منسوخ کر دی گئی۔",
                'ru': "❌ Ghalat password. Transaction cancel kar di gayi."
            },
            'insufficient_funds': {
                'en': "❌ Insufficient funds. Your balance is RS {balance:,}.",
                'ur': "❌ ناکافی فنڈز۔ آپ کا بیلنس RS {balance:,} ہے۔",
                'ru': "❌ Nakafi funds. Aap ka balance RS {balance:,} hai."
            },
            'insufficient_points': {
                'en': "❌ Insufficient points. You have {points} points but need {required} points.",
                'ur': "❌ ناکافی پوائنٹس۔ آپ کے پاس {points} پوائنٹس ہیں لیکن {required} پوائنٹس کی ضرورت ہے۔",
                'ru': "❌ Nakafi points. Aap ke paas {points} points hain lekin {required} points ki zaroorat hai."
            },
            'human_handoff': {
                'en': "Connecting you to a human banker...",
                'ur': "آپ کو بینکر سے جوڑا جا رہا ہے...",
                'ru': "Aap ko banker se joda ja raha hai..."
            }
        }
    
    def detect_language(self, text: str) -> str:
        """Detect language: 'ur' (Urdu), 'ru' (Roman Urdu), 'en' (English)"""
        if any('\u0600' <= c <= '\u06FF' for c in text):
            return 'ur'
        
        roman_words = ['aap', 'main', 'hai', 'hoon', 'kya', 'bhejo', 'kitna', 'kitne', 
                       'mere', 'mera', 'karo', 'karna', 'batao', 'dijiye', 'chahta', 
                       'chahte', 'chahiye', 'bijli', 'bjili', 'pani', 'paisa', 'rupay',
                       'khata', 'yaad', 'baki', 'band', 'ada', 'se', 'ko', 'ka']
        if any(w in text.lower() for w in roman_words):
            return 'ru'
        
        return 'en'
    
    def normalize_slang(self, text: str) -> str:
        """Convert slang to standard form"""
        text_lower = text.lower()
        for slang, standard in self.slang_mapping.items():
            text_lower = re.sub(r'\b' + slang + r'\b', standard, text_lower)
        return text_lower
    
    def extract_amount(self, text: str) -> Optional[int]:
        """Extract amount from text"""
        patterns = [
            r'rs\.?\s*(\d+(?:,\d{3})*(?:\.\d{2})?)',
            r'pkr\s*(\d+(?:,\d{3})*(?:\.\d{2})?)',
            r'(\d+(?:,\d{3})*(?:\.\d{2})?)\s*rupees',
            r'\b(\d+(?:,\d{3})*(?:\.\d{2})?)\b',
        ]
        
        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                amount_str = match.group(1).replace(',', '')
                return int(float(amount_str))
        return None
    
    def extract_recipient_name(self, text: str) -> Optional[str]:
        """Extract recipient name from text"""
        text = text.strip()
        
        # Remove common words
        excluded = ['to', 'send', 'transfer', 'bhejo', 'karo', 'ko']
        name_words = [w for w in text.split() if w.lower() not in excluded]
        
        if name_words:
            return ' '.join(w.capitalize() for w in name_words)
        
        # If nothing left, just capitalize what user entered
        return text.strip().title() if text else None
    
    def validate_account_number(self, text: str) -> Optional[str]:
        """Validate account number - must be mix of letters and numbers"""
        text = text.strip().upper().replace(' ', '')
        
        # Remove common words
        excluded = ['ACCOUNT', 'NUMBER', 'ACC', 'NO']
        for word in excluded:
            text = text.replace(word, '')
        
        text = text.strip()
        
        # Must be between 6-20 characters
        if not (6 <= len(text) <= 20):
            return None
        
        # Must contain both letters and numbers
        has_letter = any(c.isalpha() for c in text)
        has_digit = any(c.isdigit() for c in text)
        
        # Must be alphanumeric only
        is_alphanumeric = text.isalnum()
        
        if has_letter and has_digit and is_alphanumeric:
            return text
        
        return None
    
    def extract_bill_type(self, text: str) -> Optional[str]:
        """Extract bill type from text"""
        normalized = self.normalize_slang(text.lower())
        
        bill_map = {
            'electricity': 'Electricity',
            'k-electric': 'Electricity',
            'lesco': 'Electricity',
            'bijli': 'Electricity',
            'electric': 'Electricity',
            'gas': 'Gas',
            'ptcl': 'Internet',
            'internet': 'Internet',
            'water': 'Water',
            'pani': 'Water',
        }
        
        for key, value in bill_map.items():
            if key in normalized:
                return value
        return None
    
    def extract_bill_reference(self, text: str) -> Optional[str]:
        """Extract bill reference number - accept anything reasonable"""
        text = text.strip()
        
        # Remove common words
        excluded = ['bill', 'reference', 'number', 'ref', 'no', 'account']
        for word in excluded:
            text = re.sub(r'\b' + word + r'\b', '', text, flags=re.IGNORECASE)
        
        text = text.strip()
        
        # Accept any alphanumeric string
        cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
        if 4 <= len(cleaned) <= 20:
            return cleaned
        
        # If nothing matches, just return what user typed
        if len(text) >= 4:
            return text.upper().replace(' ', '')
        
        return None
    
    def extract_redemption_choice(self, text: str) -> Optional[int]:
        """Extract redemption choice from text"""
        text_lower = text.lower()
        
        # Check for option numbers
        if '1' in text or 'first' in text_lower or '500' in text:
            return 500
        elif '2' in text or 'second' in text_lower or '250' in text:
            return 250
        
        return None
    
    def detect_intent(self, text: str) -> str:
        """Detect user intent"""
        normalized = self.normalize_slang(text)
        
        for intent, patterns in self.intent_patterns.items():
            for pattern in patterns:
                if re.search(pattern, normalized, re.IGNORECASE):
                    return intent
        
        if re.match(r'^(hi|hello|hey|salam)', text.lower()):
            return 'greeting'
        
        return 'unknown'
    
    def process_message(self, user_message: str, conversation_context: Dict = None) -> Dict:
        """
        Main function: Analyze user message and manage conversation state
        """
        if conversation_context is None:
            conversation_context = {}
        
        language = self.detect_language(user_message)
        
        # Handle emergency password flow with retry tracking
        if conversation_context.get('awaiting_emergency_password'):
            return {
                'intent': 'emergency_password_provided',
                'language': language,
                'entities': {'password': user_message.strip()},
                'needs_clarification': False,
                'clarification_type': None,
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': user_message,
                'ai_response': None,
                'original_intent': 'emergency',
                'emergency_attempts': conversation_context.get('emergency_attempts', 3)
            }
        
        # Handle password flow for transactions
        if conversation_context.get('awaiting_password'):
            original_intent = conversation_context.get('original_intent')
            return {
                'intent': 'password_provided',
                'language': language,
                'entities': {
                    'password': user_message.strip(),
                    **conversation_context.get('pending_entities', {})
                },
                'needs_clarification': False,
                'clarification_type': None,
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': user_message,
                'ai_response': None,
                'original_intent': original_intent
            }
        
        # Handle ongoing flows
        current_flow = conversation_context.get('current_flow')
        
        # TRANSFER MONEY FLOW
        if current_flow == 'transfer_money':
            # Step 1: Get amount
            if not conversation_context.get('amount'):
                amount = self.extract_amount(user_message)
                if amount:
                    return {
                        'intent': 'transfer_money',
                        'language': language,
                        'entities': {'amount': amount},
                        'needs_clarification': True,
                        'clarification_type': 'recipient_name_missing',
                        'requires_human': False,
                        'handoff_reason': None,
                        'normalized_text': self.normalize_slang(user_message),
                        'ai_response': self.responses['transfer_ask_recipient_name'][language].format(amount=amount),
                        'current_flow': 'transfer_money',
                        'amount': amount
                    }
                else:
                    # If no amount found, ask again
                    return {
                        'intent': 'transfer_money',
                        'language': language,
                        'entities': {},
                        'needs_clarification': True,
                        'clarification_type': 'amount_missing',
                        'requires_human': False,
                        'handoff_reason': None,
                        'normalized_text': self.normalize_slang(user_message),
                        'ai_response': self.responses['transfer_ask_amount'][language],
                        'current_flow': 'transfer_money'
                    }
            
            # Step 2: Get recipient name
            elif not conversation_context.get('recipient'):
                recipient = self.extract_recipient_name(user_message)
                
                if not recipient:
                    recipient = user_message.strip().title()
                
                amount = conversation_context['amount']
                
                return {
                    'intent': 'transfer_money',
                    'language': language,
                    'entities': {
                        'amount': amount,
                        'recipient': recipient
                    },
                    'needs_clarification': True,
                    'clarification_type': 'account_number_missing',
                    'requires_human': False,
                    'handoff_reason': None,
                    'normalized_text': self.normalize_slang(user_message),
                    'ai_response': self.responses['transfer_ask_account'][language].format(recipient=recipient),
                    'current_flow': 'transfer_money',
                    'amount': amount,
                    'recipient': recipient
                }
            
            # Step 3: Get and validate account number
            elif not conversation_context.get('account_number'):
                account_number = self.validate_account_number(user_message)
                
                if not account_number:
                    # Invalid account number
                    return {
                        'intent': 'transfer_money',
                        'language': language,
                        'entities': {},
                        'needs_clarification': True,
                        'clarification_type': 'invalid_account_number',
                        'requires_human': False,
                        'handoff_reason': None,
                        'normalized_text': self.normalize_slang(user_message),
                        'ai_response': self.responses['transfer_invalid_account'][language],
                        'current_flow': 'transfer_money',
                        'amount': conversation_context['amount'],
                        'recipient': conversation_context['recipient']
                    }
                
                # Valid account number - ask for password
                amount = conversation_context['amount']
                recipient = conversation_context['recipient']
                
                return {
                    'intent': 'transfer_money',
                    'language': language,
                    'entities': {
                        'amount': amount,
                        'recipient': recipient,
                        'account_number': account_number
                    },
                    'needs_clarification': True,
                    'clarification_type': 'password_required',
                    'requires_human': False,
                    'handoff_reason': None,
                    'normalized_text': self.normalize_slang(user_message),
                    'ai_response': self.responses['transfer_password_request'][language].format(
                        amount=amount, recipient=recipient
                    ),
                    'awaiting_password': True,
                    'original_intent': 'transfer_money',
                    'pending_entities': {
                        'amount': amount,
                        'recipient': recipient,
                        'account_number': account_number
                    }
                }
        
        # PAY BILL FLOW
        elif current_flow == 'pay_bill':
            # Step 1: Get bill type
            if not conversation_context.get('bill_type'):
                bill_type = self.extract_bill_type(user_message)
                if bill_type:
                    return {
                        'intent': 'pay_bill',
                        'language': language,
                        'entities': {'bill_type': bill_type},
                        'needs_clarification': True,
                        'clarification_type': 'bill_reference_missing',
                        'requires_human': False,
                        'handoff_reason': None,
                        'normalized_text': self.normalize_slang(user_message),
                        'ai_response': self.responses['bill_ask_reference'][language].format(bill_type=bill_type),
                        'current_flow': 'pay_bill',
                        'bill_type': bill_type
                    }
                else:
                    return {
                        'intent': 'pay_bill',
                        'language': language,
                        'entities': {},
                        'needs_clarification': True,
                        'clarification_type': 'bill_type_missing',
                        'requires_human': False,
                        'handoff_reason': None,
                        'normalized_text': self.normalize_slang(user_message),
                        'ai_response': self.responses['bill_ask_type'][language],
                        'current_flow': 'pay_bill'
                    }
            
            # Step 2: Get bill reference
            elif not conversation_context.get('bill_reference'):
                bill_reference = self.extract_bill_reference(user_message)
                if not bill_reference:
                    # Accept whatever user enters
                    bill_reference = user_message.strip().upper().replace(' ', '')
                
                bill_type = conversation_context['bill_type']
                
                return {
                    'intent': 'pay_bill',
                    'language': language,
                    'entities': {
                        'bill_type': bill_type,
                        'account_number': bill_reference
                    },
                    'needs_clarification': True,
                    'clarification_type': 'bill_amount_missing',
                    'requires_human': False,
                    'handoff_reason': None,
                    'normalized_text': self.normalize_slang(user_message),
                    'ai_response': self.responses['bill_ask_amount'][language].format(bill_type=bill_type),
                    'current_flow': 'pay_bill',
                    'bill_type': bill_type,
                    'bill_reference': bill_reference
                }
            
            # Step 3: Get amount
            elif not conversation_context.get('amount'):
                amount = self.extract_amount(user_message)
                if not amount:
                    # Try to parse it as just a number
                    try:
                        amount = int(re.sub(r'[^\d]', '', user_message))
                    except:
                        amount = None
                
                if amount:
                    bill_type = conversation_context['bill_type']
                    bill_reference = conversation_context['bill_reference']
                    
                    return {
                        'intent': 'pay_bill',
                        'language': language,
                        'entities': {
                            'bill_type': bill_type,
                            'account_number': bill_reference,
                            'amount': amount
                        },
                        'needs_clarification': True,
                        'clarification_type': 'password_required',
                        'requires_human': False,
                        'handoff_reason': None,
                        'normalized_text': self.normalize_slang(user_message),
                        'ai_response': self.responses['bill_payment_password_request'][language].format(
                            bill_type=bill_type, amount=amount
                        ),
                        'awaiting_password': True,
                        'original_intent': 'pay_bill',
                        'pending_entities': {
                            'bill_type': bill_type,
                            'account_number': bill_reference,
                            'amount': amount
                        }
                    }
                else:
                    # If no amount found, ask again
                    bill_type = conversation_context['bill_type']
                    return {
                        'intent': 'pay_bill',
                        'language': language,
                        'entities': {},
                        'needs_clarification': True,
                        'clarification_type': 'bill_amount_missing',
                        'requires_human': False,
                        'handoff_reason': None,
                        'normalized_text': self.normalize_slang(user_message),
                        'ai_response': self.responses['bill_ask_amount'][language].format(bill_type=bill_type),
                        'current_flow': 'pay_bill',
                        'bill_type': conversation_context['bill_type'],
                        'bill_reference': conversation_context['bill_reference']
                    }
        
        # REDEEM POINTS FLOW
        elif current_flow == 'redeem_points':
            if not conversation_context.get('redemption_choice'):
                choice = self.extract_redemption_choice(user_message)
                if choice:
                    return {
                        'intent': 'redeem_points',
                        'language': language,
                        'entities': {'redemption_choice': choice},
                        'needs_clarification': True,
                        'clarification_type': 'password_required',
                        'requires_human': False,
                        'handoff_reason': None,
                        'normalized_text': self.normalize_slang(user_message),
                        'ai_response': self.responses['redeem_password_request'][language],
                        'awaiting_password': True,
                        'original_intent': 'redeem_points',
                        'pending_entities': {'redemption_choice': choice}
                    }
        
        # Detect new intent
        intent = self.detect_intent(user_message)
        
        # Check for emergency intent
        if intent == 'emergency':
            return {
                'intent': 'emergency',
                'language': language,
                'entities': {},
                'needs_clarification': True,
                'clarification_type': 'password_required',
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': self.normalize_slang(user_message),
                'ai_response': self.responses['emergency_password_request'][language],
                'awaiting_emergency_password': True,
                'emergency_attempts': 3
            }
        
        # Handle new intents
        if intent == 'greeting':
            return {
                'intent': 'greeting',
                'language': language,
                'entities': {},
                'needs_clarification': False,
                'clarification_type': None,
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': self.normalize_slang(user_message),
                'ai_response': self.responses['greeting'][language]
            }
        
        elif intent == 'transfer_money':
            # Start transfer flow
            amount = self.extract_amount(user_message)
            
            if amount:
                # Has amount, ask for recipient name
                return {
                    'intent': 'transfer_money',
                    'language': language,
                    'entities': {'amount': amount},
                    'needs_clarification': True,
                    'clarification_type': 'recipient_name_missing',
                    'requires_human': False,
                    'handoff_reason': None,
                    'normalized_text': self.normalize_slang(user_message),
                    'ai_response': self.responses['transfer_ask_recipient_name'][language].format(amount=amount),
                    'current_flow': 'transfer_money',
                    'amount': amount
                }
            else:
                # No amount, ask for it
                return {
                    'intent': 'transfer_money',
                    'language': language,
                    'entities': {},
                    'needs_clarification': True,
                    'clarification_type': 'amount_missing',
                    'requires_human': False,
                    'handoff_reason': None,
                    'normalized_text': self.normalize_slang(user_message),
                    'ai_response': self.responses['transfer_ask_amount'][language],
                    'current_flow': 'transfer_money'
                }
        
        elif intent == 'pay_bill':
            # Start bill payment flow
            bill_type = self.extract_bill_type(user_message)
            
            if bill_type:
                # Has bill type, ask for reference
                return {
                    'intent': 'pay_bill',
                    'language': language,
                    'entities': {'bill_type': bill_type},
                    'needs_clarification': True,
                    'clarification_type': 'bill_reference_missing',
                    'requires_human': False,
                    'handoff_reason': None,
                    'normalized_text': self.normalize_slang(user_message),
                    'ai_response': self.responses['bill_ask_reference'][language].format(bill_type=bill_type),
                    'current_flow': 'pay_bill',
                    'bill_type': bill_type
                }
            else:
                # No bill type, ask for it
                return {
                    'intent': 'pay_bill',
                    'language': language,
                    'entities': {},
                    'needs_clarification': True,
                    'clarification_type': 'bill_type_missing',
                    'requires_human': False,
                    'handoff_reason': None,
                    'normalized_text': self.normalize_slang(user_message),
                    'ai_response': self.responses['bill_ask_type'][language],
                    'current_flow': 'pay_bill'
                }
        
        elif intent == 'redeem_points':
            return {
                'intent': 'redeem_points',
                'language': language,
                'entities': {},
                'needs_clarification': True,
                'clarification_type': 'redemption_choice_missing',
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': self.normalize_slang(user_message),
                'ai_response': self.responses['clarify_redemption_option'][language],
                'current_flow': 'redeem_points'
            }
        
        elif intent == 'human_agent':
            return {
                'intent': 'human_agent',
                'language': language,
                'entities': {},
                'needs_clarification': False,
                'clarification_type': None,
                'requires_human': True,
                'handoff_reason': 'user_requested',
                'normalized_text': self.normalize_slang(user_message),
                'ai_response': self.responses['human_handoff'][language]
            }
        
        # For other intents, return basic structure
        return {
            'intent': intent,
            'language': language,
            'entities': {},
            'needs_clarification': False,
            'clarification_type': None,
            'requires_human': False,
            'handoff_reason': None,
            'normalized_text': self.normalize_slang(user_message),
            'ai_response': None
        }


if __name__ == "__main__":
    print("=== BankAI Pure AI Engine (FIXED) ===\n")
    
    ai = BankAIConversation()
    
    tests = [
        "Hello",
        "Send RS 5000 to Ahmed",
        "Pay my electricity bill",
        "Redeem my points",
        "Block my card",
    ]
    
    for test in tests:
        print(f"\nUser: {test}")
        result = ai.process_message(test)
        print(f"Intent: {result['intent']}")
        print(f"Response: {result.get('ai_response', 'Processing...')}")