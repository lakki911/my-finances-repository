// Hindi for the app's labels. The app is written in English; after each render
// the visible text is swapped using this dictionary. Text not listed stays in English.

const KEY = 'lang';
export const LANGS = { en: 'English', hi: 'हिन्दी' };
export function lang() { try { return LANGS[localStorage.getItem(KEY)] ? localStorage.getItem(KEY) : 'en'; } catch { return 'en'; } }
export function setLang(l) { try { localStorage.setItem(KEY, l); } catch {} }
export const locale = () => (lang() === 'hi' ? 'hi-IN' : undefined);

const HI = {
  // navigation
  'Overview': 'सारांश', 'Income': 'आय', 'Spending': 'खर्च', 'Invest': 'निवेश', 'Plan': 'योजना', 'Reports': 'रिपोर्ट', 'Family': 'परिवार', 'Settings': 'सेटिंग्स', 'Search': 'खोजें',
  'My Finances': 'मेरा हिसाब',
  // overview
  'Spent': 'खर्च', 'Invested': 'निवेश', 'Kept': 'बचत', 'Salary': 'वेतन', 'Other income': 'अन्य आय', 'Where the money went': 'पैसा कहाँ गया',
  'Last 6 months': 'पिछले 6 महीने', 'Portfolio': 'पोर्टफोलियो', 'Total invested': 'कुल निवेश', 'Current value': 'मौजूदा मूल्य', 'Gain / loss': 'लाभ / हानि',
  'Due soon': 'जल्द देय', 'All bills': 'सभी बिल', 'Budgets': 'बजट', 'Manage': 'प्रबंधित करें', 'Quick add': 'झटपट जोड़ें', 'See summary': 'सारांश देखें',
  'Add your salary to get started': 'शुरू करने के लिए अपना वेतन जोड़ें', 'Nothing yet this month.': 'इस महीने अभी कुछ नहीं।',
  // income / spending
  'Total income': 'कुल आय', '+ Salary': '+ वेतन', '+ Income': '+ आय', '+ Spending': '+ खर्च', 'All spending': 'सारा खर्च', 'By category': 'श्रेणी के अनुसार',
  'By payment method': 'भुगतान के तरीके से', 'Spent this month': 'इस महीने खर्च', 'Entries': 'प्रविष्टियाँ', 'No other income this month.': 'इस महीने कोई अन्य आय नहीं।',
  'No spending recorded this month.': 'इस महीने कोई खर्च दर्ज नहीं।',
  // invest
  'Holdings': 'होल्डिंग्स', '+ Investment': '+ निवेश', 'Asset allocation': 'संपत्ति का बँटवारा', 'Update NAVs': 'NAV अपडेट करें', 'Return per year (XIRR)': 'सालाना रिटर्न (XIRR)',
  'Across all holdings': 'सभी होल्डिंग्स पर', 'Worth': 'मूल्य', 'Equity': 'इक्विटी', 'Debt': 'डेट', 'Gold': 'सोना', 'Real estate': 'रियल एस्टेट', 'Cash': 'नकद',
  // plan
  'Bills & recurring': 'बिल और नियमित', 'Goals': 'लक्ष्य', 'Lent & borrowed': 'उधार दिया/लिया', 'Loans': 'लोन', 'Insurance & FDs': 'बीमा और FD',
  '+ Budget': '+ बजट', '+ Goal': '+ लक्ष्य', '+ Add': '+ जोड़ें', '+ Loan': '+ लोन', 'Paid': 'भुगतान हुआ', 'Skip': 'छोड़ें', 'Savings goals': 'बचत लक्ष्य',
  'Others owe you': 'दूसरों पर आपका बकाया', 'You owe': 'आप पर बकाया', 'Open': 'खुला', 'Settled': 'चुकता', 'Still to repay': 'चुकाना बाकी',
  'EMIs each month': 'हर महीने EMI', 'Interest paid so far': 'अब तक दिया ब्याज', 'Insurance cover': 'बीमा कवर', 'Premiums a year': 'सालाना प्रीमियम',
  'Fixed deposits': 'सावधि जमा (FD)', 'Matured': 'परिपक्व', 'All bills and recurring items': 'सभी बिल और नियमित भुगतान', 'Due in the next 7 days': 'अगले 7 दिनों में देय',
  'Due today': 'आज देय', 'Due tomorrow': 'कल देय', 'Set a budget': 'बजट तय करें', 'Add a goal': 'लक्ष्य जोड़ें',
  // reports
  'Year': 'साल', 'Monthly summary': 'मासिक सारांश', 'Trends': 'रुझान', 'Net worth': 'कुल संपत्ति', 'Tax': 'टैक्स', 'Export': 'एक्सपोर्ट',
  'Month by month': 'महीने दर महीने', 'Left over': 'बचत', 'Month': 'महीना', 'In': 'आय', 'Out': 'खर्च', 'Left': 'बाकी', 'Total': 'कुल',
  'Download your records': 'अपने रिकॉर्ड डाउनलोड करें', 'Excel file (.xlsx)': 'Excel फ़ाइल (.xlsx)', 'CSV file': 'CSV फ़ाइल', 'Period': 'अवधि',
  'New regime': 'नई व्यवस्था', 'Old regime': 'पुरानी व्यवस्था', 'Lower': 'कम', 'Your figures': 'आपके आँकड़े', 'Income tax estimate': 'आयकर अनुमान',
  'Net worth today': 'आज की कुल संपत्ति', 'Investments': 'निवेश', 'Money lent': 'उधार दिया', 'Money borrowed': 'उधार लिया', 'This month': 'यह महीना',
  'Monthly average': 'मासिक औसत', 'Highest': 'सबसे ज़्यादा', 'Last 12 months': 'पिछले 12 महीने', 'Category': 'श्रेणी',
  // family
  'Budgets & goals': 'बजट और लक्ष्य', 'Split expenses': 'खर्च बाँटें', 'Members': 'सदस्य', 'Family goals': 'पारिवारिक लक्ष्य', 'Who owes whom': 'किसका किस पर बकाया',
  'Shared expenses': 'साझा खर्च', '+ Split': '+ बाँटें', 'Settle up': 'हिसाब चुकाएँ', 'Recent activity': 'हाल की गतिविधि', 'Roles': 'भूमिकाएँ', 'Refresh': 'रीफ़्रेश',
  'Family income': 'परिवार की आय', 'Family spending': 'परिवार का खर्च', 'Invested this month': 'इस महीने निवेश', 'Portfolio value': 'पोर्टफोलियो मूल्य',
  // settings
  'Account': 'खाता', 'Sync now': 'अभी सिंक करें', 'Change password': 'पासवर्ड बदलें', 'Sign out': 'साइन आउट', 'Security': 'सुरक्षा', 'App lock': 'ऐप लॉक',
  'Set a PIN': 'PIN सेट करें', 'Turn off': 'बंद करें', 'Change PIN': 'PIN बदलें', 'Change': 'बदलें', 'Look': 'रूप', 'Language': 'भाषा', 'Currency': 'मुद्रा',
  'Income categories': 'आय की श्रेणियाँ', 'Spending categories': 'खर्च की श्रेणियाँ', 'Investment types': 'निवेश के प्रकार', 'Backup': 'बैकअप',
  'Export backup': 'बैकअप एक्सपोर्ट करें', 'Import backup': 'बैकअप इम्पोर्ट करें', 'Add': 'जोड़ें', 'New category': 'नई श्रेणी', 'Quick-add buttons': 'झटपट-जोड़ें बटन',
  'Signed-in devices': 'साइन-इन डिवाइस', 'Sign out when idle': 'निष्क्रिय होने पर साइन आउट', 'Never': 'कभी नहीं', 'Main category': 'मुख्य श्रेणी',
  // dialogs and forms
  'Add entry': 'प्रविष्टि जोड़ें', 'Edit entry': 'प्रविष्टि बदलें', 'Amount': 'राशि', 'Date': 'तारीख', 'Note (optional)': 'टिप्पणी (वैकल्पिक)',
  'Payment method': 'भुगतान का तरीका', 'Tags (optional)': 'टैग (वैकल्पिक)', 'Save': 'सहेजें', 'Cancel': 'रद्द करें', 'Delete': 'हटाएँ', 'Close': 'बंद करें',
  'Not set': 'तय नहीं', 'Bank transfer': 'बैंक ट्रांसफ़र', 'Card': 'कार्ड', 'Other': 'अन्य', 'Name': 'नाम', 'Type': 'प्रकार', 'Clear': 'साफ़ करें',
  'Receipt photo (optional)': 'रसीद की फ़ोटो (वैकल्पिक)', 'View receipt': 'रसीद देखें', 'Rate': 'दर',
  // sign in
  'Sign in': 'साइन इन', 'Email': 'ईमेल', 'Password': 'पासवर्ड', 'Create an account': 'खाता बनाएँ', 'Forgot password?': 'पासवर्ड भूल गए?',
  'Create your account': 'अपना खाता बनाएँ', 'Your name': 'आपका नाम', 'Create account': 'खाता बनाएँ', 'I already have an account': 'मेरा खाता पहले से है',
  'Ask for a PIN when the app opens on this device.': 'इस डिवाइस पर ऐप खोलते समय PIN माँगें।',
  'On this device, after no use for a while.': 'इस डिवाइस पर, कुछ देर इस्तेमाल न होने पर।',
  'To sign out everywhere else, change your password.': 'बाकी सभी जगह से साइन आउट करने के लिए पासवर्ड बदलें।',
  'After 15 minutes': '15 मिनट बाद', 'After 1 hour': '1 घंटे बाद', 'After 1 day': '1 दिन बाद', 'Auto': 'अपने आप',
  'Tap a person to see their records. Only admins and co-admins can see this section.': 'किसी व्यक्ति के रिकॉर्ड देखने के लिए उस पर टैप करें। यह हिस्सा केवल एडमिन और को-एडमिन देख सकते हैं।',
  'Due soon': 'जल्द देय', 'Heads up': 'ध्यान दें', 'Save as': 'ऐसे सहेजें',
  'Update': 'अपडेट करें', 'Savings': 'जमा पूँजी', 'Total savings': 'कुल जमा पूँजी', '+ Savings': '+ जमा पूँजी', 'Take out': 'निकालें', 'Add savings': 'जमा पूँजी जोड़ें', 'Move to Savings': 'जमा पूँजी में ले जाएँ',
  'Unlock': 'खोलें', 'Use fingerprint': 'फ़िंगरप्रिंट से खोलें', 'Forgot PIN?': 'PIN भूल गए?',
};

