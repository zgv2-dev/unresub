import {
  si1password, siApple, siClaude, siCloudflare, siCursor, siDigitalocean, siDiscord, siDropbox, siDuolingo,
  siFigma, siGithub, siGooglecloud, siGoogleplay, siHetzner, siJetbrains, siNetflix, siNotion, siPatreon,
  siPlaystation, siProton, siSpotify, siTelegram, siVodafone, siYoutube, type SimpleIcon,
} from 'simple-icons';

const BY_ID: Record<string, SimpleIcon> = {
  apple: siApple, 'google-play': siGoogleplay, youtube: siYoutube, 'google-cloud': siGooglecloud,
  anthropic: siClaude, cursor: siCursor, github: siGithub, telegram: siTelegram, discord: siDiscord,
  spotify: siSpotify, netflix: siNetflix, 'vodafone-ua': siVodafone, jetbrains: siJetbrains, notion: siNotion,
  figma: siFigma, dropbox: siDropbox, digitalocean: siDigitalocean, cloudflare: siCloudflare, patreon: siPatreon,
  duolingo: siDuolingo, playstation: siPlaystation, proton: siProton, '1password': si1password,
};

/** Unknown merchants: try the bank description against a few more logos. */
const BY_NAME: [RegExp, SimpleIcon][] = [[/hetzner/i, siHetzner], ...Object.values(BY_ID).map(i => [new RegExp(`\\b${i.title.split(' ')[0]}\\b`, 'i'), i] as [RegExp, SimpleIcon])];

/** Brand colours for catalog services without a Simple Icons logo. */
const BRAND: Record<string, string> = {
  openai: '#10a37f', megogo: '#ff3d00', sweettv: '#ff2e63', 'kyivstar-tv': '#00a3e0', kyivstar: '#00a3e0',
  lifecell: '#ffcc00', microsoft: '#0078d4', adobe: '#fa0f00', aws: '#ff9900', 'google-one': '#4285f4',
  'google-workspace': '#4285f4', anthropic: '#d97757',
};

const PALETTE = ['#5b4cf5', '#0ea5e9', '#14b8a6', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#22c55e'];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const luminance = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

export const ServiceIcon = ({ serviceId, name, size, dot }: { serviceId: string | null; name: string; size?: 'lg'; dot?: string }) => {
  const icon = (serviceId && BY_ID[serviceId]) || BY_NAME.find(([re]) => re.test(name))?.[1];
  const color = icon ? `#${icon.hex}` : (serviceId && BRAND[serviceId]) || PALETTE[Math.abs(hash(name)) % PALETTE.length]!;
  const dark = luminance(color) < 0.16;
  const style = dark ? { background: 'var(--mono-tile)', color: 'var(--mono-glyph)' } : { background: color, color: luminance(color) > 0.7 ? '#111' : '#fff' };
  const letter = name.replace(/^[^\p{L}\p{N}]+/u, '').charAt(0).toUpperCase() || '?';
  return (
    <span className={`svc ${size ?? ''}`} style={style} aria-hidden>
      {icon ? (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d={icon.path} /></svg>
      ) : (
        letter
      )}
      {dot && <span className="badge-dot" style={{ background: dot }} />}
    </span>
  );
};
