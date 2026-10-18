// Merchant normalization + built-in keyword map + personal rules.
const { anyOf } = require('./regex');
const RULES = [
  [
    'Paycheck',
    'income',
    anyOf(
      'i',
      /payroll/,
      /direct ?dep/,
      /dir dep/,
      /salary/,
      /paycheck/,
      /adp/,
      /gusto/,
      /paychex/,
      /employer/,
      /percepta/,
      /ach credit.*(pay|wage)/,
    ),
  ],
  [
    'Side hustle',
    'income',
    anyOf(
      'i',
      /venmo.*(from|cashout)/,
      /zelle (from|received)/,
      /cash app.*received/,
      /received from/,
      /doordash.*(dasher|pay)/,
      /uber.*(earnings|driver)/,
      /etsy/,
      /ebay.*payout/,
      /stripe transfer/,
      /payout/,
    ),
  ],
  [
    'Rent',
    'expense',
    anyOf(
      'i',
      /\brent\b/,
      /apartment/,
      /property mgmt/,
      /property management/,
      /leasing/,
      /landlord/,
      /rooming/,
      /cozy\.co/,
      /realpage/,
      /appfolio/,
    ),
  ],
  [
    'Subscriptions',
    'expense',
    anyOf(
      'i',
      /netflix/,
      /spotify/,
      /hulu/,
      /disney ?\+/,
      /disneyplus/,
      /youtube ?(premium|tv)/,
      /google \*youtube/,
      /game ?pass/,
      /xbox live/,
      /playstation plus/,
      /ps plus/,
      /nintendo online/,
      /max\.com/,
      /hbo ?max/,
      /paramount/,
      /peacock/,
      /apple\.com\/bill/,
      /icloud/,
      /audible/,
      /crunchyroll/,
      /twitch/,
      /patreon/,
      /discord.*nitro/,
      /nitro/,
      /chatgpt/,
      /openai/,
      /supergrok/,
      /x\.ai/,
      /adobe/,
      /microsoft 365/,
      /amazon prime/,
      /prime video/,
      /siriusxm/,
      /suno/,
    ),
  ],
  [
    'Games',
    'expense',
    anyOf(
      'i',
      /steam/,
      /valve/,
      /playstation/,
      /sony interactive/,
      /xbox/,
      /microsoft \*store/,
      /nintendo/,
      /blizzard/,
      /battle\.net/,
      /epic games/,
      /riot games/,
      /ea \*/,
      /electronic arts/,
      /ubisoft/,
      /humble/,
      /gog\.com/,
      /roblox/,
      /gamestop/,
      /itch\.io/,
    ),
  ],
  [
    'Food',
    'expense',
    anyOf(
      'i',
      /taco bell/,
      /mcdonald/,
      /burger king/,
      /wendy/,
      /whataburger/,
      /chick-?fil/,
      /popeyes/,
      /kfc/,
      /sonic drive/,
      /jack in the box/,
      /subway/,
      /chipotle/,
      /panda express/,
      /domino/,
      /pizza/,
      /papa john/,
      /little caesar/,
      /starbucks/,
      /dunkin/,
      /doordash/,
      /uber ?eats/,
      /grubhub/,
      /postmates/,
      /instacart/,
      /kroger/,
      /heb\b/,
      /h-e-b/,
      /aldi/,
      /safeway/,
      /whole foods/,
      /trader joe/,
      /publix/,
      /sprouts/,
      /restaurant/,
      /cafe/,
      /grill/,
      /bbq/,
      /diner/,
      /wingstop/,
      /raising cane/,
      /five guys/,
      /in-n-out/,
      /shake shack/,
      /taqueria/,
      /dairy queen/,
      /ihop/,
      /denny/,
      /waffle house/,
      /sushi/,
      /ramen/,
      /bakery/,
      /kolache/,
      /7-eleven/,
      /7 eleven/,
      /circle k/,
    ),
  ],
  [
    'Gas',
    'expense',
    anyOf(
      'i',
      /shell/,
      /exxon/,
      /chevron/,
      /valero/,
      /buc-?ee/,
      /texaco/,
      /mobil\b/,
      /citgo/,
      /conoco/,
      /phillips 66/,
      /76 station/,
      /marathon petro/,
      /sunoco/,
      /bp\b/,
      /speedway/,
      /racetrac/,
      /quiktrip/,
      /qt \d/,
      /murphy usa/,
      /wawa/,
      /sheetz/,
      /fuel/,
      /gas station/,
      /loves travel/,
      /pilot travel/,
      /flying j/,
    ),
  ],
  [
    'Bills',
    'expense',
    anyOf(
      'i',
      /electric/,
      /energy/,
      /reliant/,
      /txu/,
      /centerpoint/,
      /power/,
      /water util/,
      /utility/,
      /city of/,
      /comcast/,
      /xfinity/,
      /spectrum/,
      /at&t/,
      /att\*/,
      /verizon/,
      /t-mobile/,
      /tmobile/,
      /mint mobile/,
      /cricket/,
      /metro ?pcs/,
      /boost mobile/,
      /internet/,
      /geico/,
      /progressive/,
      /state farm/,
      /allstate/,
      /insurance/,
      /loan/,
      /capital one.*pmt/,
      /credit card (pmt|payment)/,
      /autopay/,
      /car payment/,
      /toyota financial/,
      /honda financial/,
      /ally auto/,
      /navient/,
      /nelnet/,
      /sallie mae/,
    ),
  ],
  [
    'Shopping',
    'expense',
    anyOf(
      'i',
      /walmart/,
      /wal-mart/,
      /target/,
      /amazon/,
      /amzn/,
      /costco/,
      /sam'?s club/,
      /best buy/,
      /home depot/,
      /lowe'?s/,
      /ikea/,
      /ebay/,
      /etsy/,
      /shein/,
      /temu/,
      /old navy/,
      /ross/,
      /tj ?maxx/,
      /marshalls/,
      /kohl/,
      /macy/,
      /nike/,
      /adidas/,
      /foot locker/,
      /dollar (tree|general)/,
      /family dollar/,
      /cvs/,
      /walgreens/,
      /apple store/,
      /ulta/,
      /sephora/,
    ),
  ],
  [
    'Fun',
    'expense',
    anyOf(
      'i',
      /cinema/,
      /theater/,
      /theatre/,
      /amc /,
      /regal/,
      /cinemark/,
      /bowling/,
      /topgolf/,
      /dave ?& ?buster/,
      /concert/,
      /ticketmaster/,
      /stubhub/,
      /eventbrite/,
      /bar\b/,
      /pub\b/,
      /brewery/,
      /lounge/,
      /club\b/,
      /arcade/,
      /six flags/,
      /museum/,
      /zoo/,
      /casino/,
    ),
  ],
];
const NOISE =
  /^(pos|debit card|dbt crd|debit|purchase|recurring|chkcard|checkcard|card|visa|ach|electronic|withdrawal|payment to|payment|online|pmt|web|ppd|pre-?auth|sq|tst|sp|pp|paypal|ppl|google|apple pay|cash app|venmo|zelle|aplpay)\b[\s*#:-]*/i;
function merchantOf(desc) {
  let s = String(desc || '')
    .split(' · ')[0]
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '');
  for (let i = 0; i < 4; i++) {
    s = s.replace(NOISE, '').replace(/^[\s*#:-]+/, '');
  }
  s = s
    .replace(
      /\b(purchase|authorized|on \d{1,2}\/\d{1,2}|card \d+|x{2,}\d+|\d{1,2}\/\d{1,2})\b/g,
      ' ',
    )
    .replace(/[#*]\s*\w*\d\w*/g, ' ')
    .replace(/\b\d[\d-]{2,}\b/g, ' ')
    .replace(/\b(tx|ca|ny|fl|houston|austin|dallas|san antonio|us|usa|inc|llc|co|com)\b\.?/g, ' ')
    .replace(/[^a-z0-9&'+ .-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let toks = s
    .split(' ')
    .map(x => x.replace(/^[.'-]+|[.'-]+$/g, ''))
    .filter(x => x && !/^\d+$/.test(x));
  const ST =
    /^(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)$/;
  while (toks.length > 1 && ST.test(toks[toks.length - 1])) {
    toks.pop();
  }
  toks = toks.slice(0, 3);
  if (toks.length === 3 && /^(san|los|las|new|fort|el|st)$/.test(toks[2])) {
    toks.pop();
  }
  const w = toks.join(' ');
  return (
    w ||
    String(desc || '')
      .slice(0, 20)
      .toLowerCase()
  );
}
const titleCase = s => s.replace(/\b[a-z]/g, c => c.toUpperCase());
function categorize(desc, amount, userRules = []) {
  const merchant = merchantOf(desc);
  const type = amount >= 0 ? 'income' : 'expense';
  const hay = (desc + ' ' + merchant).toLowerCase();
  for (const r of userRules) {
    if (
      r.type === type &&
      (merchant === r.merchant || merchant.startsWith(r.merchant + ' ') || hay.includes(r.merchant))
    ) {
      return { type, category: r.category, merchant, by: 'rule' };
    }
  }
  for (const [cat, t, re] of RULES) {
    if (t === type && re.test(hay)) {
      return { type, category: cat, merchant, by: 'auto' };
    }
  }
  return { type, category: type === 'income' ? 'Other income' : 'Other', merchant, by: 'none' };
}
module.exports = { categorize, merchantOf, titleCase };
