import type { ServiceDefinition } from './types.ts';

/**
 * Known subscription merchants. Patterns run against the normalised
 * description (see `normalizeDescription`), so keep them lowercase.
 */
export const SERVICE_CATALOG: ServiceDefinition[] = [
  { id: 'apple', name: 'Apple (App Store / iCloud)', category: 'store', aggregator: true,
    patterns: [/\bapple\.com\/bill\b/, /\bapple\b/, /\bitunes\b/, /\bapp store\b/, /\bicloud\b/],
    cancelUrl: 'https://apps.apple.com/account/subscriptions' },
  { id: 'google-play', name: 'Google Play', category: 'store', aggregator: true,
    patterns: [/\bgoogle \*(?!youtube|one|gsuite|workspace|cloud)/, /\bgoogle play\b/, /\bgoogle\s?\*?play\b/],
    cancelUrl: 'https://play.google.com/store/account/subscriptions' },
  { id: 'youtube', name: 'YouTube Premium', category: 'video',
    patterns: [/\byoutube/], cancelUrl: 'https://www.youtube.com/paid_memberships' },
  { id: 'google-one', name: 'Google One', category: 'cloud',
    patterns: [/\bgoogle\s?\*?\s?one\b/], cancelUrl: 'https://one.google.com/settings' },
  { id: 'google-workspace', name: 'Google Workspace', category: 'software',
    patterns: [/\bgoogle\s?\*?\s?(gsuite|workspace)\b/], cancelUrl: 'https://admin.google.com/ac/billing/subscriptions' },
  { id: 'google-cloud', name: 'Google Cloud', category: 'cloud',
    patterns: [/\bgoogle\s?\*?\s?cloud\b/], cancelUrl: 'https://console.cloud.google.com/billing' },
  { id: 'anthropic', name: 'Anthropic (Claude)', category: 'ai',
    patterns: [/\banthropic\b/, /\bclaude\.ai\b/, /\bclaude\b/], cancelUrl: 'https://claude.ai/settings/billing' },
  { id: 'openai', name: 'OpenAI (ChatGPT)', category: 'ai',
    patterns: [/\bopenai\b/, /\bchatgpt\b/], cancelUrl: 'https://chatgpt.com/#settings/Subscription' },
  { id: 'cursor', name: 'Cursor', category: 'ai', patterns: [/\bcursor\b/, /\banysphere\b/],
    cancelUrl: 'https://cursor.com/settings' },
  { id: 'github', name: 'GitHub', category: 'software', patterns: [/\bgithub\b/],
    cancelUrl: 'https://github.com/settings/billing' },
  { id: 'telegram', name: 'Telegram Premium', category: 'social', patterns: [/\btelegram\b/] },
  { id: 'discord', name: 'Discord Nitro', category: 'social', patterns: [/\bdiscord\b/],
    cancelUrl: 'https://discord.com/settings/subscriptions' },
  { id: 'spotify', name: 'Spotify', category: 'music', patterns: [/\bspotify\b/],
    cancelUrl: 'https://www.spotify.com/account/subscription/' },
  { id: 'netflix', name: 'Netflix', category: 'video', patterns: [/\bnetflix\b/],
    cancelUrl: 'https://www.netflix.com/cancelplan' },
  { id: 'megogo', name: 'MEGOGO', category: 'video', patterns: [/\bmegogo\b/],
    cancelUrl: 'https://megogo.net/ua/subscriptions' },
  { id: 'sweettv', name: 'SWEET.TV', category: 'video', patterns: [/\bsweet\.?\s?tv\b/] },
  { id: 'kyivstar-tv', name: 'Київстар ТБ', category: 'video', patterns: [/\bkyivstar\s?tv\b/] },
  { id: 'kyivstar', name: 'Київстар', category: 'telecom', patterns: [/\bkyivstar\b/, /\bкиївстар\b/] },
  { id: 'vodafone-ua', name: 'Vodafone Україна', category: 'telecom', patterns: [/\bvodafone\b/] },
  { id: 'lifecell', name: 'lifecell', category: 'telecom', patterns: [/\blifecell\b/] },
  { id: 'microsoft', name: 'Microsoft 365 / Xbox', category: 'software', patterns: [/\bmicrosoft\b/, /\bmsbill\b/, /\bxbox\b/],
    cancelUrl: 'https://account.microsoft.com/services' },
  { id: 'adobe', name: 'Adobe', category: 'software', patterns: [/\badobe\b/],
    cancelUrl: 'https://account.adobe.com/plans' },
  { id: 'jetbrains', name: 'JetBrains', category: 'software', patterns: [/\bjetbrains\b/],
    cancelUrl: 'https://account.jetbrains.com/licenses' },
  { id: 'notion', name: 'Notion', category: 'software', patterns: [/\bnotion\b/] },
  { id: 'figma', name: 'Figma', category: 'software', patterns: [/\bfigma\b/] },
  { id: 'dropbox', name: 'Dropbox', category: 'cloud', patterns: [/\bdropbox\b/],
    cancelUrl: 'https://www.dropbox.com/account/plan' },
  { id: 'digitalocean', name: 'DigitalOcean', category: 'cloud', patterns: [/\bdigitalocean\b/] },
  { id: 'cloudflare', name: 'Cloudflare', category: 'cloud', patterns: [/\bcloudflare\b/] },
  { id: 'aws', name: 'Amazon Web Services', category: 'cloud', patterns: [/\baws\b/, /\bamazon web services\b/] },
  { id: 'patreon', name: 'Patreon', category: 'other', patterns: [/\bpatreon\b/],
    cancelUrl: 'https://www.patreon.com/settings/memberships' },
  { id: 'duolingo', name: 'Duolingo', category: 'other', patterns: [/\bduolingo\b/] },
  { id: 'playstation', name: 'PlayStation Plus', category: 'gaming', patterns: [/\bplaystation\b/, /\bsony interactive\b/] },
  { id: 'proton', name: 'Proton', category: 'software', patterns: [/\bproton\b/] },
  { id: '1password', name: '1Password', category: 'software', patterns: [/\b1password\b/] },
];

/** MCCs typical for subscriptions: digital goods, streaming, telecom, software. */
export const SUBSCRIPTION_MCCS = new Set([4814, 4815, 4816, 4899, 5815, 5816, 5817, 5818, 5968, 5735, 7372]);

export const normalizeDescription = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Merchant key for grouping unknown merchants: drops reference numbers and noise. */
export const merchantKey = (raw: string) =>
  normalizeDescription(raw)
    .replace(/[#№]\s*\w+/g, '')
    .replace(/\b[a-z0-9]*\d[a-z0-9]{3,}\b/g, '') // ids like 'p1a2b3c4'
    .replace(/\d+/g, '')
    .replace(/[^\p{L}\s.*]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const matchService = (description: string, catalog = SERVICE_CATALOG) => {
  const norm = normalizeDescription(description);
  return catalog.find(s => s.patterns.some(p => p.test(norm))) ?? null;
};

export const serviceById = (id: string | null | undefined, catalog = SERVICE_CATALOG) =>
  id ? catalog.find(s => s.id === id) ?? null : null;

/**
 * Merchant group a debit belongs to: the known service, or the normalised merchant name, plus the charged
 * currency. Empty when the description has nothing usable. Shared by detection and manual subscriptions.
 */
export const groupKeyOf = (t: { description: string; operationCurrency: number }, catalog = SERVICE_CATALOG) => {
  const service = matchService(t.description, catalog);
  const base = service ? `svc:${service.id}` : `m:${merchantKey(t.description)}`;
  return base === 'm:' ? '' : `${base}|${t.operationCurrency}`;
};
