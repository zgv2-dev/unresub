/** Human-readable spending categories for ISO 18245 merchant category codes (MCC). */
export type MccCategoryId =
  | 'groceries' | 'restaurants' | 'transport' | 'fuel' | 'travel' | 'digital' | 'telecom' | 'utilities'
  | 'health' | 'beauty' | 'shopping' | 'entertainment' | 'cash' | 'transfers' | 'government' | 'services'
  | 'education' | 'charity' | 'other';

export interface MccCategory {
  id: MccCategoryId;
  label: string;
}

const LABELS: Record<MccCategoryId, string> = {
  groceries: 'Groceries',
  restaurants: 'Cafés and restaurants',
  transport: 'Transport',
  fuel: 'Fuel',
  travel: 'Travel',
  digital: 'Digital goods and subscriptions',
  telecom: 'Mobile and internet',
  utilities: 'Utilities',
  health: 'Health and pharmacy',
  beauty: 'Beauty',
  shopping: 'Shopping',
  entertainment: 'Entertainment',
  cash: 'Cash',
  transfers: 'Transfers and finance',
  government: 'Taxes and government',
  services: 'Services',
  education: 'Education',
  charity: 'Charity',
  other: 'Other',
};

/** Exact codes first: they win over the ranges below. */
const EXACT: [MccCategoryId, number[]][] = [
  ['groceries', [5297, 5298, 5300, 5311, 5331, 5399, 5411, 5422, 5441, 5451, 5462, 5499, 5715, 5921]],
  ['restaurants', [5811, 5812, 5813, 5814]],
  ['fuel', [5172, 5541, 5542, 5552, 5983, 9752]],
  ['transport', [4011, 4111, 4112, 4119, 4121, 4131, 4214, 4215, 4457, 4468, 4784, 4789, 5013, 5511, 5521, 5531, 5532, 5533, 5571, 5592, 5598, 5599, 7511, 7523, 7531, 7534, 7535, 7538, 7542, 7549]],
  ['travel', [4411, 4511, 4582, 4722, 4723, 7011, 7012, 7032, 7033, 7512, 7513, 7519]],
  ['digital', [4816, 4899, 5815, 5816, 5817, 5818, 5734, 5735, 7372, 7374, 7375, 7379]],
  ['telecom', [4812, 4813, 4814, 4815, 4821]],
  ['utilities', [4900]],
  ['health', [4119, 5047, 5122, 5912, 5975, 5976, 8011, 8021, 8031, 8041, 8042, 8043, 8044, 8049, 8050, 8062, 8071, 8099]],
  ['beauty', [5977, 7230, 7297, 7298]],
  ['entertainment', [5733, 5945, 7829, 7832, 7841, 7922, 7929, 7932, 7933, 7941, 7991, 7992, 7993, 7994, 7995, 7996, 7997, 7998, 7999]],
  ['cash', [6010, 6011]],
  ['transfers', [4829, 6012, 6050, 6051, 6211, 6300, 6381, 6399, 6513, 6529, 6530, 6532, 6533, 6534, 6535, 6536, 6537, 6538, 6540]],
  ['education', [5111, 5192, 5942, 5943, 8211, 8220, 8241, 8244, 8249, 8299]],
  ['charity', [8398, 8661]],
];

const RANGES: [MccCategoryId, number, number][] = [
  ['travel', 3000, 3999], // airlines, car rental, hotels by brand
  ['government', 9000, 9999],
  ['shopping', 5000, 5999],
  ['services', 7000, 8999],
  ['transport', 4000, 4799],
];

const byCode = new Map(EXACT.flatMap(([id, codes]) => codes.map(c => [c, id] as const)));

export const mccCategory = (mcc: number | null | undefined): MccCategory => {
  const id: MccCategoryId =
    mcc == null ? 'other' : byCode.get(mcc) ?? RANGES.find(([, min, max]) => mcc >= min && mcc <= max)?.[0] ?? 'other';
  return { id, label: LABELS[id] };
};