// Sentences with a changing part.
const PATTERNS = [
  [/^Left over in (.+)$/, 'बचत: $1'],
  [/^Family left over in (.+)$/, 'परिवार की बचत: $1'],
  [/^Budgets for (.+)$/, 'बजट: $1'],
  [/^Family budgets for (.+)$/, 'पारिवारिक बजट: $1'],
  [/^Added in (.+)$/, '$1 में जोड़ा गया'],
  [/^Invested in (.+)$/, '$1 में निवेश'],
  [/^Top spending in (.+)$/, '$1 में सबसे ज़्यादा खर्च'],
  [/^Records in (.+)$/, '$1 के रिकॉर्ड'],
  [/^(.+) in short$/, '$1: संक्षेप में'],
];

function tr(text) {
  const t = text.trim();
  if (!t) return text;
  if (HI[t]) return text.replace(t, HI[t]);
  for (const [re, out] of PATTERNS) if (re.test(t)) return text.replace(t, t.replace(re, out));
  return text;
}

export function translate(root = document.body) {
  if (lang() !== 'hi' || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('script, style, input, textarea, [data-no-translate]')) continue;
    const next = tr(n.nodeValue);
    if (next !== n.nodeValue) n.nodeValue = next;
  }
  root.querySelectorAll('[placeholder], [aria-label]').forEach(el => {
    for (const a of ['placeholder', 'aria-label']) if (el.hasAttribute(a)) { const v = tr(el.getAttribute(a)); if (v !== el.getAttribute(a)) el.setAttribute(a, v); }
  });
}
